// The box's MigrateEnv (migrate/run.ts): every effect migrate-v3 has, run as root in its op's child
// (migrate/child.ts). Each step keeps to the op child's rules (core/child.ts): fixed programs, values
// from the box's own files only, no git, nothing left running but launchd's own daemons. Each step is
// idempotent: it reads what is there and makes only what isn't.
// What v2.6.1 left is only read: its install, its taskbox.json, its key files and its plists stay as
// they are, so v2.6.1's own undo finds them (the design's table of what a rollback finds).
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { GATE_SHELL, REMOTE_SHELL, type Config, LAUNCHCTL_MS, type Paths, readStateJson } from "../config.ts";
import { poolOf } from "../access.ts";
import { applyAccountsStep, placeSystem, planAccountsStep, readRecord, uidOf, writeRecord } from "../accounts.ts";
import { launchLoop } from "../availability.ts";
import { bootId, monoNow } from "../core/boot.ts";
import type { Report } from "../core/child.ts";
import { eventLog } from "../core/events.ts";
import type { RootState } from "../core/paths.ts";
import { isObj, readOwnedJson } from "../core/rootfile.ts";
import { clientFor, wantsOf, writeBoxKeys, sourceSettings } from "../connectflow.ts";
import { BROKER_LABEL, GUARDWATCH_LABEL, readBeat, runningPid, watchPaths } from "../guardwatch.ts";
import { readRollbackWatch, removeRollbackWatch, writeRollbackWatch } from "../hop.ts";
import { retirePrevious, setSetuid } from "../install.ts";
import { FETCHED, fetchTool } from "./tools.ts";
import { BROKER_ACCOUNT, brokerFoldersProblem, brokerPathsOf, keyFileName, placePending, promoteKey, readAdoptedKey } from "../keys.ts";
import { linkTarget, withUpdateLock } from "../layout.ts";
import { NETWATCH_LABEL, netPaths } from "../net/paths.ts";
import { placeNetFolders } from "../net/place.ts";
import { installedCommit, readProof } from "../proof.ts";
import { readState, settingsFiles, updateState } from "../settings/inforce.ts";
import { sourceOf } from "../config.ts";
import type { Sys } from "../sys.ts";
import { checkRows, isTestJob, jobsNow, SELFTEST_MS } from "../update/box.ts";
import { BEATS_MS, type BeatName, judge } from "../update/prove.ts";
import { type LoopStart, loopStartPath } from "./gate.ts";
import { type Journal, readJournal, writeJournal } from "./journal.ts";
import { type MigrateEnv, type Proof, type V2Loop } from "./run.ts";
import { keptAppOf, readKeptV2, V2_SERVICE, writeV2Copy } from "./v2settings.ts";

export interface MigrateBoxDeps {
  sys: Sys;
  p: Paths;
  cfg: Config;
  state: RootState;
  op: string;
  rootUid?: number;
  chown?: (path: string, uid: number, gid: number) => void;
  report(r: Report): void;
  log(line: string): void;
  clock(): number; // monotonic ms, for the proof's waits
}

const SETTLE_MS = 2 * 60_000; // how long step 3 waits for the settings op's first read
const KEEPER_MS = 60_000; // how long step 2 waits for the keeper's first beat
const LOCK_POLL_MS = 5_000;
const LOCK_WAIT_MS = 10 * 60_000;

// launchctl print's pid for a label in a domain, or undefined when nothing runs under it.
async function pidOf(sys: Pick<Sys, "run">, target: string): Promise<number | undefined> {
  const r = await sys.run("/bin/launchctl", ["print", target], { timeoutMs: 10_000 }).catch(() => ({ code: 1, stdout: "" }));
  return r.code === 0 ? runningPid(r.stdout) : undefined;
}

