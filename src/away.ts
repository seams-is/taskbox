// `taskbox check --away`: one screen of checks before the owner leaves
// the box for days. Every check row, then the rows that matter only for leaving. Each line is OK,
// FAIL with its fix and where it is done, WARN (worth a look, no reason to stay), or SKIP; the
// screen ends "Ready to leave." or "N things to do before leaving." remote may run it, as it runs check: no row names a user, and rows that need
// ci or root say what the loop last recorded. With --json, one line in a versioned shape, for a
// controller. A later release reuses AWAY_ONLY and awayChecks as they are.
import { confirmRow, kvmRow, powerHistoryRow, restartPlanRow, tailnetRow } from "./awaychecks.ts";
import { upsCheck } from "./ups.ts";
import { type Check, type CheckContext, freeGB, otherLogins, runChecks, screenSharingOn } from "./checks.ts";
import { rows } from "./rows/index.ts";
import { forKind, KIND_WORD, kindsOf } from "./config.ts";
import { awayLoginsDetail, readSeen } from "./logins.ts";
import { footer, UPDATE_FIX } from "./state.ts";
import { type OpsDeps, stateNow } from "./ops.ts";
import { installedCommit, proofHolds, readProof } from "./proof.ts";
import { deployedRow } from "./watchdog.ts";
import { readPull } from "./progress.ts";
import { readLoopState } from "./watch.ts";

export const AWAY_ANSWERS = 1;
type Row = Omit<Check, "name">;
const ok = (detail = ""): Row => ({ status: "OK", detail });
const fail = (detail: string): Row => ({ status: "FAIL", detail });
const skip = (detail: string): Row => ({ status: "SKIP", detail });
const warn = (detail: string): Row => ({ status: "WARN", detail });
export const TAILSCALE_STATUS_ONLY = "only the service account can see Tailscale's status";
const AT_BOX = "At the box, as your admin user:";

async function sleepRow(c: CheckContext): Promise<Row> {
  const r = await c.sys.run("/usr/bin/pmset", ["-g"], { timeoutMs: 10_000 }).catch(() => ({ code: 1, stdout: "" }));
  const v = /^\s*sleep\s+(\d+)/m.exec(r.stdout)?.[1];
  if (v === undefined) return skip("pmset couldn't be read");
  return v === "0" ? ok("the box never sleeps") : fail(`the box sleeps after ${v} minutes, and a box asleep runs no jobs. ${UPDATE_FIX}`);
}

// The default route's interface, and whether macOS calls its port Wi-Fi.
export async function ethernetRow(c: CheckContext): Promise<Row> {
  const route = await c.sys.run("/sbin/route", ["-n", "get", "default"], { timeoutMs: 5_000 }).catch(() => ({ code: 1, stdout: "" }));
  const dev = /interface:\s*(\S+)/.exec(route.stdout)?.[1];
  if (!dev) return fail("the box has no default route, so it has no network. At the box: connect it by Ethernet");
  const ports = await c.sys.run("/usr/sbin/networksetup", ["-listallhardwareports"], { timeoutMs: 10_000 }).catch(() => ({ code: 1, stdout: "" }));
  const port = new RegExp(`Hardware Port: (.+)\\nDevice: ${dev.replace(/[^A-Za-z0-9]/g, "")}\\n`).exec(ports.stdout)?.[1]?.trim();
  if (!port) return skip(`the network runs over ${dev.replace(/[^A-Za-z0-9]/g, "")}, which macOS doesn't name`);
  if (/wi-?fi|airport/i.test(port)) return fail("the network runs over Wi-Fi, which a router change or a weak signal can drop. At the box: connect it by Ethernet");
  return ok(`the network runs over ${port.replace(/[^\x20-\x7e]/g, "").slice(0, 40)}`);
}

async function screenSharingRow(c: CheckContext): Promise<Row> {
  if (!(await screenSharingOn(c.sys))) return ok("Screen Sharing is off");
  return fail(`Screen Sharing is on. If the guard stops while you're away, no VM starts until it's off. ${AT_BOX} System Settings, General, Sharing, turn off Screen Sharing, unless you need it to reach the box's screen`);
}

async function loggedInRow(c: CheckContext): Promise<Row> {
  const others = (await otherLogins(c.sys, c.paths.service).catch(() => [])).length;
  return others ? fail(`${others} other ${others === 1 ? "user is" : "users are"} logged in, and their apps share the box's memory with the VMs. At the box: log ${others === 1 ? "them" : "each"} out`) : ok(`nobody but  is logged in`);
}

// A row, and whether it waits on the loop alone: a download or a proof not run yet, which a hold
// for a workspace stops until it ends.
type Waiting = { row: Row; waitsOnLoop: boolean };

