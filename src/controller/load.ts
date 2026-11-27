// The load test from the controller. load start: the box's own settings say the test repo, which
// must be the one box add was told; the merge pattern's settings must be as it needs, which the owner
// sets; the owner signs the session open; the test repo's load workflow is made true there from this
// release's template and the box's values, after a typed yes; then the run
// is dispatched through the owner's own GitHub session, and watched until the session ends, when what
// is still queued is cancelled. load stop: the owner signs the end, and the session's queued runs
// and throwaway pull requests are cancelled and closed. No App on the box acts on GitHub.
import { existsSync } from "node:fs";
import { EXIT } from "../command.ts";
import { type Gh, printable, REPO_NAME } from "../hold.ts";
import { checkLoadValues, LOAD_WORKFLOW, loadYamlFrom, type LoadValues } from "../loadcmd.ts";
import { answers, forward, type ForwardIo, readLine } from "./forward.ts";
import { readConfig } from "./home.ts";
import { type Deps, isStop, type Stop } from "./reach.ts";

// The ruleset the merge pattern needs in the test repo, by name, so taskbox knows its own.
export const RULESET = "taskbox load merge queue";
// The required check the template's merge_group gate reports, and the throwaway pull requests' status.
export const CHECK = "taskbox-load";
export const WATCH_EVERY_MS = 30_000;
const LIVE = new Set(["queued", "in_progress", "waiting", "requested", "pending"]);

type Answer = { ok: true; v: unknown } | { ok: false; why: string; status?: number };
async function api(gh: Gh, args: string[], body?: unknown): Promise<Answer> {
  const r = await gh(["api", ...args, ...(body !== undefined ? ["--input", "-"] : [])], body !== undefined ? JSON.stringify(body) : undefined);
  if (r.code !== 0) return { ok: false, why: printable(r.stderr, 160) || `gh exit ${r.code}`, ...(/HTTP (\d{3})/.test(r.stderr) ? { status: Number(/HTTP (\d{3})/.exec(r.stderr)![1]) } : {}) };
  try {
    return { ok: true, v: r.stdout.trim() ? JSON.parse(r.stdout) : {} };
  } catch {
    return { ok: false, why: "GitHub's answer couldn't be read" };
  }
}
const field = (a: Answer, k: string): unknown => (a.ok && a.v && typeof a.v === "object" ? (a.v as Record<string, unknown>)[k] : undefined);

export type LoadIo = ForwardIo;
export interface LoadDeps extends Deps {
  gh?: Gh; // the owner's own gh, signed in; absent when it isn't on this Mac
}

// The owner's gh, where Homebrew puts it, run with the controller's fixed environment and the
// owner's home, so its own stored sign-in is used. Bodies go on stdin.
export const GH_AT = ["/opt/homebrew/bin/gh", "/usr/local/bin/gh"];
export function ownerGh(d: Deps): Gh | undefined {
  const at = GH_AT.find((p) => (d.exists ?? existsSync)(p));
  if (!at) return undefined;
  return async (args, stdin) => {
    // The runner's environment is fixed; HOME is given to gh alone, by env.
    const r = await d.run(["/usr/bin/env", `HOME=${d.userHome}`, at, ...args], { limitMs: 60_000, maxBytes: 4_000_000, ...(stdin !== undefined ? { stdin: new TextEncoder().encode(stdin) } : {}) });
    return { code: r.code ?? 1, stdout: r.stdout, stderr: r.stderr };
  };
}

// One box read: the last envelope's result, from the box named (or the default).
async function boxResult(d: Deps, argv: string[]): Promise<Record<string, unknown> | Stop> {
  const a = readLine(d, argv);
  if ("shown" in a) return { stop: a.shown.lines.join(" ").slice(0, 200) || "That can't be asked.", next: "Type taskbox help." };
  const list = await answers(d, a);
  if (isStop(list)) return list;
  const one = list[0]!;
  if (one.stop) return one.stop;
  const e = one.envelopes?.at(-1);
  if (!e || !e.result) return { stop: `${one.box.name} gave no answer taskbox reads to taskbox ${argv.slice(0, 2).join(" ")}.`, next: "Update taskbox on the box and this controller." };
  if (!e.ok) return { stop: e.lines.at(-1) ?? "The box refused.", next: e.error?.fix ?? "Type taskbox check at the box." };
  return e.result;
}