// A LaunchDaemon from the install's own tree, its plist written as the install writes it, and loaded
// when launchd doesn't hold it. Throws when launchd won't take it.
async function placeDaemon(d: MigrateBoxDeps, label: string, plist: string): Promise<void> {
  const { writeOwnedText } = await import("../core/rootfile.ts");
  const text = readFileSync(join(d.p.app, "launchd", `${label}.plist`), "utf8");
  const same = (() => {
    try {
      return readFileSync(plist, "utf8") === text;
    } catch {
      return false;
    }
  })();
  if (!same) writeOwnedText(plist, text, { mode: 0o644, owner: d.rootUid ?? 0, ...(d.chown ? { chown: d.chown } : {}) });
  const held = await d.sys.run("/bin/launchctl", ["print", `system/${label}`], { timeoutMs: LAUNCHCTL_MS });
  if (held.code === 0 && same) return;
  if (held.code === 0) await d.sys.run("/bin/launchctl", ["bootout", `system/${label}`], { timeoutMs: LAUNCHCTL_MS });
  let boot = { code: -1, stdout: "", stderr: "" };
  for (let i = 0; i < 5 && boot.code !== 0; i++) {
    if (i) await d.sys.sleep(2000);
    boot = await d.sys.run("/bin/launchctl", ["bootstrap", "system", plist], { timeoutMs: LAUNCHCTL_MS });
  }
  if (boot.code !== 0) throw new Error(`${label} didn't load (${boot.stderr.trim().slice(0, 100) || `launchctl exit ${boot.code}`})`);
}

const accountDeps = (d: MigrateBoxDeps) => ({ sys: d.sys, say: (l: string) => d.log(l), ask: async () => "", tty: () => 1, chown: d.chown ?? (() => {}), rootUid: d.rootUid ?? 0 });

// An App's slug, by GET /app with its own key: the proof that the key is the App's.
async function slugWith(d: MigrateBoxDeps, id: number, pem: string): Promise<string | undefined> {
  const { Log } = await import("../log.ts");
  const app = clientFor({ sys: d.sys, log: new Log() }, id, pem);
  const r = await app.call("GET", "/app").catch(() => undefined);
  if (!r?.ok) return undefined;
  const s = ((await r.json().catch(() => undefined)) as { slug?: unknown } | undefined)?.slug;
  return typeof s === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(s) ? s : undefined;
}

