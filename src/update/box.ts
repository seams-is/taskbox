// The box's UpdateEnv (update/run.ts): every effect an update or a rollback has, run as root in the
// op's child (update/child.ts). Each step keeps to the op child's rules (core/child.ts): fixed
// programs, values from the op's record only, no git, nothing left running.
// - releases are read from the public repo with no token (hop.ts publicRelease: the assets only from
//   GitHub's own download address for that tag), the tarball streamed to a capped file;
// - ssh-keygen -Y verify runs as nobody, with PATH only, from a folder of verifyRelease's own;
// - the tarball's listing is checked, then unpacked with the flags that keep root's tar from
//   restoring owners and metadata, then the tree must be the statement's and its signers ours or a
//   transition the pinned keys signed (release/signers.ts);
// - the install is the tree as app/ beside the running install's bin/, bun and tools, root's;
// - the swap is two renames under the update lock, then the guard and its daemons reload through
//   launchd's one-shot, since a bootout from here would end this job's own group otherwise.
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { uidOf } from "../accounts.ts";
import { monotonicMs } from "../clock.ts";
import { changeControl, launchLoop, readControl, requestOf } from "../availability.ts";
import { bootId, monoNow } from "../core/boot.ts";
import { oneShotLabel, reloadThroughLaunchd } from "../core/child.ts";
import { eventLog } from "../core/events.ts";
import { readOp } from "../core/ops.ts";
import { type RootState } from "../core/paths.ts";
import { readOwnedJson, writeOwnedText } from "../core/rootfile.ts";
import { hashTree } from "../checks.ts";
import { type Config, GUARD_LABEL, type Installed, type Paths, readJson, readStateJson } from "../config.ts";
import { SUDO } from "../elevate.ts";
import { BROKER_LABEL, GUARDWATCH_LABEL, readBeat, watchPaths } from "../guardwatch.ts";
import { gitTreeSha, gunzippedSize, MAX_HOLD_MS, placeRollbackWatch, publicRelease, readRollbackWatch, removeRollbackWatch, ROLLBACK_AFTER_MS, SAFE_UNTAR, TARBALL_LIMIT, tarListProblem, UNPACKED_LIMIT, writeRollbackWatch } from "../hop.ts";
import { BROKER_ACCOUNT } from "../keys.ts";
import { type JobRecord, readJobs } from "../jobs.ts";
import { linkTarget, relink, withUpdateLock } from "../layout.ts";
import { installedCommit, readProof } from "../proof.ts";
import { undo } from "../ops.ts";
import { bare, NAMESPACE, PRINCIPAL, signerLines, SSH_KEYGEN, type Statement, signersProblem, verifyRelease, type VerifyDeps, verifySigned } from "../release.ts";
import { meet, parseSignerState, type SignerState, TRANSITION, TRANSITION_SIG } from "../release/signers.ts";
import { readInForce, settingsFiles } from "../settings/inforce.ts";
import { updateOf } from "../settings/update.ts";
import { rollbackSettings } from "./narrow.ts";
import type { Sys } from "../sys.ts";
import { listedReleases } from "./pick.ts";
import type { BeatName } from "./prove.ts";
import { workspaceHold } from "./auto.ts";
import { type InstallRecord, keptInstalls, type Marks, readInstallRecord, readMarks, writeInstallRecord, writeMarks } from "./records.ts";
import type { Downloaded, RollbackEnv, Running } from "./run.ts";

export const updateFiles = (s: Pick<RootState, "dir">) => ({ dir: join(s.dir, "update"), marks: join(s.dir, "updates.json"), signers: join(s.dir, "signers.json") });
const API = "https://api.github.com";

export interface BoxEnvDeps {
  sys: Sys;
  p: Paths;
  cfg: Config;
  state: RootState;
  op: string; // the op's id
  type: "update" | "rollback";
  actor: string;
  rootUid?: number;
  chown?: (path: string, uid: number, gid: number) => void;
  report: RollbackEnv["report"];
  log(line: string): void;
}

// ssh-keygen as nobody, with PATH only (workspace/approval.ts asNobody's form).
const nobody = (sys: Pick<Sys, "run">): VerifyDeps => ({ readable: true, run: (cmd, args, opts) => sys.run(SUDO, ["-n", "-u", "nobody", "--", "/usr/bin/env", "-i", "HOME=/var/empty", "PATH=/usr/bin:/bin", cmd, ...args], opts) });