const sel = (box?: string) => (box ? ["--box", box] : []);

// The test repo box add was told for the box chosen (by name, or the default, or the only one).
function pairedLoadRepo(d: Deps, name?: string): string | undefined {
  const c = readConfig(d.home);
  if (!c.ok) return undefined;
  const want = name ?? c.config.default ?? (c.config.boxes.length === 1 ? c.config.boxes[0]!.name : undefined);
  return c.config.boxes.find((b) => b.name.toLowerCase() === want?.toLowerCase())?.loadRepo;
}

// A session as the box's load status gives it.
interface Seen {
  n: number;
  pattern: string | null;
  startedAt: number;
  until: number;
  endedAt: number | null;
}
const sessionIn = (v: unknown): Seen | undefined => {
  if (!v || typeof v !== "object") return undefined;
  const s = v as Record<string, unknown>;
  return Number.isInteger(s.n) && typeof s.startedAt === "number" && typeof s.until === "number" ? { n: s.n as number, pattern: typeof s.pattern === "string" ? s.pattern : null, startedAt: s.startedAt, until: s.until, endedAt: typeof s.endedAt === "number" ? s.endedAt : null } : undefined;
};

// The test repo's default branch, or why not.
async function defaultBranch(gh: Gh, repo: string): Promise<string | Stop> {
  const b = field(await api(gh, [`repos/${repo}`]), "default_branch");
  return typeof b === "string" && /^[A-Za-z0-9._/-]{1,100}$/.test(b) ? b : { stop: `${repo}'s default branch couldn't be read through your GitHub session.`, next: "Type gh auth status: gh must be signed in as someone who can write to the test repo." };
}

// What load start needs in the test repo. The workflow file is content: taskbox writes it through
// the owner's session, after a typed yes. The repo's settings are the owner's own: taskbox only reads
// them, and says what to set when one isn't as the merge pattern needs (its Actions token may open
// pull requests; a merge queue asks for the taskbox-load check). taskbox never changes a setting.
export interface Change {
  what: string;
  apply(): Promise<string | undefined>; // undefined, or why it failed
}
export interface RepoNeeds {
  writes: Change[];
  settings: string[]; // each a setting for the owner to make in the repo's own settings
}
export async function repoChanges(gh: Gh, repo: string, base: string, v: LoadValues, merge: boolean): Promise<RepoNeeds | Stop> {
  const writes: Change[] = [];
  const settings: string[] = [];
  const want = loadYamlFrom(v);
  const got = await api(gh, [`repos/${repo}/contents/${LOAD_WORKFLOW}?ref=${encodeURIComponent(base)}`]);
  if (!got.ok && got.status !== 404) return { stop: `GitHub answered for ${repo}'s ${LOAD_WORKFLOW}: ${got.why}.`, next: "Type gh auth status." };
  const have = got.ok && typeof field(got, "content") === "string" ? Buffer.from(String(field(got, "content")), "base64").toString("utf8") : undefined;
  const sha = got.ok ? field(got, "sha") : undefined;
  if (have !== want)
    writes.push({
      what: `${have === undefined ? "write" : "bring up to date"} ${LOAD_WORKFLOW} in ${repo}, made from this box's settings`,
      apply: async () => {
        const r = await api(gh, ["-X", "PUT", `repos/${repo}/contents/${LOAD_WORKFLOW}`], { message: "taskbox: the load test's workflow", content: Buffer.from(want).toString("base64"), branch: base, ...(typeof sha === "string" ? { sha } : {}) });
        return r.ok ? undefined : r.why;
      },
    });
  if (!merge) return { writes, settings };
  const perm = await api(gh, [`repos/${repo}/actions/permissions/workflow`]);
  if (!perm.ok) return { stop: `GitHub answered for ${repo}'s Actions settings: ${perm.why}.`, next: "Type gh auth status." };
  if (field(perm, "can_approve_pull_request_reviews") !== true) settings.push(`In ${repo}'s settings, Actions, General: allow GitHub Actions to create pull requests, for the throwaway ones. Turn it on only while no account but yours and the box's App can push to ${repo}.`);
  const sets = await api(gh, [`repos/${repo}/rulesets?per_page=100`]);
  if (!sets.ok) return { stop: `GitHub answered for ${repo}'s rulesets: ${sets.why}.`, next: "Type gh auth status." };
  const names = Array.isArray(sets.v) ? sets.v.map((x) => (x as { name?: unknown }).name) : [];
  if (!names.includes(RULESET)) settings.push(`In ${repo}'s settings, Rules: a branch ruleset named "${RULESET}" on ${base}, with a merge queue and the required check ${CHECK}.`);
  return { writes, settings };
}

