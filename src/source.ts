// Job sources (v2.4.0, docs/scheduling-design.md section 1): what is waiting, as plain items the
// scheduler ranks. A source never decides priority; it reports, and the classes rank (classes.ts).
// Two adapters: GitHub Actions, read as a read-only App the owner makes (queue.ts), and none, which
// always answers that it can't see the queue, so the scheduler follows the jobs its own VMs take.
import { type Config, sourceOf } from "./config.ts";
import { queueWhy } from "./queue.ts";

export interface WaitingItem {
  key: string; // opaque, stable while it waits
  labels: string[]; // what it asks a runner for, less the labels every runner has
  queuedAt: number;
  // What the source vouches for: GitHub's run event, which a workflow can't set. trusted false: the
  // source said nothing, so no class that needs an event matches it.
  origin: { event?: string; trusted: boolean };
  // A label out of shape, or too many: the job fits no kind.
  odd?: boolean;
  // v2.6.0: a job from the load test's repo. Absent: the real repo's.
  role?: "load";
  repo?: string;
}

export type Snapshot = { known: true; at: number; items: WaitingItem[] } | { known: false; at: number; why: string };

export interface JobSource {
  readonly id: string;
  read(now: number): Promise<Snapshot>;
  reads?(): number | undefined; // GETs so far, for the load test's report (v2.6.0)
  loadProblem?(): string | undefined; // why the test repo couldn't be read, if it couldn't (v2.6.0)
}

// What the GitHub adapter needs from the reader: each waiting job as an item.
export interface ItemReader {
  items(): Promise<WaitingItem[]>;
  reads?: number;
  loadProblem?: string;
}

export class NoSource implements JobSource {
  readonly id = "none";
  constructor(private why = "no job source is set") {}
  async read(now: number): Promise<Snapshot> {
    return { known: false, at: now, why: this.why };
  }
}

// Read at most once every pollMs, whichever slot asks, so more slots cost the source no more reads.
// A read that fails is an answer too: unknown, with why, and the next ask reads again.
export class GitHubActionsSource implements JobSource {
  readonly id = "github-actions";
  private last?: { at: number; p: Promise<Snapshot> };
  // A read still running is the answer for every ask, so two never share the reader's ETags.
  private pending = false;
  constructor(
    private reader: ItemReader,
    private pollMs: number,
  ) {}
  loadProblem(): string | undefined {
    return this.reader.loadProblem;
  }
  reads(): number | undefined {
    return this.reader.reads;
  }
  read(now: number): Promise<Snapshot> {
    if (this.last && (this.pending || now - this.last.at < this.pollMs)) return this.last.p;
    this.pending = true;
    const p = this.reader.items().finally(() => (this.pending = false)).then(
      (items): Snapshot => ({ known: true, at: now, items }),
      // A failed read is kept for four polls, so an outage or a refusal isn't read again at every ask.
      (e): Snapshot => {
        if (this.last) this.last.at = now + 3 * this.pollMs;
        return { known: false, at: now, why: queueWhy(e) };
      },
    );
    this.last = { at: now, p };
    return p;
  }
}

// The source for this box: the reader, or the reason there is none.
export function sourceFor(cfg: Config, reader: ItemReader | string | undefined, pollMs: number): JobSource {
  if (sourceOf(cfg).type === "none") return new NoSource("the job source is none");
  if (reader === undefined) return new NoSource();
  if (typeof reader === "string") return new NoSource(reader);
  return new GitHubActionsSource(reader, pollMs);
}