export function migrateEnv(d: MigrateBoxDeps): MigrateEnv {
  const root = d.rootUid ?? 0;
  const own = { owner: root, ...(d.chown ? { chown: d.chown } : {}) };
  const events = eventLog("guard", { dir: d.state.events, owner: root, ...(d.chown ? { chown: d.chown } : {}) }, d.sys);
  const journal = (): Journal => {
    const r = readJournal(d.state.dir, root);
    if (r.kind !== "ok") throw new Error(`the move's journal can't be read: ${r.kind === "bad" ? r.why : "it isn't there"}`);
    return r.value;
  };
  const serviceUid = () => uidOf(d.sys, d.p.service);
  let liftedAt: number | undefined; // the proof's start, on d.clock()
  let liftedWall = 0;
  let before: Record<string, string> | undefined;

  // The watch file, written under the update lock as v2.6.1's watcher reads it there. A busy lock
  // leaves it for the next pass.
  const setDeadline = async (deadline: number): Promise<void> => {
    await withUpdateLock(d.p, () => d.sys.now(), () => undefined, async () => {
      const w = readRollbackWatch(d.p);
      if (w && !w.proved && w.deadline !== deadline) writeRollbackWatch(d.p, { ...w, deadline });
    });
  };

  // The update lock, around a step that moves files or launchd jobs, never across a wait on a person.
  // A busy lock (v2.6.1 holds it for the seconds after this guard starts) waits and tries again; a
  // stale one is taken over as v2.6.1 does (layout.ts).
  const locked = (f: () => Promise<string | undefined>) => async (): Promise<string | undefined> => {
    for (let waited = 0; ; waited += LOCK_POLL_MS) {
      const busy = Symbol("busy");
      const r = await withUpdateLock<string | undefined | typeof busy>(d.p, () => d.sys.now(), () => busy, f);
      if (r !== busy) return r;
      if (waited >= LOCK_WAIT_MS) throw new Error("another update, undo or rollback held the update lock for 10 minutes");
      await d.sys.sleep(LOCK_POLL_MS);
    }
  };

  const steps: MigrateEnv["steps"] = {
    // Take-over 1: launchd runs the loop. A box drained or stopped before the hop had none: its plist,
    // which hop() wrote, is loaded, and that loop is v3's, gated.
    loop: locked(async () => {
      const uid = await serviceUid();
      if (uid === undefined) throw new Error(`the service account ${d.p.service} isn't on this Mac`);
      const why = await launchLoop({ sys: d.sys, paths: d.p, uid });
      return why ? `needs-you: the loop didn't start (${why}); it starts at ${d.p.service}'s next login` : undefined;
    }),
    // Step 1: v2.6.1's own settings, read once and kept, converted; the service in use recorded.
    async read() {
      const j = journal();
      const doc = readKeptV2(d.p.app);
      if (!doc) throw new Error(`v2.6.1's taskbox.json can't be read from ${keptAppOf(d.p.app)}`);
      mkdirSync(join(d.state.dir, "settings"), { recursive: true, mode: 0o755 });
      writeV2Copy(d.p.app, doc, own);
      const project = typeof doc.project === "string" ? doc.project : undefined;
      if (project && j.project !== project) writeJournal(d.state.dir, { ...journal(), project }, own);
      const rec = readRecord(d.p.accountsRecord);
      const uid = await serviceUid();
      if (rec.inUse?.service !== V2_SERVICE || (uid !== undefined && !rec.made[V2_SERVICE])) {
        writeRecord(own.chown ? { chown: own.chown, rootUid: root } : { chown: () => {}, rootUid: root }, d.p.accountsRecord, { ...rec, inUse: { service: V2_SERVICE }, made: { ...rec.made, ...(uid !== undefined && !rec.made[V2_SERVICE] ? { [V2_SERVICE]: { role: "service" as const, uid } } : {}) } });
      }
      return undefined;
    },
    // Step 2: the key keeper. Its account and folders, each App's key copied in once it proves with
    // GET /app, box.json naming the Apps, then its LaunchDaemon. v2.6.1's key files stay where they are.
    keys: locked(async () => {
      const made = await placeSystem(accountDeps(d), BROKER_ACCOUNT, d.p.accountsRecord);
      if (typeof made === "string") throw new Error(made);
      const gid = await d.sys.run("/usr/bin/id", ["-g", BROKER_ACCOUNT], { timeoutMs: 10_000 }).then((x) => Number(x.stdout.trim()));
      if (!Number.isSafeInteger(gid)) throw new Error(`${BROKER_ACCOUNT}'s group can't be read`);
      const b = brokerPathsOf(d.p);
      const why = await brokerFoldersProblem({ sys: d.sys, chown: d.chown ?? (() => {}), rootUid: root }, b, { brokerUid: made, brokerGid: gid, brokerName: BROKER_ACCOUNT, serviceName: d.p.service });
      if (why) throw new Error(why);
      const su = await serviceUid();
      if (su === undefined) throw new Error(`the service account ${d.p.service} isn't on this Mac`);
      const keys = { dir: b.keys, ownerUid: made, ownerGid: gid };
      const take = async (role: "runner" | "source", id: number, paths: string[]): Promise<string> => {
        const held = existsSync(join(b.keys, keyFileName(role, id)));
        const pem = held ? undefined : paths.map((f) => readAdoptedKey(f, su)).find((k) => k !== undefined);
        if (!held && !pem) throw new Error(`v2.6.1's ${role} key isn't a key file of ${d.p.service}'s own`);
        const { readHeldKey } = await import("../keys.ts");
        const key = pem ?? readHeldKey(b.keys, made, role, id);
        if (!key) throw new Error(`the keeper's ${role} key can't be read`);
        const slug = await slugWith(d, id, key);
        if (!slug) throw new Error(`v2.6.1's ${role} key isn't App ${id}'s: GitHub didn't take it for GET /app`);
        if (!held) {
          const placed = placePending(keys, role, id, key) ?? promoteKey(b.keys, role, id);
          if (placed) throw new Error(placed);
        }
        return slug;
      };
      const set: Record<string, unknown> = { runnerApp: { appId: d.cfg.appId, app: await take("runner", d.cfg.appId, [d.p.oldKey]) } };
      const s = sourceOf(d.cfg);
      if (s.type === "github-actions") set.sources = [sourceSettings(s.appId, await take("source", s.appId, [d.p.actionsKey, join(d.p.actionsKeyDir, `actions-${s.appId}.pem`)]), wantsOf(d.cfg))];
      writeBoxKeys({ boxFile: d.p.boxSettings, rootUid: root, ...(d.chown ? { chown: d.chown } : {}) }, set);
      await placeDaemon(d, BROKER_LABEL, watchPaths(d.p).brokerPlist);
      // Its first beat, so the loop finds it once the gate lifts.
      for (let waited = 0; waited < KEEPER_MS; waited += 2000) {
        if (readBeat(watchPaths(d.p).brokerBeat, made)) return undefined;
        await d.sys.sleep(2000);
      }
      throw new Error("the GitHub key keeper didn't beat within a minute of its start");
    }),
    // Step 3: the settings repo, found and read by the settings op (settings/op.ts), now that the
    // keeper holds the runner App. Its first commit waits for confirm at the box. Without one, v3
    // runs on v2.6.1's settings, converted. Either way the move goes on.
    async settings() {
      const f = settingsFiles(d.state.dir);
      await updateState(f, { rootUid: root, ...(d.chown ? { chown: d.chown } : {}) }, (s) => ({ state: { ...s, readNow: true }, out: undefined }));
      for (let waited = 0; waited < SETTLE_MS; waited += 5000) {
        const r = readState(f, root);
        const v = r.kind === "ok" ? r.value : undefined;
        if (v?.waiting) return v.waiting.first ? "needs-you: taskbox confirm, for the settings commit's guarded changes" : undefined;
        if (v?.inUse) return undefined;
        if (v && !v.readNow && v.problem) return `needs-you: ${v.problem.why}`.slice(0, 240);
        await d.sys.sleep(5000);
      }
      return "needs-you: the settings repo wasn't read yet: taskbox settings repo ORG/REPO names it";
    },
    // Step 4: the tools v3 runs on are v2.6.1's copies, each checked against v3's pins; the bin/ links
    // must resolve into this install's app. A pin that differs is fetched; Tailscale's is said.
    async tools() {
      const mine = linkTarget(d.p.opt);
      for (const name of ["taskbox", "taskbox-shell"]) {
        const link = join(d.p.bin, name);
        let to: string;
        try {
          to = realpathSync(link);
        } catch {
          throw new Error(`${link} doesn't resolve`);
        }
        if (!mine || !to.startsWith(`${realpathSync(mine)}/app/src/`)) throw new Error(`${link} points at ${readlinkSync(link).slice(0, 100)}, outside this install`);
      }
      const pins = (f: string) => readStateJson<Record<string, { version?: string; sha256?: string; files?: Record<string, string> }>>(f);
      const v3 = pins(join(d.p.app, "versions.json"));
      const v2 = pins(join(keptAppOf(d.p.app), "versions.json"));
      if (!v3 || !v2) return "needs-you: the tool pins couldn't be compared; taskbox update brings v3's own";
      // Each tool whose pin differs is fetched and moved in (migrate/tools.ts), under the update lock.
      const off = toolsDiffer(v2, v3);
      for (const name of FETCHED) {
        if (!off.includes(name)) continue;
        await locked(async () => (await fetchTool({ sys: d.sys, setuid: (path) => setSetuid(d.sys, path, root === 0) }, mine!, name, v3[name]!), undefined))();
        d.log(`fetched ${name} ${v3[name]!.version ?? ""}, v3's pin`);
      }
      const left = off.filter((n) => !(FETCHED as readonly string[]).includes(n));
      return left.length ? `needs-you: ${left.join(", ")} differ${left.length === 1 ? "s" : ""} from v3's pin: taskbox update brings ${left.length === 1 ? "it" : "them"}` : undefined;
    },
    // Step 5: the pool accounts and _taskboxnet, as an install makes them, non-interactive. People are
    // an install's, with a password typed at the prompt, so none is made here.
    async accounts() {
      const a = d.cfg.accounts;
      const plan = await planAccountsStep(d.sys, d.p, { ...(a.agent !== undefined ? { agent: a.agent } : {}), people: [] }, poolOf(a, undefined), undefined, REMOTE_SHELL, root);
      const done = await applyAccountsStep(accountDeps(d), d.p, plan, { poolShell: GATE_SHELL, event: (type, subject, text) => events.write({ type, subject, actor: "taskbox", text }) });
      if (done.stop) throw new Error(done.stop);
      return plan.lines.find((l) => /leaves it alone/.test(l)) ? `needs-you: ${plan.lines.find((l) => /leaves it alone/.test(l))!}`.slice(0, 240) : undefined;
    },
    // Step 6: guardwatch, then network capture.
    daemons: locked(async () => {
      await placeDaemon(d, GUARDWATCH_LABEL, watchPaths(d.p).plist);
      const said: string[] = [];
      if (await placeNetFolders({ sys: d.sys, paths: d.p, chown: d.chown ?? (() => {}), say: (l) => said.push(l.trim()) })) await placeDaemon(d, NETWATCH_LABEL, netPaths(d.p).plist);
      return said[0] ? `needs-you: ${said[0]}`.slice(0, 240) : undefined;
    }),
    // Step 7: the event log, with the move's own record so far.
    async events() {
      const j = journal();
      events.write({ type: "takeover.migrated", actor: "taskbox", subject: "box", op: d.op, text: `The box's settings, accounts, keys and daemons moved to ${j.tag}.`.slice(0, 240), data: { tag: j.tag, v2Jobs: j.v2Jobs?.seen ?? 0 } });
      return undefined;
    },
    // Step 8: services under v2's earlier label prefix go. run.ts lifts the gate once this is done.
    async tidy() {
      const prefix = d.cfg.previousLabelPrefix;
      if (prefix) await locked(async () => (await retirePrevious({ sys: d.sys, paths: d.p, say: (l) => d.log(l) }, prefix), undefined))();
      before = await checkRows(boxDeps(d)).catch(() => ({}));
      return undefined;
    },
    "v3-loop": async () => {
      // Take-over 4: launchd's loop is v3's, gated: its pid is the one loop-start.json names.
      const uid = await serviceUid();
      if (uid === undefined) throw new Error(`the service account ${d.p.service} isn't on this Mac`);
      for (let waited = 0; waited < 120_000; waited += 2000) {
        const pid = await pidOf(d.sys, `gui/${uid}/local.taskbox.loop`);
        const s = readLoopStart(d.p, uid);
        if (pid !== undefined && s?.pid === pid && s.install === linkTarget(d.p.opt)) return undefined;
        await d.sys.sleep(2000);
      }
      throw new Error("v3's loop didn't start under launchd within 2 minutes");
    },
  };

  return {
    now: () => d.sys.now(),
    sleep: (ms) => d.sys.sleep(ms),
    report: d.report,
    log: d.log,
    stillHere: () => linkTarget(d.p.opt) === journal().to,
    journal,
    saveJournal: (j) => writeJournal(d.state.dir, j, own),
    watch: () => readRollbackWatch(d.p),
    setDeadline: (deadline) => setDeadline(deadline).catch((e: Error) => d.log(`the watch's deadline wasn't written: ${String(e?.message ?? e).slice(0, 120)}`)),
    steps,
    async v2Loop(): Promise<V2Loop> {
      const uid = await serviceUid();
      if (uid === undefined) return { running: false, jobs: 0 };
      const pid = await pidOf(d.sys, `gui/${uid}/local.taskbox.loop`);
      const s = readLoopStart(d.p, uid);
      const running = pid !== undefined && !(s && s.pid === pid && s.install === linkTarget(d.p.opt));
      if (!running) return { running: false, jobs: 0 };
      const loop = readStateJson<{ slot?: string; slotAt?: number; slots?: Record<string, { slot?: string; slotAt?: number }> }>(d.p.loopState);
      const all = Object.values(loop?.slots ?? {}).filter((x) => x?.slot === "running a job");
      const jobs = all.length ? all : loop?.slot === "running a job" ? [loop] : [];
      const since = jobs.map((x) => x.slotAt).filter((t): t is number => Number.isSafeInteger(t)).sort((a, b) => a - b)[0];
      return { running: true, jobs: jobs.length, ...(since !== undefined ? { since } : {}) };
    },
    v2JobLimitMinutes() {
      const doc = readKeptV2(d.p.app);
      const t = doc?.jobTimeoutMinutes;
      return Number.isSafeInteger(t) ? (t as number) + 10 : undefined;
    },
    async prove(): Promise<Proof> {
      liftedAt ??= d.clock();
      liftedWall ||= d.sys.now();
      before ??= {};
      const w = watchPaths(d.p);
      const keeperUid = await uidOf(d.sys, BROKER_ACCOUNT).catch(() => undefined);
      const need: BeatName[] = ["guard", ...(existsSync(w.brokerPlist) ? (["keeper"] as const) : []), "loop"];
      const recent = (jobs: ReturnType<typeof jobsNow>) => jobs.some((j) => isTestJob(j) && j.endedAt > d.sys.now() - 7 * 86_400_000);
      const testJob = recent(jobsNow(boxDeps(d)));
      for (;;) {
        const mono = await monoNow(d.sys);
        const fresh = (b: { mono: number } | undefined) => !!b && mono !== undefined && mono >= b.mono && mono - b.mono < 120_000;
        const loop = readStateJson<{ slots?: Record<string, { beat?: { at?: number } }> }>(d.p.loopState);
        const beats = {
          guard: fresh(readBeat(w.guardBeat, root)),
          keeper: keeperUid !== undefined && fresh(readBeat(w.brokerBeat, keeperUid)),
          loop: Object.values(loop?.slots ?? {}).some((x) => Number.isSafeInteger(x?.beat?.at) && x.beat!.at! > liftedWall),
        };
        let selftest: "passed" | "failed" | "running" | "none" = "none";
        if (d.cfg.linux) {
          const pr = readProof(d.p.projectState);
          const commit = installedCommit(join(linkTarget(d.p.opt) ?? d.p.opt, "installed.json"));
          if (pr && pr.commit === commit && pr.at >= liftedWall) selftest = pr.ok ? "passed" : "failed";
          else if (d.sys.now() - liftedWall < SELFTEST_MS) selftest = "running";
        }
        const since = jobsNow(boxDeps(d)).filter((j) => j.endedAt > liftedWall);
        const t = since.find(isTestJob);
        const all = need.every((b) => beats[b]);
        const watch = readRollbackWatch(d.p);
        const p = judge({
          swappedAt: liftedAt,
          now: d.clock(),
          need,
          before,
          proveMs: 60 * 60_000,
          ...(watch ? { watchDeadline: watch.deadline - d.sys.now() + d.clock() } : {}),
          testJob,
          s: { beats, ...(all ? { rows: await checkRows(boxDeps(d)) } : {}), selftest, ...(t ? { testJob: { conclusion: t.result === "passed" ? "success" : t.result === "cancelled" ? "cancelled" : t.result === "failed" || t.result === "box failure" ? "failure" : "other" } } : {}), jobs: since.filter((j) => !isTestJob(j)).map((j) => ({ name: j.workflow ?? j.job ?? "a job", outcome: j.result === "passed" ? "succeeded" : j.result })) },
        });
        if (p.kind !== "wait") return p;
        d.report({ progress: { text: p.text.slice(0, 120) } });
        await d.sys.sleep(Math.min(15_000, BEATS_MS));
      }
    },
    async endWatch() {
      await withUpdateLock(d.p, () => d.sys.now(), () => {
        throw new Error("the update lock is held, so the watch ends on the next try");
      }, async () => {
        const w = readRollbackWatch(d.p);
        if (w) writeRollbackWatch(d.p, { ...w, proved: true });
      });
      await removeRollbackWatch(d.sys, d.p);
    },
  };
}