// The session's runs still waiting or running, cancelled; and the merge pattern's throwaway pull
// requests closed and their branches deleted. Counts of each, and what failed.
export async function cancelSession(gh: Gh, repo: string, s: Seen): Promise<{ runs: number; prs: number; failed: string[] }> {
  const failed: string[] = [];
  let runs = 0;
  let prs = 0;
  const since = new Date(s.startedAt - 60_000).toISOString().slice(0, 19);
  const list = await api(gh, [`repos/${repo}/actions/workflows/load.yml/runs?per_page=100&created=%3E%3D${since}Z`]);
  const all = list.ok ? ((field(list, "workflow_runs") as unknown[] | undefined) ?? []) : [];
  if (!list.ok) failed.push(`the runs couldn't be listed: ${list.why}`);
  for (const r of all) {
    const run = r as { id?: unknown; status?: unknown; event?: unknown; display_title?: unknown };
    if (!Number.isSafeInteger(run.id) || !LIVE.has(String(run.status))) continue;
    // This session's own dispatches, and the merge queue's runs, which name no session.
    const mine = String(run.display_title ?? "").includes(` session ${s.n} `) || run.event === "merge_group";
    if (!mine) continue;
    const c = await api(gh, ["-X", "POST", `repos/${repo}/actions/runs/${run.id}/cancel`]);
    if (c.ok || c.status === 409) runs++;
    else failed.push(`run ${run.id}: ${c.why}`);
  }
  if (s.pattern === "merge") {
    const open = await api(gh, [`repos/${repo}/pulls?state=open&per_page=100`]);
    for (const p of open.ok && Array.isArray(open.v) ? open.v : []) {
      const pr = p as { number?: unknown; head?: { ref?: unknown } };
      const ref = String(pr.head?.ref ?? "");
      if (!Number.isSafeInteger(pr.number) || !new RegExp(`^taskbox-load/s${s.n}-[0-9]+-[0-9]+$`).test(ref)) continue;
      const c = await api(gh, ["-X", "PATCH", `repos/${repo}/pulls/${pr.number}`], { state: "closed" });
      if (!c.ok) {
        failed.push(`pull request ${pr.number}: ${c.why}`);
        continue;
      }
      prs++;
      await api(gh, ["-X", "DELETE", `repos/${repo}/git/refs/heads/${ref}`]);
    }
  }
  return { runs, prs, failed };
}

const say = (io: LoadIo, lines: string[]) => {
  for (const l of lines) io.out(l);
};
const stopped = (io: LoadIo, s: Stop, code: number = EXIT.failed) => (say(io, [s.stop, `Next: ${s.next}`]), code);
const noGh: Stop = { stop: "The load test starts and stops its runs through your own GitHub session, and gh isn't on this Mac.", next: "Install gh with Homebrew and sign in once: gh auth login." };