// While a Whole the owner approved holds the box, downloads and the Linux proof wait for it: CI
// paused for it is expected, so a row that waits on them warns, never fails, for that. A row that
// failed for its own reason, such as a failed download or proof, still fails.
function paused(c: CheckContext, w: Waiting, what: string): Row {
  if (w.row.status !== "FAIL" || !w.waitsOnLoop) return w.row;
  const loop = readLoopState(c.paths.loopState);
  if (loop.heldKind !== "workspace" || !loop.heldFor) return w.row;
  return warn(`${loop.heldFor}, so ${what} waits until it ends. Nothing to do: it carries on by itself`);
}

async function imagesRow(c: CheckContext): Promise<Row> {
  return paused(c, imagesNow(c), "the download");
}

function imagesNow(c: CheckContext): Waiting {
  const waiting: string[] = [];
  let failed = false;
  for (const k of kindsOf(c.cfg)) {
    const pull = readPull(k === "linux" ? c.paths.pullLinux : c.paths.pull);
    if (pull?.state !== "ready" || (pull.ref !== undefined && pull.ref !== forKind(c.cfg, k).image)) {
      waiting.push(KIND_WORD[k]);
      if (pull?.state === "failed") failed = true;
    }
  }
  if (!waiting.length) return { row: ok("every kind's image is on the box"), waitsOnLoop: false };
  return { row: fail(`the ${waiting.join(" and ")} ${waiting.length === 1 ? "image isn't" : "images aren't"} on the box yet. Nothing to do: wait for ${waiting.length === 1 ? "its download" : "their downloads"} before leaving (taskbox status -w)`), waitsOnLoop: !failed };
}

// The Linux proof holds while its image and taskbox's install are the ones it proved, whatever its
// age: the loop proves again on a new image or install, or after a failure.
async function proofRow(c: CheckContext): Promise<Row> {
  return paused(c, proofNow(c), "the Linux proof");
}

function proofNow(c: CheckContext): Waiting {
  if (!kindsOf(c.cfg).includes("linux")) return { row: skip("the box runs no Linux VMs"), waitsOnLoop: false };
  const passed = { row: ok("the Linux proof passed for this image and install"), waitsOnLoop: false };
  const asService = c.uid === 0 || c.uid === c.serviceUid;
  if (asService) {
    const p = readProof(c.paths.projectState);
    if (proofHolds(p, forKind(c.cfg, "linux").image, installedCommit(c.paths.installed))) return passed;
    if (p && !p.ok && p.image === forKind(c.cfg, "linux").image) return { row: fail("the Linux proof failed, so Linux jobs wait. Nothing to do: agents fix it"), waitsOnLoop: false };
    return { row: fail("the Linux proof hasn't passed for this image and install yet. Nothing to do: it runs by itself; wait for it before leaving"), waitsOnLoop: true };
  }
  const line = readLoopState(c.paths.loopState).linuxProof;
  if (line?.startsWith("passed: ")) return passed;
  return { row: fail("the Linux proof hasn't passed yet, so Linux jobs wait. Nothing to do: it runs by itself; wait for it before leaving"), waitsOnLoop: !line?.startsWith("FAIL") };
}

async function roomRow(c: CheckContext): Promise<Row> {
  const free = await freeGB(c.sys);
  if (free === undefined) return skip("free disk couldn't be read");
  const biggest = Math.max(0, ...kindsOf(c.cfg).map((k) => forKind(c.cfg, k).imageGB ?? 0));
  const need = c.cfg.minFreeDiskGB + biggest;
  return free >= need ? ok(`${free} GB free, room for a new image (${need} GB)`) : fail(`${free} GB free, and a new image needs ${need} GB. At the box: as ${c.paths.service}, type taskbox prune, or free space`);
}

// The box's own Tailscale key. A tagged node's doesn't expire unless someone set it to.
async function tailscaleKeyRow(c: CheckContext): Promise<Row> {
  // tailscaled's socket lets in root and the service account only (tssocket.ts).
  if (c.uid !== 0 && (c.serviceUid === undefined || c.uid !== c.serviceUid)) return skip(TAILSCALE_STATUS_ONLY);
  const r = await c.sys.run(c.paths.tailscale, [`--socket=${c.paths.tailscaleSocket}`, "status", "--json"], { timeoutMs: 15_000 }).catch(() => ({ code: 1, stdout: "" }));
  let expiry: unknown;
  let backend: unknown;
  try {
    const st = JSON.parse(r.stdout) as { BackendState?: unknown; Self?: { KeyExpiry?: unknown } };
    expiry = st.Self?.KeyExpiry;
    backend = st.BackendState;
  } catch {
    return skip("Tailscale's status couldn't be read");
  }
  // Expiry means something only while the box is signed in and running. The Tailscale line says what
  // else is wrong, so this one doesn't count it twice.
  if (backend !== "Running") return skip(`the box's Tailscale isn't running (${typeof backend === "string" && /^[A-Za-z]{1,20}$/.test(backend) ? backend : "state not known"}), so its key can't be judged. The Tailscale line says what to do`);
  const t = typeof expiry === "string" ? Date.parse(expiry) : NaN;
  if (!Number.isFinite(t)) return ok("the box's Tailscale key doesn't expire");
  const days = Math.floor((t - c.sys.now()) / 86_400_000);
  return days < 30 ? fail(`the box's Tailscale key expires in ${Math.max(0, days)} days, and then nothing reaches it. From away: in the Tailscale admin console, turn off key expiry for the box`) : ok(`the box's Tailscale key expires in ${days} days`);
}

