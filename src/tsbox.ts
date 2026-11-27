// What key rotate tailscale (tsrotate.ts) does to the box, as root: drains it with what is left
// stopped, counts the service account's VM processes, locks tailscaled's socket (tssocket.ts), and
// restarts, stops and starts tailscaled through launchd. The child of a rotation from the controller
// (keychild.ts) and an admin's rotation at the box (keycmd.ts) both use it.
import { chmodSync, copyFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readOp } from "./core/ops.ts";
import { linkPath } from "./keyops.ts";
import { uidOf } from "./accounts.ts";
import { changeControl, readControl } from "./availability.ts";
import { LAUNCHCTL_MS, type Paths, TAILSCALED_LABEL } from "./config.ts";
import type { RootState } from "./core/paths.ts";
import type { WriteRules } from "./core/rootfile.ts";
import type { Sys } from "./sys.ts";
import { BACKUP_FILE, readTailnetPin, STATE_FILE, tailnetPinPath, type TsBox, tsStatus } from "./tsrotate.ts";
import { dropLock, keepSocket, LOCK_MAX_MS, lockPath, lockSocket, newSocketMemory, readLock, writeLock } from "./tssocket.ts";
import { vmsOf } from "./workspace/fence.ts";

export interface TsBoxDeps {
  sys: Sys;
  p: Pick<Paths, "service" | "tailscaleSocket" | "tailscaleSocketDir" | "tailscaleState" | "tailscaledPlist">;
  state: Pick<RootState, "dir" | "control" | "ops">;
  rootUid: number;
  chown?: WriteRules["chown"];
  op: string;
  // Events the availability change writes, through the rotation's own reports.
  event(type: string, text: string): void;
  log(line: string): void;
}

export function tsBox(d: TsBoxDeps): TsBox {
  const actor = `key rotate tailscale ${d.op}`;
  const ctl = { sys: d.sys, state: d.state, rootUid: d.rootUid, ...(d.chown ? { chown: d.chown } : {}), events: { write: (e: { type: string; text: string }) => (d.event(e.type, e.text), e) as never }, log: d.log };
  let before: string | undefined;
  const launchctl = async (args: string[]) => {
    const r = await d.sys.run("/bin/launchctl", args, { timeoutMs: LAUNCHCTL_MS }).catch((e: Error) => ({ code: -1, stdout: "", stderr: String(e?.message ?? e) }));
    return r.code === 0 ? undefined : (r.stderr.replace(/[^\x20-\x7e]/g, " ").trim().slice(0, 120) || `launchctl exit ${r.code}`);
  };
  const lock = lockPath(d.state.dir);
  return {
    stateFile: join(d.p.tailscaleState, STATE_FILE),
    async drain() {
      const c = readControl(d.state.control, d.rootUid);
      before = c.kind === "ok" ? c.value.availability : "active";
      if (before === "stopped" || before === "drained") return undefined;
      const r = await changeControl(ctl, { kind: "drain", actor, reason: actor, force: true, timeout: "1s", timeoutMs: 1000 });
      return r.ok ? undefined : r.said;
    },
    async vmsGone() {
      const uid = await uidOf(d.sys, d.p.service).catch(() => undefined);
      return (await vmsOf(d.sys, uid)) === 0;
    },
    async resume() {
      if (before === undefined || before === "drained" || before === "stopped") return;
      const r = await changeControl(ctl, { kind: "resume", actor });
      if (!r.ok) d.log(`the box couldn't be resumed after the rotation: ${r.said}`);
      if (before === "paused") await changeControl(ctl, { kind: "pause", actor, reason: "paused before the rotation" });
    },
    async lock() {
      writeLock(lock, { op: d.op, until: d.sys.now() + LOCK_MAX_MS }, { rootUid: d.rootUid, ...(d.chown ? { chown: d.chown } : {}) });
      return lockSocket(d.sys, d.p, d.rootUid);
    },
    async unlock() {
      dropLock(lock);
      const why = await keepSocket(d.sys, d.p, newSocketMemory(), d.rootUid).catch((e: Error) => String(e?.message ?? e));
      if (why) d.log(`tailscaled's socket wasn't opened to the service again: ${why}. The guard tries again each pass.`);
    },
    restart: () => launchctl(["kickstart", "-k", `system/${TAILSCALED_LABEL}`]),
    stop: () => launchctl(["bootout", `system/${TAILSCALED_LABEL}`]),
    async start() {
      let why: string | undefined = "not tried";
      for (let i = 0; i < 5 && why; i++) {
        if (i) await d.sys.sleep(2000);
        why = await launchctl(["bootstrap", "system", d.p.tailscaledPlist]);
      }
      return why;
    },
  };
}

