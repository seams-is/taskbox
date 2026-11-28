// The settings repo's rows: "Settings" (the commit in force, a commit refused, one waiting, keys this
// release doesn't know), "Box overlay" (this box's boxes/<name>.json set aside or passed over in
// part), and "Settings repo rules" (whether the default branch takes direct pushes).
import { type Asker, askerFor, brokerHere } from "../broker.ts";
import type { Check, CheckContext } from "../checks.ts";
import type { Row, RowFn } from "../core/rows.ts";
import { rootStateOf } from "../core/paths.ts";
import { brokerPathsOf } from "../keys.ts";
import { readInForce, readState, type SettingsFiles, settingsFiles } from "../settings/inforce.ts";

type Out = Omit<Check, "name">;
export const STALE_READ_MS = 3 * 60 * 60_000;
const filesOf = (c: CheckContext): SettingsFiles => settingsFiles(rootStateOf(c.paths).dir);
const short = (sha: string) => sha.slice(0, 12);
// Whether this box reads a settings repo at all: the guard has written its state.
export const readsRepo = (c: CheckContext) => !!c?.paths && (readState(filesOf(c), c.rootUid ?? 0).kind !== "missing" || readInForce(filesOf(c), c.rootUid ?? 0).kind !== "missing");

export async function settingsRow(c: CheckContext): Promise<Out> {
  const f = filesOf(c);
  const root = c.rootUid ?? 0;
  const st = readState(f, root);
  const inf = readInForce(f, root);
  if (st.kind === "bad") return { status: "FAIL", detail: `the settings op's state can't be read (${st.why}). As your admin user, type taskbox update` };
  if (inf.kind === "bad") return { status: "FAIL", detail: `the settings in force can't be read (${inf.why}). As your admin user, type taskbox update` };
  const s = st.kind === "ok" ? st.value : { v: 1 as const };
  const now = inf.kind === "ok" ? `commit ${short(inf.value.sha)}${s.repo ? ` of ${s.repo}` : ""} is in force` : "no settings commit is in force yet";
  if (s.problem?.sha) return { status: "FAIL", detail: `settings commit ${short(s.problem.sha)} isn't used: ${s.problem.why}. ${now[0]!.toUpperCase()}${now.slice(1)}. A settings PR puts it right` };
  if (s.problem) return { status: "FAIL", detail: `${s.problem.why}. ${now[0]!.toUpperCase()}${now.slice(1)}` };
  if (s.waiting) {
    const n = s.waiting.changes.length;
    const next = s.waiting.phase === "needs-confirm" ? "taskbox confirm at the box" : `from the controller, taskbox settings apply ${s.waiting.sha}`;
    return { status: "WARN", detail: `settings commit ${short(s.waiting.sha)} waits with ${n} guarded change${n === 1 ? "" : "s"} (${s.waiting.changes.map((x) => x.path).join(", ")}): ${next}`.slice(0, 300) };
  }
  if (inf.kind !== "ok") return { status: "SKIP", detail: "no settings commit has been read yet" };
  if (s.head && c.sys.now() - s.head.readAt > STALE_READ_MS) return { status: "WARN", detail: `${now}, but the settings repo hasn't been read for ${Math.floor((c.sys.now() - s.head.readAt) / 3_600_000)} hours. taskbox logs --from guard says why` };
  if (inf.value.unknown.length) return { status: "WARN", detail: `${now}. It names keys this release doesn't know, passed over: ${inf.value.unknown.join(", ")}`.slice(0, 300) };
  return { status: "OK", detail: now };
}

export async function overlayRow(c: CheckContext): Promise<Out> {
  const inf = readInForce(filesOf(c), c.rootUid ?? 0);
  if (inf.kind !== "ok") return { status: "SKIP", detail: "no settings commit is in force yet" };
  const v = inf.value;
  const passed = v.overlayIgnored.length ? `passed over, since a box's overlay may hold only box keys: ${v.overlayIgnored.join(", ")}` : undefined;
  if (v.overlayProblem) return { status: "FAIL", detail: `this box's overlay is set aside, and the product settings are used: ${v.overlayProblem}${passed ? `. ${passed[0]!.toUpperCase()}${passed.slice(1)}` : ""}`.slice(0, 300) };
  if (passed) return { status: "WARN", detail: passed.slice(0, 300) };
  return { status: "OK", detail: v.overlayKeys.length ? `this box's overlay sets ${v.overlayKeys.join(", ")}` : "none: every setting is the product file's" };
}

