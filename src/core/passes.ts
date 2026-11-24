// The guard-pass registry. The guard reads pf every 2 s (guard.ts guardWatch); everything else it
// does is a pass beside that tick: the workspaces, the loop's watch, the logins record, tailscaled's
// watch, and what later packages add (the control pass, guardwatch's beat). A package that adds a pass
// adds a file of passes (src/passes/) and one line in src/passes/index.ts, and never edits guard.ts.
//
// Each pass runs one at a time and is never awaited by the tick, so a slow or failing pass never holds
// up pf. A pass says when it first runs (before the guard's first pf pass, after it, or on the first
// tick) and, on each tick, whether it runs now.
import type { Config, Paths } from "../config.ts";
import type { Log } from "../log.ts";
import type { Sys } from "../sys.ts";

export type Job = () => Promise<unknown>;

export interface GuardPass {
  name: string;
  at: "before" | "after" | "tick";
  // The job to run at its start (for at "before" and "after"), with the time.
  start?(now: number): Job | undefined;
  // Called on every tick, running or not, so a pass keeps its own time; its job runs only when the
  // pass isn't running.
  next(now: number, running: boolean): Job | undefined;
}

export interface PassCtx {
  sys: Sys;
  cfg: Config;
  p: Paths;
  log: Pick<Log, "write">;
  writer: boolean; // the guard under its current label, the one writer of root's state
  rootUid?: number; // root's uid, 0 but in tests
  ws?: () => Promise<unknown>; // cli.ts's workspace pass, chosen by the guard's label
}

export interface PassMaker {
  name: string;
  make(c: PassCtx): GuardPass | undefined; // undefined: this guard doesn't run it
}

export class Passes {
  private running = new Map<string, Promise<unknown>>();
  constructor(
    private list: readonly GuardPass[],
    private clock: Pick<Sys, "now">,
  ) {
    const names = list.map((p) => p.name);
    if (new Set(names).size !== names.length) throw new Error("two guard passes share a name");
  }
  private run(p: GuardPass, job: Job | undefined): void {
    if (!job || this.running.has(p.name)) return;
    try {
      this.running.set(
        p.name,
        Promise.resolve(job())
          .catch(() => undefined)
          .finally(() => this.running.delete(p.name)),
      );
    } catch {
      this.running.delete(p.name);
    }
  }
  // The passes that start at this stage.
  begin(stage: "before" | "after"): void {
    for (const p of this.list) if (p.at === stage) this.run(p, p.start?.(this.clock.now()));
  }
  tick(): void {
    const now = this.clock.now();
    for (const p of this.list) {
      const job = p.next(now, this.running.has(p.name));
      this.run(p, job);
    }
  }
  // For tests and a clean stop: every pass running now, ended.
  async settle(): Promise<void> {
    await Promise.all([...this.running.values()]);
  }
  get names(): string[] {
    return this.list.map((p) => p.name);
  }
}

// A pass that runs every ms, first at its stage.
export function everyPass(name: string, at: "before" | "after", ms: number, job: Job): GuardPass {
  let last = 0;
  return {
    name,
    at,
    start(now) {
      last = now;
      return job;
    },
    next(now) {
      if (now - last < ms) return undefined;
      last = now;
      return job;
    },
  };
}