// The update package's env deps, for the helpers the proof shares with it.
const boxDeps = (d: MigrateBoxDeps) => ({ sys: d.sys, p: d.p, cfg: d.cfg, state: d.state, op: d.op, type: "update" as const, actor: "migrate-v3", report: d.report, log: d.log, ...(d.rootUid !== undefined ? { rootUid: d.rootUid } : {}) });

export function readLoopStart(p: Pick<Paths, "serviceHome">, serviceUid: number): LoopStart | undefined {
  const r = readOwnedJson(loopStartPath(p.serviceHome), { owner: serviceUid, max: 1024 }, (v) => (isObj(v) && v.v === 1 && Number.isSafeInteger(v.pid) && typeof v.install === "string" && Number.isSafeInteger(v.at) ? (v as unknown as LoopStart) : "not a loop start"));
  return r.kind === "ok" ? r.value : undefined;
}

// The tools whose pins differ between v2.6.1's versions.json and v3's: version and archive hash, and
// for tailscale the binaries' own hashes (its archive is rebuilt per repo, the binaries are the same).
export function toolsDiffer(v2: Record<string, { version?: string; sha256?: string; files?: Record<string, string> }>, v3: Record<string, { version?: string; sha256?: string; files?: Record<string, string> }>): string[] {
  const out: string[] = [];
  for (const name of ["bun", "tart", "softnet", "tailscale"]) {
    const a = v2[name];
    const b = v3[name];
    if (!a || !b) continue;
    const same = name === "tailscale" ? a.version === b.version && JSON.stringify(a.files ?? {}) === JSON.stringify(b.files ?? {}) : a.version === b.version && a.sha256 === b.sha256;
    if (!same) out.push(name);
  }
  return out;
}