// The ruleset read is the guard's ask, so only root sees this row.
export async function rulesRow(c: CheckContext, ask?: Asker): Promise<Out> {
  const s = readState(filesOf(c), c.rootUid ?? 0);
  const repo = s.kind === "ok" ? s.value.repo : undefined;
  if (!repo) return { status: "SKIP", detail: "this box reads no settings repo yet" };
  const a = ask ?? (brokerHere(brokerPathsOf(c.paths).guardSocket) ? askerFor(brokerPathsOf(c.paths).guardSocket) : undefined);
  if (!a) return { status: "SKIP", detail: "the GitHub key keeper can't be reached by this user: run taskbox check as your admin user" };
  const r = await a({ ask: "settings-rules", repo });
  if (!r.ok) return { status: "SKIP", detail: `unknown: ${r.why}` };
  const x = r as { known?: boolean; pullRequest?: boolean };
  const page = `https://github.com/${repo}/settings/rules`;
  if (!x.known) return { status: "SKIP", detail: `unknown: the runner App can't read the settings repo's rulesets. Check them at ${page}` };
  if (x.pullRequest) return { status: "OK", detail: `${repo}'s default branch takes changes only by pull request` };
  return { status: "WARN", detail: `the settings repo's default branch takes direct pushes: a ruleset stops that. ${page}` };
}

// Temporary admin SSH: a WARN while its window is open; after, whether the tailnet still lets it in.
export async function adminSshRow(c: CheckContext): Promise<Out> {
  const { openWindow, windowLine } = await import("../settings/adminssh.ts");
  const v = c.cfg.adminSsh;
  if (!v) return { status: "SKIP", detail: "no temporary admin SSH is set" };
  if (openWindow(v, c.sys.now())) return { status: "WARN", detail: `${windowLine(v)}. A settings PR that takes adminSsh out ends it sooner` };
  if (c.uid !== 0 && (c.serviceUid === undefined || c.uid !== c.serviceUid)) return { status: "SKIP", detail: `the temporary admin SSH for ${v.user} ended at ${v.until}; only root and the service account can read whether the tailnet still lets it in` };
  const { liveSshUsers } = await import("./accounts.ts");
  const r = await c.sys.run(c.paths.tailscale, [`--socket=${c.paths.tailscaleSocket}`, "debug", "netmap"], { timeoutMs: 10_000 }).catch(() => ({ code: -1, stdout: "", stderr: "" }));
  let netmap: unknown;
  try {
    netmap = r.code === 0 ? JSON.parse(r.stdout) : undefined;
  } catch {}
  const live = liveSshUsers(netmap);
  if (!live) return { status: "SKIP", detail: `the temporary admin SSH for ${v.user} ended at ${v.until}; taskbox can't see the tailnet's SSH rules to say it has gone` };
  if (live.has(v.user)) return { status: "FAIL", detail: `the temporary admin SSH for ${v.user} ended at ${v.until}, and the tailnet still lets it in: on the controller, type taskbox policy show --box all, then paste it` };
  return { status: "OK", detail: `the temporary admin SSH for ${v.user} ended at ${v.until}, and the tailnet's rules no longer let it in` };
}

export const SETTINGS_ROWS: Row[] = [
  { name: "Temporary admin SSH", fn: adminSshRow as RowFn, order: 2077, in: ["check", "away"], when: (c) => !!c?.cfg?.adminSsh },
  { name: "Settings", fn: settingsRow as RowFn, order: 8200, in: ["check"], when: readsRepo },
  { name: "Box overlay", fn: overlayRow as RowFn, order: 8210, in: ["check"], when: readsRepo },
  { name: "Settings repo rules", fn: rulesRow as RowFn, order: 8220, in: ["check"], when: readsRepo },
];