// The guard's part, each pass: a rotation whose op ended (cancelled, past its time, or its child
// gone) while it held the lock is settled here. The lock goes; the old sign-in is put back from the
// copy when Tailscale isn't running on the pinned tailnet; the copy and the link file go; and the box
// is resumed when the rotation's drain is what holds it. A live rotation is left alone.
export async function settleTsRotation(d: Omit<TsBoxDeps, "op" | "event"> & { p: TsBoxDeps["p"] & Pick<Paths, "tailscale">; events: { write(e: { type: string; actor: string; subject: string; text: string; op?: string }): unknown } }): Promise<string | undefined> {
  const file = lockPath(d.state.dir);
  const lock = readLock(file, d.rootUid, d.sys.now(), true);
  if (!lock) return undefined;
  const r = readOp({ dir: d.state.ops, owner: d.rootUid }, lock.op);
  if (r.kind === "ok" && r.value.state === "running" && lock.until > d.sys.now()) return undefined;
  const say: string[] = [];
  const box = tsBox({ ...d, op: lock.op, event: (type, text) => void d.events.write({ type, text, actor: "taskbox", subject: "box", op: lock.op }), log: (l) => void say.push(l) });
  const copy = join(d.p.tailscaleState, BACKUP_FILE);
  const pin = readTailnetPin(tailnetPinPath(d.state.dir), d.rootUid);
  const st = await tsStatus({ sys: d.sys, tailscale: d.p.tailscale, socket: d.p.tailscaleSocket });
  if (existsSync(copy) && !(st?.state === "Running" && pin !== undefined && st.tailnet === pin)) {
    if (st?.state === "Running" && st.tailnet && st.tailnet !== pin) await d.sys.run(d.p.tailscale, [`--socket=${d.p.tailscaleSocket}`, "logout"], { timeoutMs: 20_000 }).catch(() => undefined);
    const stopped = await box.stop();
    if (!stopped) {
      try {
        copyFileSync(copy, box.stateFile);
        chmodSync(box.stateFile, 0o600);
      } catch {}
    }
    const started = await box.start();
    d.events.write({ type: "key.kept", actor: "taskbox", subject: "box", op: lock.op, text: stopped || started ? "The Tailscale rotation ended unfinished, and its old sign-in couldn't be put back. An admin at the box is needed: taskbox update there." : "The Tailscale rotation ended unfinished, so the guard put back the box's old sign-in." });
  }
  rmSync(copy, { force: true });
  rmSync(linkPath(d.state.dir), { force: true });
  dropLock(file);
  const c = readControl(d.state.control, d.rootUid);
  if (c.kind === "ok" && c.value.actor === `key rotate tailscale ${lock.op}` && (c.value.availability === "drained" || c.value.availability === "draining")) await changeControl({ sys: d.sys, state: d.state, rootUid: d.rootUid, ...(d.chown ? { chown: d.chown } : {}), events: d.events as never, log: d.log }, { kind: "resume", actor: "taskbox" });
  return `settled the Tailscale rotation ${lock.op}${say.length ? `: ${say.join("; ")}` : ""}`;
}
