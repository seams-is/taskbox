// v2.5.0 away-ready check rows. Each is its own function, run by
// `taskbox check` (CHECK_EXTRA) and by `taskbox check --away`, never before a VM. Every row says what to do
// and where: at the box, from away, or nothing. Rows that need ci or root show, for anyone else, the
// loop's last recorded result, and never name a user.
import { lstatSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { beatState } from "./beat.ts";
import { bootId, monoNow } from "./core/boot.ts";
import { rootStateOf } from "./core/paths.ts";
import { lapse, readPending } from "./core/pending.ts";
import { BROKER_ACCOUNT, BROKER_LABEL, beatState as beatNowOf, RESTARTS_PER_HOUR, STALE_MS, watchPaths } from "./guardwatch.ts";
import type { Check, CheckContext } from "./checks.ts";
import { awayOf, GUARD_LABEL, sourceOf } from "./config.ts";
import { sourceNext } from "./sourcefail.ts";
import { CLOCK_LIMIT_S, GitHubError, githubLine, githubState } from "./ghfail.ts";
import { GitHub } from "./github.ts";
import { Log } from "./log.ts";
import { UPDATE_FIX } from "./state.ts";
import { readLoop } from "./watch.ts";

type Row = Omit<Check, "name">;
const ok = (detail = ""): Row => ({ status: "OK", detail });
const fail = (detail: string): Row => ({ status: "FAIL", detail });
const skip = (detail: string): Row => ({ status: "SKIP", detail });

const ago = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m < 2 ? "a minute ago" : m < 120 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};

