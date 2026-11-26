// tailscaled's liveness, the guard's pass beside the v2 one that loads a tailscaled left unloaded:
// each minute it asks `tailscale status --json` through the socket, with a 5 s limit, and checks the
// backend is Running and the box is online in its own view. After PROBE_FAILURES in a row it
// restarts tailscaled with kickstart -k, at most once in PROBE_GAP_MS on the monotonic clock, and
// writes guard.tailscaled-restarted. Never while a key rotation's re-auth of Tailscale runs, nor
// while tailscaled isn't loaded. Minutes are counted in ticks, so no clock step moves them. By the
// one writer only.
import { existsSync } from "node:fs";
import { LAUNCHCTL_MS, TAILSCALED_LABEL } from "../config.ts";
import { monoNow } from "../core/boot.ts";
import { eventLog } from "../core/events.ts";
import { listOps } from "../core/ops.ts";
import type { PassMaker } from "../core/passes.ts";
import { rootStateOf } from "../core/paths.ts";
import { GUARD_FULL_MS, GUARD_TICK_MS } from "../guard.ts";

export const PROBE_FAILURES = 3;
export const PROBE_GAP_MS = 15 * 60_000;
export const PROBE_TIMEOUT_MS = 5_000;

// Whether tailscaled answers as a box online in its tailnet: why not, or undefined when it does.
export function probeProblem(code: number, stdout: string): string | undefined {
  if (code !== 0) return `tailscale status exited ${code}`;
  try {
    const st = JSON.parse(stdout) as { BackendState?: unknown; Self?: { Online?: unknown } };
    if (st.BackendState !== "Running") return `its state is ${typeof st.BackendState === "string" && /^[A-Za-z]{1,20}$/.test(st.BackendState) ? st.BackendState : "not known"}`;
    if (st.Self?.Online !== true) return "it doesn't see the box online";
    return undefined;
  } catch {
    return "its status couldn't be read";
  }
}

// A key rotation that re-authenticates Tailscale, running now (key rotate tailscale).
export function reauthRunning(ops: { type: string; state: string; subject: string; params: Record<string, unknown> }[]): boolean {
  return ops.some((o) => o.state === "running" && o.type === "key-rotate" && (o.subject === "tailscale" || o.params.key === "tailscale" || o.params.which === "tailscale"));
}

export const probePass: PassMaker = {
  name: "tailscaled-probe",
  make(c) {
    if (!c.writer) return undefined;
    const s = rootStateOf(c.p);
    const root = c.rootUid ?? 0;
    const events = eventLog("guard", { dir: s.events, owner: root }, c.sys);
    let ticks = 0;
    let failures = 0;
    let restartedAt: number | undefined; // mono
    const job = async () => {
      if (!existsSync(c.p.tailscaledPlist)) return void (failures = 0);
      const loaded = await c.sys.run("/bin/launchctl", ["print", `system/${TAILSCALED_LABEL}`], { timeoutMs: LAUNCHCTL_MS }).catch(() => ({ code: 1 }));
      // Not loaded is the v2 pass's to put right; this one judges a loaded tailscaled only.
      if (loaded.code !== 0) return void (failures = 0);
      const r = await c.sys.run(c.p.tailscale, [`--socket=${c.p.tailscaleSocket}`, "status", "--json"], { timeoutMs: PROBE_TIMEOUT_MS }).catch(() => ({ code: 1, stdout: "" }));
      const why = probeProblem(r.code, r.stdout);
      if (!why) {
        if (failures >= PROBE_FAILURES) c.log.write("tailscaled answers again.");
        failures = 0;
        return;
      }
      failures += 1;
      if (failures < PROBE_FAILURES) return;
      const mono = await monoNow(c.sys);
      // With no monotonic clock the 15 minutes can't be kept, so nothing is restarted.
      if (mono === undefined) return;
      if (restartedAt !== undefined && mono - restartedAt >= 0 && mono - restartedAt < PROBE_GAP_MS) return;
      if (reauthRunning(listOps({ dir: s.ops, owner: root }).ops)) return;
      const k = await c.sys.run("/bin/launchctl", ["kickstart", "-k", `system/${TAILSCALED_LABEL}`], { timeoutMs: LAUNCHCTL_MS }).catch(() => ({ code: 1 }));
      restartedAt = mono;
      const text = `tailscaled failed ${failures} probes in a row (${why}), so the guard restarted it${k.code === 0 ? "" : `, but launchctl refused (exit ${k.code})`}.`;
      c.log.write(text);
      failures = 0;
      try {
        events.write({ type: "guard.tailscaled-restarted", actor: "taskbox", text });
      } catch {}
    };
    return {
      name: "tailscaled-probe",
      at: "after",
      next() {
        ticks += 1;
        // Read here, not at load: guard.ts imports the pass registry.
        if (ticks < GUARD_FULL_MS / GUARD_TICK_MS) return undefined;
        ticks = 0;
        return job;
      },
    };
  },
};