// taskbox load start on the controller.
export async function loadStart(d: LoadDeps, argv: string[], io: LoadIo): Promise<number> {
  const a = readLine(d, argv);
  if ("shown" in a) return say(io, a.shown.lines), a.shown.exit;
  if (!d.gh) return stopped(io, noGh);
  const gh = d.gh;
  const pattern = String(a.parsed.opts.pattern);
  const yes = a.parsed.flags.yes !== undefined;
  const st = await boxResult(d, ["load", "status", ...sel(a.sel)]);
  if (isStop(st)) return stopped(io, st);
  const repo = typeof st.repo === "string" && REPO_NAME.test(st.repo) ? st.repo : undefined;
  if (!repo) return stopped(io, { stop: "The box's settings name no test repo, so there is no load test.", next: "Add one with taskbox connect github --load." });
  // The test repo is the one box add was told, never only the box's word.
  const pinned = pairedLoadRepo(d, a.sel);
  if (!pinned) return stopped(io, { stop: `This controller has no test repo for that box, so load start writes nowhere.`, next: `Type taskbox box add ${a.sel ?? "NAME"} --load-repo ${repo} if ${repo} is your test repo.` });
  if (pinned.toLowerCase() !== repo.toLowerCase()) return stopped(io, { stop: `The box names ${repo} as its test repo, and box add was told ${pinned}, so nothing is changed.`, next: "Check the box at its screen before anything else." });
  const on = sessionIn(st.session);
  if (on) return stopped(io, { stop: `Load test session ${on.n} is on already.`, next: "taskbox load stop ends it." });
  const tv = await boxResult(d, ["template", "show", "load", ...sel(a.sel)]);
  if (isStop(tv)) return stopped(io, tv);
  const values = checkLoadValues(tv.values);
  if (typeof values === "string") return stopped(io, { stop: `The box's load workflow values can't be used: ${values}.`, next: "Update taskbox on the box and this controller." });
  if (pattern === "burst" && !values.linux) return stopped(io, { stop: "burst runs Linux jobs, and this box has no Linux VMs.", next: "Type taskbox load start --pattern day or merge." }, EXIT.usage);
  const confirm = async (q: string): Promise<boolean> => {
    if (yes) return true;
    if (!d.tty) {
      io.out(`${q} There is no terminal here to type yes: add --yes.`);
      return false;
    }
    return (await d.ask(`${q} Type yes to go on: `)).trim().toLowerCase() === "yes";
  };
  // --only: real jobs wait while it runs; a typed yes when they wait now, or when the box can't say.
  if (a.parsed.opts.only === true) {
    const real = typeof st.realWaiting === "number" ? st.realWaiting : undefined;
    if (real !== 0) {
      const what = real === undefined ? "The box can't say whether real jobs wait now." : `${real} real job${real === 1 ? " waits" : "s wait"} on GitHub now${typeof st.realMergeWaiting === "number" && st.realMergeWaiting ? `, ${st.realMergeWaiting} of them merge queue jobs` : ""}.`;
      if (!(await confirm(`${what} With --only they wait until the session ends, and a merge queue drops a pull request whose checks wait past its timeout.`))) return say(io, ["Not started. The real repo carries on."]), EXIT.failed;
    }
  }
  const base = await defaultBranch(gh, repo);
  if (isStop(base)) return stopped(io, base);
  const needs = await repoChanges(gh, repo, base, values, pattern === "merge");
  if (isStop(needs)) return stopped(io, needs);
  // Settings are the owner's to make: nothing starts until they are as the pattern needs.
  if (needs.settings.length) return say(io, [`The ${pattern} pattern needs settings in ${repo} that taskbox doesn't change:`, ...needs.settings.map((l) => `  ${l}`), "Not started. Nothing changed. Type taskbox load start again once they are set."]), EXIT.failed;
  // A write to the repo asks for a typed yes every time, which --yes doesn't answer.
  if (needs.writes.length && !d.tty) return stopped(io, { stop: `load start writes to ${repo} first, which asks you to type yes, and there is no terminal here.`, next: "Type taskbox load start in Terminal." });
  // The owner's signature opens the session on the box, before anything in the repo changes.
  const opened = await forward(d, argv, io);
  if (opened !== 0) return opened;
  const now = await boxResult(d, ["load", "status", ...sel(a.sel)]);
  const s = isStop(now) ? undefined : sessionIn(now.session);
  if (!s) return stopped(io, isStop(now) ? now : { stop: "The box opened no session.", next: "Type taskbox load status." });
  if (needs.writes.length) {
    say(io, [`Session ${s.n} is on. taskbox now changes ${repo} through your GitHub session:`, ...needs.writes.map((c) => `  ${c.what}`)]);
    if ((await d.ask("Nothing else in the repo changes. Type yes to go on: ")).trim().toLowerCase() !== "yes") return stopped(io, { stop: `Nothing in ${repo} changed, and session ${s.n} is on with no test runs.`, next: "taskbox load stop ends it." });
    for (const c of needs.writes) {
      const why = await c.apply();
      if (why) return stopped(io, { stop: `Couldn't ${c.what}: ${why}. Session ${s.n} is on with no test runs.`, next: "Type gh auth status, then taskbox load stop." });
    }
  }
  const run = await api(gh, ["-X", "POST", `repos/${repo}/actions/workflows/load.yml/dispatches`], { ref: base, inputs: { pattern, session: String(s.n) } });
  if (!run.ok) {
    io.out(`GitHub didn't start the load workflow in ${repo}: ${run.why}.`);
    return stopped(io, { stop: `Session ${s.n} is on, with no test runs.`, next: "taskbox load stop ends it." });
  }
  io.out(`Started the load workflow in ${repo}: ${pattern}, for session ${s.n}.`);
  if (a.parsed.flags.detach !== undefined) {
    say(io, [`Session ${s.n} runs until ${new Date(s.until).toISOString().slice(11, 16)} UTC. taskbox load status -w watches it; taskbox load stop ends it and cancels what is queued.`]);
    return EXIT.ok;
  }
  return watchToEnd(d, gh, repo, s, a.sel, io);
}