// The running install's version: its install.json, or the v2 record's tag (the hop's v3.0.0-rc.1).
export function runningOf(p: Paths, rootUid = 0): Running {
  const dir = linkTarget(p.opt);
  if (!dir) throw new Error("/opt/taskbox isn't a link to an install taskbox made");
  const r = readInstallRecord(dir, rootUid);
  if (r.kind === "ok") return { version: r.value.version, dir, record: r.value };
  const tag = readStateJson<Installed>(join(dir, "installed.json"))?.tag;
  if (!tag || !/^v\d/.test(tag)) throw new Error("the running install has no version taskbox reads");
  return { version: bare(tag), dir };
}

export function readSigners(path: string, fallback: string, rootUid = 0): SignerState {
  const r = readOwnedJson(path, { owner: rootUid, max: 64 * 1024 }, (v) => parseSignerState(v) ?? "out of shape");
  return r.kind === "ok" ? r.value : { v: 1, pinned: fallback };
}

export function boxEnv(d: BoxEnvDeps): RollbackEnv {
  const root = d.rootUid ?? 0;
  const own = d.chown ? { chown: d.chown } : {};
  const f = updateFiles(d.state);
  mkdirSync(f.dir, { recursive: true, mode: 0o755 });
  const work = mkdtempSync(join(f.dir, `${d.op}-`));
  const repo = d.cfg.publicRepo;
  const actor = `${d.type} ${d.op}`;
  const u = updateOf(d.cfg);
  const events = eventLog("guard", { dir: d.state.events, owner: root, ...own }, d.sys);
  const ctl = { sys: d.sys, state: d.state, rootUid: root, ...own, events, log: d.log };
  let before: string | undefined; // the availability before the update's drain
  let beatsBefore: Record<string, number | undefined> = {};
  const runningNow = () => runningOf(d.p, root);
  const pinFallback = () => readFileSync(join(runningNow().dir, "app/signers/allowed_signers"), "utf8");
  const signers = () => readSigners(f.signers, pinFallback(), root);
  const saveSigners = (s: SignerState) => writeOwnedText(f.signers, `${JSON.stringify(s)}\n`, { mode: 0o644, owner: root, ...own });
  const run = async (cmd: string, args: string[], limitMs = 120_000) => {
    const r = await d.sys.run(cmd, args, { timeoutMs: limitMs });
    if (r.code !== 0) throw new Error(`${basename(cmd)} failed: ${r.stderr.replace(/[^\x20-\x7e]/g, " ").trim().slice(0, 100) || `exit ${r.code}`}`);
    return r;
  };
  const kick = async () => {
    const uid = await uidOf(d.sys, d.p.service).catch(() => undefined);
    return uid === undefined ? "the service account's uid can't be read" : launchLoop({ sys: d.sys, paths: d.p, uid });
  };

  let swapWall = 0; // the wall time of the swap, which the loop's beats are labelled by
  const clock = monotonicMs;
  return {
    clock,
    sleep: (ms) => d.sys.sleep(ms),
    report: d.report,
    log: d.log,
    live: () => {
      const r = readOp({ dir: d.state.ops, owner: root }, d.op);
      return r.kind === "ok" && r.value.state === "running";
    },
    running: runningNow,
    channel: () => u.channel,
    marks: () => readMarks(f.marks, root),
    saveMarks: (m: Marks) => writeMarks(f.marks, m, { rootUid: root, ...own }),
    async list() {
      if (!repo) throw new Error("taskbox.json names no publicRepo, so no release can be read");
      const res = await d.sys.fetch(`${API}/repos/${repo}/releases?per_page=100`, { redirect: "error", signal: d.sys.timeout(30_000), headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "taskbox" } });
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
      const listed = listedReleases(await res.json());
      writeMarks(f.marks, { ...readMarks(f.marks, root), checkedAt: d.sys.now() }, { rootUid: root, ...own });
      return listed;
    },
    async download(version, progress): Promise<Downloaded> {
      if (!repo) throw new Error("taskbox.json names no publicRepo");
      const rel = await publicRelease(d.sys, repo, `v${version}`);
      const tarball = join(work, `taskbox-v${version}.tar.gz`);
      progress(0);
      const tarballSha256 = await rel.assetToFile(`taskbox-v${version}.tar.gz`, TARBALL_LIMIT, tarball);
      progress(lstatSync(tarball).size);
      return { statement: rel.statement, signature: rel.signature, tarball, tarballSha256, assets: {} };
    },
    async verify(dl, o) {
      const cur = runningNow();
      return verifyRelease(nobody(d.sys), { statement: dl.statement, signature: dl.signature, pinned: signers().pinned, workRoot: f.dir, installed: { version: cur.version, ...(cur.record ? { sha256: cur.record.sha256 } : {}) }, repair: o.repair, want: o.want, channel: u.channel, tarballSha256: dl.tarballSha256 });
    },
    async stage(dl, s) {
      const listing = await d.sys.run("/usr/bin/tar", ["-tvzf", dl.tarball], { timeoutMs: 120_000 });
      if (listing.code !== 0) return { why: "its tarball can't be listed" };
      const why = tarListProblem(listing.stdout, UNPACKED_LIMIT);
      if (why) return { why: `its tarball ${why}` };
      if ((await gunzippedSize(dl.tarball, UNPACKED_LIMIT)) > UNPACKED_LIMIT) return { why: "its tarball unpacks larger than taskbox takes" };
      const dir = join(work, "app");
      mkdirSync(dir, { mode: 0o755 });
      const x = await d.sys.run("/usr/bin/tar", ["-xzf", dl.tarball, "-C", dir, "--strip-components", "1", ...SAFE_UNTAR], { timeoutMs: 300_000 });
      if (x.code !== 0) return { why: "its tarball didn't unpack" };
      let tree: string;
      try {
        tree = gitTreeSha(dir);
      } catch (e) {
        return { why: (e as Error).message.slice(0, 120) };
      }
      if (tree !== s.tree) return { why: "the unpacked tree isn't the one its statement names" };
      // The release keys: the same as ours, or a change ours signed, which waits as signers.ts says.
      const st = signers();
      const carried = readFileSync(join(dir, "signers/allowed_signers"), "utf8");
      if (signersProblem(carried)) return { why: "its signers file isn't one taskbox reads" };
      const same = (a: string, b: string) => signerLines(a).sort().join("\n") === signerLines(b).sort().join("\n");
      if (!same(carried, st.pinned) && !(st.pending && same(carried, st.pending.newText))) {
        if (!existsSync(join(dir, TRANSITION)) || !existsSync(join(dir, TRANSITION_SIG))) return { why: "it pins other release keys and carries no signed transition" };
        const text = readFileSync(join(dir, TRANSITION), "utf8");
        const ok = await verifySigned(nobody(d.sys), { message: new TextEncoder().encode(text), signature: new Uint8Array(readFileSync(join(dir, TRANSITION_SIG))), pinned: st.pinned, workRoot: f.dir }).catch(() => undefined);
        if (!ok?.ok) return { why: "its signer transition isn't signed by a pinned release key" };
        const m = meet(st, text, s.version, d.sys.now());
        if ("why" in m) return { why: m.why };
        saveSigners(m.state);
        if (m.said) d.report({ event: { type: "update.signers", text: `WARN ${m.said}`.slice(0, 240) } });
      }
      return { dir };
    },
    async plan(stage, s) {
      // The settings package validates the commit in use with the new release's rules; until it
      // lands, the box's settings are its own install's taskbox.json and box.json, which this release
      // reads (taskbox.example.json is the tree's only settings file).
      const lines = [`${s.version} carries ${Object.keys(s.assets).length} asset${Object.keys(s.assets).length === 1 ? "" : "s"}; the settings in use stay as they are.`];
      return existsSync(join(stage.dir, "src/cli.ts")) ? { lines } : { lines, problem: "its tree has no src/cli.ts" };
    },
    async drain(o) {
      const c = readControl(d.state.control, root);
      before = c.kind === "ok" ? c.value.availability : "active";
      if (before === "stopped" || before === "drained") return undefined;
      const r = await changeControl(ctl, requestOf("drain", { reason: `${d.type} ${d.op}`, ...(o.force && o.deadline ? { force: true, timeout: `${Math.max(1, Math.ceil((o.deadline - d.sys.now()) / 1000))}s` } : {}) }, actor));
      return r.ok ? undefined : r.said;
    },
    hold: () => workspaceHold(d.p.workspaces, root),
    drained() {
      const c = readControl(d.state.control, root);
      if (c.kind !== "ok") return "gone";
      if (c.value.availability === "drained" || c.value.availability === "stopped") return "drained";
      return c.value.availability === "draining" ? "draining" : "gone";
    },
    async resume() {
      if (before === undefined || before === "drained" || before === "stopped") return;
      const r = await changeControl({ ...ctl, kick }, { kind: "resume", actor });
      if (!r.ok) d.log(`the box couldn't be resumed: ${r.said}`);
      if (before === "paused") await changeControl(ctl, { kind: "pause", actor, reason: "paused before the update" });
    },
    async install(stage, s, dl) {
      const cur = runningNow();
      const dir = mkdtempSync(join(dirname(d.p.opt), `taskbox-${s.version}-`));
      // The running install's bin/, bun and tools, then the tree as app/.
      for (const name of readdirSync(cur.dir)) {
        if (["app", "installed.json", "install.json"].includes(name)) continue;
        cpSync(join(cur.dir, name), join(dir, name), { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
      }
      renameSync(stage.dir, join(dir, "app"));
      const rec: InstallRecord = { v: 1, version: s.version, statement: new TextDecoder().decode(dl.statement), signature: new TextDecoder().decode(dl.signature), sha256: s.sha256, settingsCommit: settingsCommitOf(d), at: d.sys.now(), by: d.actor.slice(0, 120), from: cur.version, ended: "installing" };
      d.chown?.(dir, root, 0);
      await run("/usr/sbin/chown", ["-R", `${root}:0`, dir]);
      await run("/bin/chmod", ["-R", "go-w", dir]);
      await run("/bin/chmod", ["755", dir]);
      writeInstallRecord(dir, rec, { rootUid: root, ...own });
      const v2: Installed = { commit: s.commit, pr: s.pr, title: `taskbox ${s.version}`, mergedAt: s.mergedAt, tag: s.tag, installedAt: new Date(d.sys.now()).toISOString(), files: hashTree(dir), format: 2, release: { repo: repo ?? "", statement: rec.statement, signature: rec.signature, signer: "" } };
      writeOwnedText(join(dir, "installed.json"), `${JSON.stringify(v2)}\n`, { mode: 0o644, owner: root, ...own });
      return dir;
    },
    async placeWatch(o) {
      const now = d.sys.now();
      const [mono, boot] = [await monoNow(d.sys), await bootId(d.sys)];
      await placeRollbackWatch(d.sys, d.p, { v: 1, tag: `v${o.version}`, to: o.to, back: o.back, placedAt: now, deadline: now + ROLLBACK_AFTER_MS, ...(mono !== undefined && boot ? { placedMono: mono, boot } : {}) }, d.chown ?? (() => {}));
    },
    async swap(to) {
      const cur = runningNow();
      const w = watchPaths(d.p);
      const keeperUid = await uidOf(d.sys, BROKER_ACCOUNT).catch(() => undefined);
      beatsBefore = { guard: readBeat(w.guardBeat, root)?.pid, keeper: keeperUid === undefined ? undefined : readBeat(w.brokerBeat, keeperUid)?.pid };
      swapWall = d.sys.now();
      await withUpdateLock(d.p, () => swapWall, () => { throw new Error("another update, undo or rollback holds the update lock"); }, async () => {
        relink(d.p.prev, basename(cur.dir));
        relink(d.p.opt, basename(to));
      });
      // Past the links nothing throws: a daemon that doesn't reload is the rollback watcher's to judge.
      await reloadDaemons(d, to).catch((e: Error) => d.log(`the daemons' reload failed: ${String(e?.message ?? e).slice(0, 160)}; the rollback watcher acts if the guard never starts`));
    },
    async baseline() {
      return checkRows(d);
    },
    need() {
      const w = watchPaths(d.p);
      return ["guard", ...(existsSync(w.brokerPlist) ? (["keeper"] as const) : []), "loop"] as BeatName[];
    },
    // A test job is expected when the jobs repo ran one in the last 7 days (template show test-job).
    testJob: () => {
      const jobs = jobsNow(d);
      return jobs.some((j) => isTestJob(j) && j.endedAt > d.sys.now() - 7 * 86_400_000);
    },
    async signals(o) {
      const w = watchPaths(d.p);
      const mono = await monoNow(d.sys);
      const fresh = (b: { pid: number; mono: number } | undefined, was: number | undefined) => !!b && b.pid !== was && mono !== undefined && mono >= b.mono && mono - b.mono < 120_000;
      const keeperUid = await uidOf(d.sys, BROKER_ACCOUNT).catch(() => undefined);
      const loop = readStateJson<{ slots?: Record<string, { beat?: { at?: number } }> }>(d.p.loopState);
      const loopBeat = Object.values(loop?.slots ?? {}).some((x) => Number.isSafeInteger(x?.beat?.at) && x.beat!.at! > swapWall);
      const beats = {
        guard: fresh(readBeat(w.guardBeat, root), beatsBefore.guard),
        keeper: keeperUid !== undefined && fresh(readBeat(w.brokerBeat, keeperUid), beatsBefore.keeper),
        loop: loopBeat,
      };
      const all = this.need().every((b) => beats[b]);
      // The selftest: the Linux proof the loop runs again for each install, on a Linux box.
      let selftest: "passed" | "failed" | "running" | "none" = "none";
      if (d.cfg.linux) {
        const to = linkTarget(d.p.opt);
        const commit = to ? installedCommit(join(to, "installed.json")) : "";
        const pr = readProof(d.p.projectState);
        if (pr && pr.commit === commit && pr.at >= swapWall) selftest = pr.ok ? "passed" : "failed";
        else if (d.sys.now() - swapWall < SELFTEST_MS) {
          selftest = "running";
          extendWatch(d, d.sys.now() + 30 * 60_000);
        }
      }
      const since = jobsNow(d).filter((j) => j.endedAt > swapWall);
      const t = since.find(isTestJob);
      const testJob = t ? { conclusion: t.result === "passed" ? ("success" as const) : t.result === "cancelled" ? ("cancelled" as const) : t.result === "failed" || t.result === "box failure" ? ("failure" as const) : ("other" as const) } : undefined;
      const jobs = since.filter((j) => !isTestJob(j)).map((j) => ({ name: j.workflow ?? j.job ?? "a job", outcome: j.result === "passed" ? "succeeded" : j.result }));
      return { beats, ...(all ? { rows: await checkRows(d) } : {}), selftest, ...(testJob ? { testJob } : {}), jobs };
    },
    // The watch file's deadline is wall time, as v2.6.1's watcher reads it; here it is put on clock()'s scale.
    watchDeadline: () => {
      const w = readRollbackWatch(d.p);
      return w ? w.deadline - d.sys.now() + clock() : undefined;
    },
    async endWatch() {
      const w = readRollbackWatch(d.p);
      if (w) writeRollbackWatch(d.p, { ...w, proved: true });
      await removeRollbackWatch(d.sys, d.p);
    },
    async goBack(o) {
      // undo goes back to /opt/taskbox.prev: for a kept install that isn't it, prev moves first.
      if (linkTarget(d.p.prev) !== o.to) relink(d.p.prev, basename(o.to));
      const said: string[] = [];
      const code = await undo({ sys: d.sys, paths: d.p, uid: 0, serviceUid: await uidOf(d.sys, d.p.service).catch(() => undefined), say: (l) => said.push(l), ask: async () => "no", ...(d.rootUid !== undefined ? { rootUid: d.rootUid } : {}) }, { yes: true, selfOp: d.op, floorFrom: join(o.to, "app") });
      for (const l of said) d.log(l);
      if (code === 0) {
        await removeRollbackWatch(d.sys, d.p).catch(() => {});
        return undefined;
      }
      return (said.find((l) => l.startsWith("Can't go back")) ?? said[0] ?? "undo stopped").slice(0, 160);
    },
    ended(dir, how, why) {
      const r = readInstallRecord(dir, root);
      if (r.kind === "ok") writeInstallRecord(dir, { ...r.value, ended: how, ...(why ? { why: why.replace(/[^\x20-\x7e]/g, " ").slice(0, 240) } : {}) }, { rootUid: root, ...own });
    },
    async rollbackSettings(record) {
      if (!record) return undefined;
      return rollbackSettings(settingsFiles(d.state.dir), record.settingsCommit, { rootUid: root, ...own, now: d.sys.now() }).catch((e: Error) => String(e?.message ?? e).slice(0, 160));
    },
    kept() {
      const cur = linkTarget(d.p.opt);
      const v3: { version: string; dir: string; record?: InstallRecord }[] = keptInstalls(dirname(d.p.opt), root)
        .filter((k) => k.dir !== cur)
        .map((k) => ({ version: k.record.version, dir: k.dir, record: k.record }));
      return [...v3, ...keptV2(d.p, cur)];
    },
  };
}

// The install before, when it is v2's (v2.6.1, while kept): a rollback to it is an admin's at the box.
function keptV2(p: Paths, cur: string | undefined): { version: string; dir: string }[] {
  const prev = linkTarget(p.prev);
  if (!prev || prev === cur || existsSync(join(prev, "install.json"))) return [];
  try {
    const tag = readJson<Installed>(join(prev, "installed.json")).tag;
    return tag && /^v2\./.test(tag) ? [{ version: bare(tag), dir: prev }] : [];
  } catch {
    return [];
  }
}

// The Linux proof's longest run (beat.ts "proving Linux"), past which the proof goes on without it.
export const SELFTEST_MS = 95 * 60_000;
export const isTestJob = (j: JobRecord) => typeof j.workflow === "string" && /^taskbox test job\b/.test(j.workflow);
export function jobsNow(d: BoxEnvDeps): JobRecord[] {
  try {
    const st = lstatSync(d.p.jobsFile);
    return readJobs(d.p, st.uid) ?? [];
  } catch {
    return [];
  }
}

// The new guard may move the watch's deadline later while proving waits on the selftest, up to
// MAX_HOLD_MS after it was placed, as v2.6.1's watcher allows.
function extendWatch(d: BoxEnvDeps, to: number): void {
  const w = readRollbackWatch(d.p);
  if (!w || w.proved) return;
  const deadline = Math.min(Math.max(w.deadline, to), w.placedAt + MAX_HOLD_MS);
  if (deadline !== w.deadline) writeRollbackWatch(d.p, { ...w, deadline });
}

// check's rows, from `taskbox check --json` of the install in place, run as the service account.
export async function checkRows(d: BoxEnvDeps): Promise<Record<string, string>> {
  const r = await d.sys.run(SUDO, ["-n", "-u", d.p.service, "--", join(d.p.bin, "taskbox"), "check", "--json"], { timeoutMs: 300_000 });
  for (const line of r.stdout.split("\n")) {
    try {
      const v = JSON.parse(line) as { result?: { checks?: { name?: unknown; status?: unknown }[] } };
      const rows = v?.result?.checks;
      if (Array.isArray(rows)) return Object.fromEntries(rows.filter((k) => typeof k.name === "string" && typeof k.status === "string").map((k) => [k.name as string, k.status as string]));
    } catch {}
  }
  return {};
}

// The guard's, guardwatch's and the broker's plists from the new tree, then each reloaded through
// launchd's one-shot. The loop needs none: it exits 75 once /opt/taskbox names another install, and
// launchd starts it again from the same definition.
async function reloadDaemons(d: BoxEnvDeps, to: string): Promise<void> {
  const w = watchPaths(d.p);
  const root = d.rootUid ?? 0;
  const daemons = [
    { name: "guard", label: GUARD_LABEL, plist: d.p.guardPlist },
    { name: "guardwatch", label: GUARDWATCH_LABEL, plist: w.plist },
    { name: "broker", label: BROKER_LABEL, plist: w.brokerPlist },
  ];
  for (const x of daemons) {
    const fresh = join(to, "app/launchd", `${x.label}.plist`);
    if (!existsSync(x.plist) && x.name !== "guard") continue;
    const job = oneShotLabel(`${x.name}-update`);
    const ok = await (async () => {
      if (existsSync(fresh)) writeOwnedText(x.plist, readFileSync(fresh, "utf8"), { mode: 0o644, owner: root, ...(d.chown ? { chown: d.chown } : {}) });
      return reloadThroughLaunchd({ sys: d.sys, chown: d.chown ?? (() => {}), timeoutMs: 20_000, rootUid: root }, { job, target: x.label, plist: x.plist, token: join(updateFiles(d.state).dir, `${x.name}.token`), self: join(dirname(d.p.guardPlist), `${job}.plist`), waitS: 20 });
    })().catch((e: Error) => (d.log(`${x.label}: ${String(e?.message ?? e).slice(0, 120)}`), false));
    if (!ok) d.log(`launchd didn't take the one-shot that reloads ${x.label}; the rollback watcher acts if it never starts`);
  }
}

// The settings commit in force (settings/inforce.ts), recorded at an install for its rollback.
function settingsCommitOf(d: BoxEnvDeps): string | null {
  const r = readInForce(settingsFiles(d.state.dir), d.rootUid ?? 0);
  return r.kind === "ok" ? r.value.sha : null;
}

export const cleanWork = (s: Pick<RootState, "dir">, op: string) => {
  const dir = updateFiles(s).dir;
  try {
    for (const n of readdirSync(dir)) if (n.startsWith(`${op}-`)) rmSync(join(dir, n), { recursive: true, force: true });
  } catch {}
};

export { NAMESPACE, PRINCIPAL, SSH_KEYGEN };
export type { Statement };
