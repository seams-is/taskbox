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

// The passes the makers give. A maker that throws leaves its pass out, and says so, so one bad pass
// never stops the guard before its first pf pass.
// problems: what failed, by pass name, for the guard's record and the "Guard passes" check row.
export function makePasses(makers: readonly PassMaker[], c: PassCtx, log: (line: string) => void, problems: Map<string, string> = new Map()): GuardPass[] {
  const out: GuardPass[] = [];
  for (const m of makers) {
    try {
      const p = m.make(c);
      if (p) out.push(p);
    } catch (e) {
      const why = `the ${m.name} pass couldn't start: ${String((e as Error)?.message ?? e).slice(0, 120)}`;
      log(why);
      problems.set(m.name, why);
    }
  }
  return out;
}

export class Passes {
  private running = new Map<string, Promise<unknown>>();
  private counts = new Map<string, number>(); // failures in a row, by pass
  constructor(
    private list: readonly GuardPass[],
    private clock: Pick<Sys, "now">,
    private log: (line: string) => void = () => {},
    private failed: Map<string, string> = new Map(),
  ) {
    const names = list.map((p) => p.name);
    if (new Set(names).size !== names.length) throw new Error("two guard passes share a name");
  }
  private run(p: GuardPass, job: Job | undefined): void {
    if (!job || this.running.has(p.name)) return;
    // A job that rejects or throws is a failure like any other: logged once, counted, kept in
    // problems() until a job of that pass works again.
    let promise: Promise<unknown>;
    try {
      promise = Promise.resolve(job());
    } catch (e) {
      promise = Promise.reject(e);
    }
    this.running.set(
      p.name,
      promise
        .then(
          () => this.cleared(p.name),
          (e) => this.failure(p.name, e),
        )
        .finally(() => this.running.delete(p.name)),
    );
  }
  private failure(name: string, e: unknown): void {
    const why = String((e as Error)?.message ?? e).replace(/[^\x20-\x7e]/g, " ").slice(0, 120);
    const was = this.counts.get(name) ?? 0;
    if (!was) this.log(`the ${name} pass failed: ${why}`);
    this.counts.set(name, was + 1);
    this.failed.set(name, `the ${name} pass failed${was ? ` ${was + 1} times` : ""}: ${why}`);
  }
  private cleared(name: string): void {
    if (!this.counts.has(name)) return;
    this.counts.delete(name);
    this.failed.delete(name);
  }
  // The passes that start at this stage.
  begin(stage: "before" | "after"): void {
    for (const p of this.list) if (p.at === stage) this.run(p, this.ask(p, () => p.start?.(this.clock.now())));
  }
  tick(): void {
    const now = this.clock.now();
    for (const p of this.list) this.run(p, this.ask(p, () => p.next(now, this.running.has(p.name))));
  }
  // A pass's start or next that throws is logged, and that pass skips this turn; the others run.
  // A pass's start or next that throws counts as a failure of that pass, and it skips this turn.
  private ask(p: GuardPass, f: () => Job | undefined): Job | undefined {
    try {
      return f();
    } catch (e) {
      this.failure(p.name, e);
      return undefined;
    }
  }
  // What is wrong with the passes now: one line each, for the guard's record.
  problems(): string[] {
    return [...this.failed.values()];
  }
  // The same, by pass name, so a problem is told once per pass, whatever its line says each time.
  problemsByPass(): Map<string, string> {
    return new Map(this.failed);
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
