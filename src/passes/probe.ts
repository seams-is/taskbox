// tailscaled's liveness, each minute (counted in ticks): `tailscale status --json` through the
// socket, with a 5 s limit. Only what a restart can fix restarts it: no answer from the socket, or a
// backend stuck starting, PROBE_FAILURES times in a row, at most once in PROBE_GAP_MS on the
// monotonic clock across guard restarts (root's record), never during a Tailscale re-auth, and only
// while tailscaled is loaded. A needed login, a stopped backend or a control server that doesn't see
// the box is reported once, as guard.tailscaled-unwell, and left alone. By the one writer only.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { LAUNCHCTL_MS, TAILSCALED_LABEL } from "../config.ts";
import { bootId, isBootId, monoNow } from "../core/boot.ts";
import { eventLog } from "../core/events.ts";
import { listOps } from "../core/ops.ts";
import type { PassMaker } from "../core/passes.ts";
import { rootStateOf } from "../core/paths.ts";
import { isObj, readOwnedJson, writeOwnedText } from "../core/rootfile.ts";
import { GUARD_FULL_MS, GUARD_TICK_MS } from "../guard.ts";

export const PROBE_FAILURES = 3;
export const PROBE_GAP_MS = 15 * 60_000;
export const PROBE_TIMEOUT_MS = 5_000;

// What one probe found: fine, stuck (a restart may fix it), or unwell (a restart can't).
export type Probe = { is: "fine" } | { is: "stuck" | "unwell"; why: string };
export function probeOf(code: number, stdout: string): Probe {
  if (code !== 0) return { is: "stuck", why: `tailscale status exited ${code}` };
  let st: { BackendState?: unknown; Self?: { Online?: unknown } };
  try {
    st = JSON.parse(stdout);
  } catch {
    return { is: "stuck", why: "its status couldn't be read" };
  }
  const state = typeof st.BackendState === "string" && /^[A-Za-z]{1,20}$/.test(st.BackendState) ? st.BackendState : "not known";
  if (state === "Starting" || state === "NoState") return { is: "stuck", why: `its state is ${state}` };
  if (state !== "Running") return { is: "unwell", why: state === "NeedsLogin" || state === "NeedsMachineAuth" ? `it needs a login (${state}). From away: type taskbox key rotate tailscale` : `its state is ${state}` };
  if (st.Self?.Online !== true) return { is: "unwell", why: "Tailscale's control server doesn't see the box online, which a restart can't change" };
  return { is: "fine" };
}

// A key rotation that re-authenticates Tailscale, running now (key rotate tailscale).
export function reauthRunning(ops: { type: string; state: string; subject: string; params: Record<string, unknown> }[]): boolean {
  return ops.some((o) => o.state === "running" && o.type === "key-rotate" && (o.subject === "tailscale" || o.params.key === "tailscale" || o.params.which === "tailscale"));
}

export const probeRecord = (p: { guardState: string }) => join(dirname(p.guardState), "taskbox-tailscaled-restart.json");

export const probePass: PassMaker = {
  name: "tailscaled-probe",
  make(c) {
    if (!c.writer) return undefined;
    const s = rootStateOf(c.p);
    const root = c.rootUid ?? 0;
    const events = eventLog("guard", { dir: s.events, owner: root }, c.sys);
    const record = probeRecord(c.p);
    let ticks = 0;
    let stuck = 0;
    let told = "";
    const job = async () => {
      if (!existsSync(c.p.tailscaledPlist)) return void (stuck = 0);
      const loaded = await c.sys.run("/bin/launchctl", ["print", `system/${TAILSCALED_LABEL}`], { timeoutMs: LAUNCHCTL_MS }).catch(() => ({ code: 1 }));
      if (loaded.code !== 0) return void (stuck = 0);
      const r = await c.sys.run(c.p.tailscale, [`--socket=${c.p.tailscaleSocket}`, "status", "--json"], { timeoutMs: PROBE_TIMEOUT_MS }).catch(() => ({ code: 1, stdout: "" }));
      const probe = probeOf(r.code, r.stdout);
      const now = probe.is === "unwell" ? probe.why : "";
      if (now !== told) {
        told = now;
        c.log.write(now ? `tailscaled is unwell, and a restart can't fix it: ${now}.` : "tailscaled answers as it should.");
        if (now)
          try {
            events.write({ type: "guard.tailscaled-unwell", actor: "taskbox", text: `tailscaled is unwell: ${now}.` });
          } catch {}
      }
      if (probe.is !== "stuck") return void (stuck = 0);
      stuck += 1;
      if (stuck < PROBE_FAILURES) return;
      const boot = await bootId(c.sys);
      const mono = await monoNow(c.sys);
      // With no monotonic clock the 15 minutes can't be kept, so nothing is restarted.
      if (!boot || mono === undefined) return;
      const last = readOwnedJson(record, { owner: root, max: 256 }, (v) => (isObj(v) && isBootId(v.boot) && Number.isSafeInteger(v.mono) ? { boot: v.boot, mono: v.mono as number } : "out of shape"));
      if (last.kind === "ok" && last.value.boot === boot && mono - last.value.mono >= 0 && mono - last.value.mono < PROBE_GAP_MS) return;
      if (reauthRunning(listOps({ dir: s.ops, owner: root }).ops)) return;
      writeOwnedText(record, JSON.stringify({ boot, mono }), { mode: 0o644, owner: root });
      const k = await c.sys.run("/bin/launchctl", ["kickstart", "-k", `system/${TAILSCALED_LABEL}`], { timeoutMs: LAUNCHCTL_MS }).catch(() => ({ code: 1 }));
      const text = `tailscaled failed ${stuck} probes in a row (${probe.why}), so the guard restarted it${k.code === 0 ? "" : `, but launchctl refused (exit ${k.code})`}.`;
      c.log.write(text);
      stuck = 0;
      try {
        events.write({ type: "guard.tailscaled-restarted", actor: "taskbox", text });
      } catch {}
    };
    return {
      name: "tailscaled-probe",
      at: "after",
      next() {
        ticks += 1;
        // guard.ts imports this registry, so its constants are read when the pass runs.
        if (ticks < GUARD_FULL_MS / GUARD_TICK_MS) return undefined;
        ticks = 0;
        return job;
      },
    };
  },
};