// Tailscale SSH logins to a person's account in the last 7 days (logins.ts). Worth a look, no reason
// to stay: the owner may know them. Counts only, as every user reads them: no account is named.
export async function loginsRow(c: CheckContext): Promise<Row> {
  const r = awayLoginsDetail(readSeen(c.paths), c.sys.now());
  return { status: r.status, detail: r.detail };
}

export const AWAY_ONLY: [string, (c: CheckContext) => Promise<Row>][] = [
  ["Restart plan", restartPlanRow],
  ["UPS", upsCheck],
  ["KVM", kvmRow],
  ["Power losses", powerHistoryRow],
  ["Sleep", sleepRow],
  ["Network", ethernetRow],
  ["Screen Sharing", screenSharingRow],
  ["Logged in", loggedInRow],
  ["Images", imagesRow],
  ["Linux proof", proofRow],
  ["Room for a download", roomRow],
  ["Tailscale key", tailscaleKeyRow],
  ["Tailscale SSH logins", loginsRow],
  ["Tailnet name", tailnetRow],
  ["Waiting for confirm", confirmRow],
  ["Hourly box check", (c) => deployedRow(c, "watchdog")],
  ["Test job", (c) => deployedRow(c, "canary")],
];

// The rows for leaving first, then every check row. Screen Sharing on reads OK while the guard is.
export async function awayChecks(c: CheckContext): Promise<Check[]> {
  return withGuard(await runChecks(rows("away", c), c));
}
export function withGuard(rows: Check[]): Check[] {
  const guard = rows.find((k) => k.name === "Screen Sharing guard");
  return rows.map((k) => (k.name === "Screen Sharing" && k.status === "FAIL" && guard?.status === "OK" ? { ...k, status: "OK", detail: "Screen Sharing is on, and the guard keeps it to Tailscale" } : k));
}

// A FAIL whose fix is "Nothing to do" or "Waits by itself" (an image downloading, agents fixing,
// GitHub's rate limit) isn't one of the owner's things to do, and the verdict lists it apart.
export const waits = (k: Check) => k.status === "FAIL" && /Nothing to do|Waits by itself/.test(k.detail);
export function verdict(checks: Check[]): string {
  const todo = checks.filter((k) => k.status === "FAIL" && !waits(k)).length;
  const wait = checks.filter(waits).map((k) => k.name);
  const warned = checks.filter((k) => k.status === "WARN").map((k) => k.name);
  const waitLine = wait.length ? `Wait for: ${wait.join(", ")}.` : "";
  // A WARN never holds the owner back: the verdict names it after the rest.
  const warnLine = warned.length ? ` Worth a look: ${warned.join(", ")}.` : "";
  if (todo) return `${todo} ${todo === 1 ? "thing" : "things"} to do before leaving.${waitLine ? ` ${waitLine}` : ""}${warnLine}`;
  return (wait.length ? `Ready to leave once these finish: ${wait.join(", ")}.` : "Ready to leave.") + warnLine;
}

// --json: details only for ci and root, as check's.
export function awayAnswer(checks: Check[], details: boolean) {
  return { answers: AWAY_ANSWERS, kind: "away", ready: !checks.some((k) => k.status === "FAIL"), checks: checks.map((k) => ({ name: k.name, status: k.status, ...(details ? { detail: k.detail } : {}) })) };
}

export async function away(c: CheckContext, d: OpsDeps, json = false): Promise<number> {
  const checks = await awayChecks(c);
  const failed = checks.filter((k) => k.status === "FAIL");
  if (json) {
    d.say(JSON.stringify(awayAnswer(checks, d.uid === 0 || d.uid === d.serviceUid)));
    return failed.length ? 1 : 0;
  }
  for (const k of checks) d.say(`${k.status.padEnd(4)} ${k.name}${k.detail ? `: ${k.detail}` : ""}`);
  d.say("");
  d.say(verdict(checks));
  const s = await stateNow(d);
  const first = failed.find((k) => !waits(k)) ?? failed[0];
  for (const l of footer(s, `Ran ${checks.length} checks for leaving.`, first ? `The fix on the ${first.name} line above.` : s.next)) d.say(l);
  return failed.length ? 1 : 0;
}