// Watches the session on the box until it ends, then cancels what is still queued.
async function watchToEnd(d: LoadDeps, gh: Gh, repo: string, s: Seen, box: string | undefined, io: LoadIo): Promise<number> {
  for (let i = 0; i < (io.rounds ?? Infinity); i++) {
    if (i > 0) await d.sleep(WATCH_EVERY_MS);
    const a = readLine(d, ["load", "status", ...sel(box)]);
    if ("shown" in a) break;
    const list = await answers(d, a);
    const e = isStop(list) ? undefined : list[0]?.envelopes?.at(-1);
    const cur = e?.result ? sessionIn((e.result as Record<string, unknown>).session) : undefined;
    if (e && (!cur || cur.n !== s.n)) {
      const c = await cancelSession(gh, repo, s);
      say(io, [`Session ${s.n} ended.`, ...cancelLines(repo, c), `taskbox load report --session ${s.n} shows it.`]);
      return EXIT.ok;
    }
    io.draw([...(e?.lines ?? ["The box can't be reached now; the session carries on there."]), "", `Ctrl-C stops watching; the session carries on. taskbox load stop ends it.`]);
  }
  return EXIT.ok;
}

const cancelLines = (repo: string, c: { runs: number; prs: number; failed: string[] }) => [
  `Cancelled ${c.runs} test run${c.runs === 1 ? "" : "s"} still queued or running in ${repo}${c.prs ? `, and closed ${c.prs} throwaway pull request${c.prs === 1 ? "" : "s"}` : ""}.`,
  ...c.failed.slice(0, 5).map((f) => `Not cancelled: ${f}.`),
];

// taskbox load stop on the controller.
export async function loadStop(d: LoadDeps, argv: string[], io: LoadIo): Promise<number> {
  const a = readLine(d, argv);
  if ("shown" in a) return say(io, a.shown.lines), a.shown.exit;
  const before = await boxResult(d, ["load", "status", ...sel(a.sel)]);
  if (isStop(before)) return stopped(io, before);
  const s = sessionIn(before.session) ?? sessionIn(before.last);
  const code = await forward(d, argv, io);
  if (code !== 0) return code;
  const repo = typeof before.repo === "string" && REPO_NAME.test(before.repo) ? before.repo : undefined;
  if (!s || !repo) return EXIT.ok;
  if (!d.gh) return stopped(io, { ...noGh, stop: `${noGh.stop} The session's queued test runs stay queued until they are cancelled on GitHub.` });
  say(io, cancelLines(repo, await cancelSession(d.gh, repo, s)));
  return EXIT.ok;
}
