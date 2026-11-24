// The guard's passes from v2, moved onto the registry as they were: the workspaces pass every tick,
// first before the guard's first pf pass; the loop's watch every full pass; the Tailscale SSH logins
// record every full pass, and sooner once tailscaled's log grows fast; tailscaled's watch every tick.
import { everyPass, type GuardPass, type PassMaker } from "../core/passes.ts";
import { GUARD_FULL_MS, settler, tailscaledWatch, workspaceRunner } from "../guard.ts";
import { FAST_GROWTH, LoginsKeeper } from "../logins.ts";
import { newLoopWatch, watchLoop } from "../loopwatch.ts";

export const workspacesPass: PassMaker = {
  name: "workspaces",
  make(c) {
    const run = c.ws ?? workspaceRunner({ sys: c.sys, cfg: c.cfg, p: c.p }, c.log);
    return { name: "workspaces", at: "before", start: () => run, next: () => run };
  },
};

export const loopWatchPass: PassMaker = {
  name: "loop-watch",
  make(c) {
    const lw = newLoopWatch();
    const settle = settler(c.sys, c.p, c.log);
    return everyPass("loop-watch", "after", GUARD_FULL_MS, () =>
      settle()
        .catch(() => undefined)
        .then(() => watchLoop(c.sys, c.p, lw))
        .then((did) => did && c.log.write(did))
        .catch(() => undefined),
    );
  },
};

export const loginsPass: PassMaker = {
  name: "logins",
  make(c): GuardPass {
    const keeper = new LoginsKeeper(c.sys, c.p, c.cfg);
    let err: string | undefined;
    let keptAt = 0;
    const job = (minute: boolean) => () =>
      keeper.pass(c.sys.now(), minute).then(
        (r) => {
          if (r.said) c.log.write(r.said);
          err = undefined;
        },
        (e: unknown) => {
          // Said once until a pass works again, rather than every minute.
          const why = `couldn't keep the record of Tailscale SSH logins: ${String((e as Error)?.message ?? e).slice(0, 120)}`;
          if (why !== err) c.log.write(why);
          err = why;
        },
      );
    return {
      name: "logins",
      at: "after",
      start(now) {
        keptAt = now;
        return job(true);
      },
      next(now, running) {
        if (now - keptAt >= GUARD_FULL_MS) {
          keptAt = now;
          return job(true);
        }
        if (!running && keeper.growth() >= FAST_GROWTH) return job(false);
        return undefined;
      },
    };
  },
};

export const tailscaledPass: PassMaker = {
  name: "tailscaled",
  make(c) {
    const run = tailscaledWatch(c.sys, c.p, c.log);
    return { name: "tailscaled", at: "tick", next: () => run };
  },
};

export const v2Passes = (): PassMaker[] => [workspacesPass, loopWatchPass, loginsPass, tailscaledPass];