// The App's key, its installation and the clock, by one read-only call, as ci or root. For anyone
// else, who can't read the key, the loop's last recorded runner request and its age.
export async function githubRow(c: CheckContext, gh?: GitHub): Promise<Row> {
  const mayReadKey = c.uid === 0 || (c.serviceUid !== undefined && c.uid === c.serviceUid);
  if (!mayReadKey) {
    const loop = readLoop(c.paths.loopState);
    const r = loop.github;
    if (!r) return skip("the loop hasn't asked GitHub for a runner since v2.5.0 started");
    const st = githubState(r, c.sys.now());
    if (st?.word === "Failing") return fail(`${st.detail}. ${st.next}`);
    if (r.failures > 0) return ok(`the loop's last runner request failed (${r.last}), ${ago(c.sys.now() - r.at)}; it tries again by itself`);
    return ok(`the loop's last runner request worked, ${ago(c.sys.now() - r.at)}`);
  }
  try {
    let client = gh;
    if (!client) {
      const pem = readFileSync(c.paths.key, "utf8");
      client = new GitHub(c.sys, c.cfg, pem, new Log());
    }
    const { offsetS } = await client.appCheck();
    if (offsetS !== null && Math.abs(offsetS) > CLOCK_LIMIT_S) {
      const m = Math.max(1, Math.round(Math.abs(offsetS) / 60));
      return fail(`the box's clock is ${m} min ${offsetS > 0 ? "fast" : "slow"} against GitHub's. ${UPDATE_FIX} It turns on automatic time. If it still drifts, check the box's network.`);
    }
    return ok(`the App's key works${offsetS !== null ? `; the clock is within ${Math.max(1, Math.abs(offsetS))} s of GitHub's` : ""}`);
  } catch (e) {
    if (!(e instanceof GitHubError)) return fail("the App's key couldn't be read. At the box: as your admin user, type taskbox check");
    const line = githubLine(e.kind, e.status, e.offsetS);
    return fail(`${line.detail}. ${line.next}`);
  }
}

// Every slot's heartbeat, from the loop's state.
export async function heartbeatRow(c: CheckContext): Promise<Row> {
  const loop = readLoop(c.paths.loopState);
  const running = Object.entries(loop.slots ?? {}).filter(([n]) => Number(n) <= (loop.slotCount ?? 1)).map(([, s]) => s);
  const beats = running.filter((s) => s.beat).length;
  if (!beats) return skip("no heartbeat yet: the loop writes one from v2.5.0 on");
  const st = beatState(loop, c.sys.now());
  if (st) return fail(`${st.detail}. ${st.next}`);
  const oldest = Math.min(...running.flatMap((s) => (s.beat ? [s.beat.at] : [])));
  return ok(`${beats === 1 ? "the loop's beat" : `every slot's beat (${beats})`} is within its deadline; the oldest is from ${ago(c.sys.now() - oldest)}`);
}

// macOS installing its own updates restarts the box to the FileVault screen. The managed file (a
// profile) wins over the box's own setting; a key that isn't set reads as on, as macOS's default can be.
// managed: the value came from a profile, which the install's write under /Library/Preferences can't change.
const SU = "com.apple.SoftwareUpdate";
async function suKey(c: CheckContext, key: string): Promise<{ on: boolean; managed: boolean } | undefined> {
  for (const managed of [true, false]) {
    const dom = `/Library/${managed ? "Managed Preferences" : "Preferences"}/${SU}`;
    const r = await c.sys.run("/usr/bin/defaults", ["read", dom, key], { timeoutMs: 10_000 }).catch(() => ({ code: 1, stdout: "", stderr: "" }));
    if (r.code === 0 && /^[01]$/.test(r.stdout.trim())) return { on: r.stdout.trim() === "1", managed };
  }
  return undefined;
}
export const PROFILE_FIX = "a configuration profile turns on automatic macOS updates, and taskbox can't change it. Ask whoever manages this Mac to turn it off, or remove the profile in System Settings, General, Device Management.";
export async function macosUpdatesRow(c: CheckContext): Promise<Row> {
  const macos = await suKey(c, "AutomaticallyInstallMacOSUpdates");
  const responses = (await suKey(c, "CriticalUpdateInstall"))?.on !== false || (await suKey(c, "ConfigDataInstall"))?.on !== false;
  const plan = awayOf(c.cfg).restartPlan;
  // With a plan that gets past the FileVault screen, a restart for an update comes back by itself.
  if (macos?.on !== false && (plan === "kvm" || plan === "filevault-off")) return ok("macOS may install its own updates; the restart plan brings the box back");
  if (macos === undefined) return fail(`macOS may install its own updates and restart the box, since it isn't set. ${UPDATE_FIX}`);
  if (macos.on) return fail(macos.managed ? PROFILE_FIX : `macOS installs its own updates, which restarts the box to the FileVault screen. ${UPDATE_FIX}`);
  return ok(`macOS doesn't install its own updates${responses ? '; security responses can still restart it ("Install Security Responses and system files")' : ""}`);
}

// Restart after power loss: on a desktop Mac, pmset's autorestart. With FileVault on, it brings the
// box only to the unlock screen, unless the restart plan gets past it.
export async function powerRestartRow(c: CheckContext): Promise<Row> {
  const r = await c.sys.run("/usr/bin/pmset", ["-g"], { timeoutMs: 10_000 }).catch(() => ({ code: 1, stdout: "", stderr: "" }));
  const v = /^\s*autorestart\s+(\d)/m.exec(r.stdout)?.[1];
  if (r.code !== 0) return skip("pmset couldn't be read");
  if (v === undefined) return skip("this Mac has no such setting");
  if (v !== "1") return fail(`the box stays off after a power cut. ${UPDATE_FIX}`);
  const plan = awayOf(c.cfg).restartPlan;
  return ok(plan === "kvm" || plan === "filevault-off" ? "it starts up again after a power cut" : "it starts up again after a power cut, as far as the FileVault screen");
}

// The owner's restart plan. taskbox.json is the
// owner's own settings, so setting it is a release: the agents make it, then taskbox update.
export const PLAN_STEP = "Tell the agents your plan; they set away.restartPlan in a release. Then, as your admin user, type taskbox update";
export async function restartPlanRow(c: CheckContext): Promise<Row> {
  const plan = awayOf(c.cfg).restartPlan;
  if (!plan) return fail(`no restart plan is set, so a restart waits at the FileVault screen until someone is at the box. ${PLAN_STEP}`);
  if (plan === "kvm") return ok("an IP-KVM types the FileVault password after a restart");
  if (plan === "accept") return ok("accepted: a restart waits at the FileVault screen until someone is at the box");
  // filevault-off: FileVault must be off, and ci must log in by itself, or a restart stops at the login window.
  const fv = await c.sys.run("/usr/bin/fdesetup", ["isactive"], { timeoutMs: 10_000 }).catch(() => ({ code: 1, stdout: "" }));
  if (fv.stdout.trim() === "true") return fail("the plan is FileVault off, but FileVault is on. At the box, as your admin user: System Settings, Privacy & Security, FileVault, turn it off");
  const auto = await c.sys.run("/usr/bin/defaults", ["read", "/Library/Preferences/com.apple.loginwindow", "autoLoginUser"], { timeoutMs: 10_000 }).catch(() => ({ code: 1, stdout: "" }));
  if (auto.code !== 0 || auto.stdout.trim() !== c.paths.service) return fail(`the plan is FileVault off, but ${c.paths.service} doesn't log in by itself, so a restart stops at the login window. At the box, as your admin user: System Settings, Users & Groups, "Automatically log in as": ${c.paths.service}`);
  return ok(`FileVault is off, as the restart plan in taskbox.json chooses, and ${c.paths.service} logs in by itself after a restart`);
}

// In taskbox check (CHECK_EXTRA) and taskbox check --away. The restart plan is in taskbox check --away only: a box
// nobody leaves needs none.
export const AWAY_ROWS: [string, (c: CheckContext) => Promise<Row>][] = [
  ["GitHub", (c) => githubRow(c)],
  ["Loop heartbeat", heartbeatRow],
  ["macOS updates", macosUpdatesRow],
  ["Restart after power loss", powerRestartRow],
];

// v3's rows for leaving: the guard's beat and the key broker's, lasting changes waiting at the box,
// the tailnet name, the power-loss history and the IP-KVM.

// One beat row: the beat's age, or why there is none, and who acts. guardwatch restarts a beat that
// stands still, or a process that never beats, up to its hourly limit; past it, or with no beat
// to judge, someone at the box does.
const AT_BOX_UPDATE = "At the box: as your admin user, type taskbox update";
async function beatRow(c: CheckContext, what: string, label: string, file: string, owner: number | undefined, plistMissing?: string): Promise<Row> {
  const w = watchPaths(c.paths);
  const s = await beatNowOf(c.sys, file, owner, w.record, label, c.rootUid ?? 0);
  if (s.gaveUp) return fail(`${what} doesn't move, and guardwatch has restarted it ${RESTARTS_PER_HOUR} times this hour, so it has stopped. ${AT_BOX_UPDATE}`);
  if ("none" in s) return fail(`${what}: ${s.none}, so nothing shows it moves. Waits by itself: guardwatch restarts a process that doesn't beat within a few minutes. If this stays, ${AT_BOX_UPDATE.replace("At the box", "at the box")}`);
  if (s.age > STALE_MS) return fail(`${what} hasn't moved since ${new Date(s.at).toTimeString().slice(0, 5)}. Waits by itself: guardwatch restarts it within a few minutes. If this stays, ${AT_BOX_UPDATE.replace("At the box", "at the box")}`);
  if (plistMissing && !isFile(plistMissing)) return fail(`${what} beats, but guardwatch, which restarts it when stuck, isn't installed. ${UPDATE_FIX}`);
  return ok(`${what} beat ${Math.round(s.age / 1000)} s ago`);
}

export const guardBeatRow = (c: CheckContext) => beatRow(c, "the guard", GUARD_LABEL, watchPaths(c.paths).guardBeat, c.rootUid ?? 0, watchPaths(c.paths).plist);

export async function brokerBeatRow(c: CheckContext): Promise<Row> {
  const w = watchPaths(c.paths);
  if (!isFile(w.brokerPlist)) return skip("this box has no key broker yet");
  const r = await c.sys.run("/usr/bin/id", ["-u", BROKER_ACCOUNT], { timeoutMs: 5_000 }).catch(() => ({ code: 1, stdout: "" }));
  if (r.code !== 0 || !/^\d+$/.test(r.stdout.trim())) return fail(`the key broker's account isn't on the box, so no VM gets a runner. ${UPDATE_FIX}`);
  return beatRow(c, "the key broker", BROKER_LABEL, w.brokerBeat, Number(r.stdout.trim()));
}

// Lasting changes waiting for confirm at the box, which lapse after 24 hours.
export async function confirmRow(c: CheckContext): Promise<Row> {
  const r = readPending(rootStateOf(c.paths).pending, c.rootUid ?? 0);
  if (r.kind === "missing") return ok("no lasting change waits for confirm");
  if (r.kind !== "ok") return skip("the changes waiting for confirm can't be read");
  const boot = await bootId(c.sys);
  const mono = await monoNow(c.sys);
  const items = lapse(r.value, { wall: c.sys.now(), mono, boot }).state.items;
  if (!items.length) return ok("no lasting change waits for confirm");
  return fail(`${items.length} lasting ${items.length === 1 ? "change waits" : "changes wait"} for confirm, and ${items.length === 1 ? "it lapses" : "each lapses"} 24 hours after it was asked. At the box: as your admin user, type taskbox confirm`);
}

// tailscaled's status through its socket, which lets in root and the service account only.
type TsStatus = { BackendState?: unknown; Self?: { DNSName?: unknown }; CurrentTailnet?: { Name?: unknown }; Peer?: Record<string, { HostName?: unknown; DNSName?: unknown; Online?: unknown; Tags?: unknown }> };
async function tsStatus(c: CheckContext): Promise<TsStatus | string> {
  if (c.uid !== 0 && (c.serviceUid === undefined || c.uid !== c.serviceUid)) return "only the service account can see Tailscale's status";
  const r = await c.sys.run(c.paths.tailscale, [`--socket=${c.paths.tailscaleSocket}`, "status", "--json"], { timeoutMs: 15_000 }).catch(() => ({ code: 1, stdout: "" }));
  try {
    return JSON.parse(r.stdout) as TsStatus;
  } catch {
    return "Tailscale's status couldn't be read";
  }
}
const word = (v: unknown, max = 100) => (typeof v === "string" && /^[A-Za-z0-9.-]{1,253}$/.test(v) ? v.replace(/\.$/, "").slice(0, max) : undefined);

export async function tailnetRow(c: CheckContext): Promise<Row> {
  const st = await tsStatus(c);
  if (typeof st === "string") return skip(st);
  if (st.BackendState !== "Running") return skip("the box's Tailscale isn't running. The Tailscale line says what to do");
  const name = word(st.Self?.DNSName);
  const tailnet = word(st.CurrentTailnet?.Name);
  // The name its settings give it (runnerNamePrefix): the controller and the hold variable use it.
  const want = String(c.cfg.runnerNamePrefix ?? "").toLowerCase();
  if (!name) return fail(`the box has no name in its tailnet, so the controller can't reach it as ${want}. At the box: as your admin user, type taskbox update`);
  if (name.split(".")[0]!.toLowerCase() !== want) return fail(`the box is ${name.split(".")[0]} in its tailnet, but its settings name it ${want}, so the controller and the hourly box check look for the wrong name. ${UPDATE_FIX}`);
  return ok(`the box is ${name}${tailnet ? `, in the tailnet ${tailnet}` : ""}`);
}

// macOS's power log: each shutdown's cause. 5 is a shutdown asked for, 3 a held power button; 0 and
// the negative causes are a power cut or a crash. The last 30 days' unexpected ones are listed, as a
// warning: the box came back, and the UPS row says whether a cable is in.
export const POWER_DAYS = 30;
export function powerLosses(log: string, now: number): number[] {
  const out: number[] = [];
  for (const m of log.matchAll(/^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d [+-]\d{4}) .*Shutdown Cause:?\s*(-?\d+)/gm)) {
    const at = Date.parse(m[1]!.replace(" ", "T").replace(/ ([+-]\d\d)(\d\d)$/, "$1:$2"));
    if (!Number.isFinite(at) || now - at > POWER_DAYS * 86_400_000 || at > now) continue;
    if (m[2] === "5" || m[2] === "3") continue;
    out.push(at);
  }
  return out;
}
export async function powerHistoryRow(c: CheckContext): Promise<Row> {
  const r = await c.sys.run("/usr/bin/pmset", ["-g", "log"], { timeoutMs: 60_000 }).catch(() => ({ code: 1, stdout: "" }));
  if (r.code !== 0) return skip("macOS's power log couldn't be read");
  const lost = powerLosses(r.stdout, c.sys.now());
  if (!lost.length) return ok(`no unexpected shutdown in the last ${POWER_DAYS} days`);
  const days = lost.map((t) => new Date(t).toDateString().slice(4, 10)).slice(-5);
  return { status: "WARN", detail: `${lost.length} unexpected ${lost.length === 1 ? "shutdown" : "shutdowns"} in the last ${POWER_DAYS} days (${days.join(", ")}): a power cut or a crash. Worth a look before leaving: the UPS line says whether one is connected` };
}

// The IP-KVM a kvm restart plan names: online in the box's own tailnet view, with its tag. That the
// tailnet policy lets only the owner reach it is for the owner to check in the admin console, with
// what taskbox policy show prints.
export async function kvmRow(c: CheckContext): Promise<Row> {
  const a = awayOf(c.cfg);
  if (a.restartPlan !== "kvm") return skip("the restart plan uses no KVM");
  if (!a.kvm) return fail(`the restart plan is kvm, but no KVM is named. ${PLAN_STEP.replace("away.restartPlan", "away.kvm (its tailnet name and tag)")}`);
  const st = await tsStatus(c);
  if (typeof st === "string") return skip(st);
  const peer = Object.values(st.Peer ?? {}).find((p) => word(p.HostName)?.toLowerCase() === a.kvm!.tailnetName || word(p.DNSName)?.split(".")[0]?.toLowerCase() === a.kvm!.tailnetName);
  if (!peer) return fail(`the KVM ${a.kvm.tailnetName} isn't in the box's tailnet, so nothing types the FileVault password after a restart. At the box: check the KVM is on and signed in to Tailscale`);
  if (!Array.isArray(peer.Tags) || !peer.Tags.includes(a.kvm.tag)) return fail(`the KVM ${a.kvm.tailnetName} doesn't carry ${a.kvm.tag}, so the tailnet policy's entries for it don't hold. From away: in the Tailscale admin console, give it that tag`);
  if (peer.Online !== true) return fail(`the KVM ${a.kvm.tailnetName} is offline, so nothing types the FileVault password after a restart. At the box: check its power and network`);
  return ok(`the KVM ${a.kvm.tailnetName} is online with ${a.kvm.tag}. Check in the admin console that only you reach it (taskbox policy show)`);
}

const isFile = (p: string) => {
  try {
    return lstatSync(p).isFile();
  } catch {
    return false;
  }
};

// The job source's failed reads in a row, as the loop counts them (sourcefail.ts).
export async function sourceRow(c: CheckContext): Promise<Row> {
  if (sourceOf(c.cfg).type === "none") return skip("the job source is none, so the box follows the jobs its own VMs take");
  const loop = readLoop(c.paths.loopState);
  const n = loop.sourceFailures ?? 0;
  const why = loop.sourceWhy ?? "no reason given";
  if (n >= awayOf(c.cfg).sourceFailures) return fail(`the job source couldn't be read ${n} times in a row (${loop.sourceKind ? `${loop.sourceKind}: ` : ""}${why}), so the box chooses without it. ${sourceNext(loop)}`);
  return ok(n ? `the job source's last read failed (${why}); it is read again each minute` : "the job source's last read saw the queue");
}
