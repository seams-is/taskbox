// v2.5.0 away-ready check rows. Each is its own function, run by
// `taskbox check` (CHECK_EXTRA) and by `taskbox check --away`, never before a VM. Every row says what to do
// and where: at the box, from away, or nothing. Rows that need ci or root show, for anyone else, the
// loop's last recorded result, and never name a user.
import { readFileSync } from "node:fs";
import { beatState } from "./beat.ts";
import type { Check, CheckContext } from "./checks.ts";
import { awayOf } from "./config.ts";
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
  return ok(`FileVault is off by the owner's choice, and ${c.paths.service} logs in by itself after a restart`);
}

// In taskbox check (CHECK_EXTRA) and taskbox check --away. The restart plan is in taskbox check --away only: a box
// nobody leaves needs none.
export const AWAY_ROWS: [string, (c: CheckContext) => Promise<Row>][] = [
  ["GitHub", (c) => githubRow(c)],
  ["Loop heartbeat", heartbeatRow],
  ["macOS updates", macosUpdatesRow],
  ["Restart after power loss", powerRestartRow],
];
