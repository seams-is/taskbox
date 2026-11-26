// A loop frozen while ending on purpose. The loop's ending marker carries until, the latest it
// should take (loop.ts markEnding); loopwatch.ts leaves an ending loop alone, so this pass is what
// ends one that never does. Past until plus ENDING_GRACE_MS, counted on the monotonic clock from the
// pass that first saw the marker, the guard sends the loop SIGTERM through launchd, then SIGKILL
// after ENDING_KILL_MS if the same process still runs, and writes guard.loop-forced-end with the op
// that asked, so that op records it and carries on. Once per marker. By the one writer only.
//
// It acts on one label, AGENT_LABEL, in the service account's own launchd domain. The loop's state
// is the service account's file: what it can make this pass do is end its own loop, which it can do
// anyway.
import { AGENT_LABEL, LAUNCHCTL_MS } from "../config.ts";
import { monoNow } from "../core/boot.ts";
import { eventLog } from "../core/events.ts";
import { isId } from "../core/ids.ts";
import type { PassMaker } from "../core/passes.ts";
import { rootStateOf } from "../core/paths.ts";
import { GUARD_FULL_MS, GUARD_TICK_MS } from "../guard.ts";
import { readOwnedJson, runningNow } from "../loopwatch.ts";
import { loopFrom } from "../watch.ts";

export const ENDING_GRACE_MS = 5 * 60_000;
export const ENDING_KILL_MS = 30_000;

export const endingPass: PassMaker = {
  name: "ending-loop",
  make(c) {
    if (!c.writer) return undefined;
    const s = rootStateOf(c.p);
    const root = c.rootUid ?? 0;
    const events = eventLog("guard", { dir: s.events, owner: root }, c.sys);
    let ticks = 0;
    let marker: string | undefined; // the marker seen, by its endingAt
    let firstSeen = 0; // mono
    let done = false;
    const job = async () => {
      const id = await c.sys.run("/usr/bin/id", ["-u", c.p.service], { timeoutMs: 5_000 }).catch(() => ({ code: 1, stdout: "" }));
      const ci = Number(id.stdout.trim());
      if (id.code !== 0 || !Number.isSafeInteger(ci) || ci <= 0) return;
      const loop = loopFrom(readOwnedJson(c.p.loopState, ci));
      if (loop.endingAt === undefined || loop.endingUntil === undefined) return void (marker = undefined);
      const mono = await monoNow(c.sys);
      if (mono === undefined) return;
      const key = String(loop.endingAt);
      if (marker !== key) {
        marker = key;
        firstSeen = mono;
        done = false;
      }
      const lasts = Math.max(0, loop.endingUntil - loop.endingAt) + ENDING_GRACE_MS;
      if (done || mono - firstSeen <= lasts) return;
      const target = `gui/${ci}/${AGENT_LABEL}`;
      const pidOf = async () => {
        const p = await c.sys.run("/bin/launchctl", ["print", target], { timeoutMs: LAUNCHCTL_MS }).catch(() => ({ code: 1, stdout: "" }));
        return p.code === 0 && runningNow(p.stdout) ? /^\tpid = (\d+)$/m.exec(p.stdout)?.[1] : undefined;
      };
      const pid = await pidOf();
      done = true;
      if (!pid) return;
      await c.sys.run("/bin/launchctl", ["kill", "SIGTERM", target], { timeoutMs: LAUNCHCTL_MS }).catch(() => undefined);
      await c.sys.sleep(ENDING_KILL_MS);
      const killed = (await pidOf()) === pid;
      if (killed) await c.sys.run("/bin/launchctl", ["kill", "SIGKILL", target], { timeoutMs: LAUNCHCTL_MS }).catch(() => undefined);
      const text = `The loop was ending and hadn't ended ${Math.round((mono - firstSeen) / 60_000)} min after the guard first saw it, so the guard ended it${killed ? " with SIGKILL" : ""}: the loop was forced to end.`;
      c.log.write(text);
      try {
        events.write({ type: "guard.loop-forced-end", actor: "taskbox", text, ...(isId("op", loop.endingOp) ? { op: loop.endingOp } : {}) });
      } catch {}
    };
    return {
      name: "ending-loop",
      at: "after",
      next() {
        ticks += 1;
        if (ticks < GUARD_FULL_MS / GUARD_TICK_MS) return undefined;
        ticks = 0;
        return job;
      },
    };
  },
};
