// One VM's lines from the bridges' rings, read as the job goes: the whole of each ring once, then only
// what each file gained. A line is the VM's when its address is in it; a bridge is the VM's once one
// of its lines is, and then its rate-cap drops and capture restarts in the window count too.
import { type NetLine } from "./packet.ts";
import { readOwned, readRing, ringBridges, ringFiles } from "./ring.ts";

// Lines kept per job, whatever the detail file's cap: a crawler's 50,000 connections fit.
export const LINES_MAX = 300_000;

interface Seen {
  offset: number;
  ours: boolean;
}

export class VmLines {
  lines: NetLine[] = [];
  dropped = 0;
  gaps = 0;
  truncated: string | undefined;
  // Each of the VM's bridges: the time of its ring's oldest line at the first read.
  private oldest = new Map<string, number>();
  private seen = new Map<string, Seen>();
  private needle: string[];
  constructor(
    private dir: string,
    private uid: number | undefined,
    readonly ip: string,
    private from: number,
  ) {
    this.needle = [`"s":"${ip}"`, `"d":"${ip}"`];
  }

  // first: the whole ring's first read; turned: its older file was there, so lines may have gone.
  private take(bridge: string, text: string, first: boolean, turned = false): void {
    const s = this.seen.get(bridge)!;
    const own: NetLine[] = [];
    const other: NetLine[] = [];
    let earliest: number | undefined;
    for (const line of text.split("\n")) {
      if (!line.startsWith('{"t":')) continue;
      const mine = this.needle.some((n) => line.includes(n));
      const meta = !mine && (line.includes('"k":"drop"') || line.includes('"k":"hello"'));
      if (first && earliest === undefined) earliest = Number(/^\{"t":(\d{10,15})/.exec(line)?.[1]);
      if (!mine && !meta) continue;
      let l: NetLine;
      try {
        l = JSON.parse(line) as NetLine;
      } catch {
        continue;
      }
      if (typeof l.t !== "number" || l.t < this.from) continue;
      (mine ? own : other).push(l);
    }
    if (own.length) s.ours = true;
    if (!s.ours) return;
    for (const l of own) {
      if (this.lines.length >= LINES_MAX) {
        this.truncated ??= `more than ${LINES_MAX} lines; the rest weren't read`;
        break;
      }
      this.lines.push(l);
    }
    for (const l of other) {
      if (l.k === "drop") this.dropped += typeof l.n2 === "number" ? l.n2 : 0;
      else if (l.k === "hello") this.gaps++;
    }
    if (first && turned && earliest !== undefined) this.oldest.set(bridge, earliest);
  }

  // Why the lines from `from` on may not all be there, or undefined.
  cutShort(from: number): string | undefined {
    if (this.truncated) return this.truncated;
    for (const [b, t] of this.oldest) if (t - from >= 1000) return `${b}'s ring had wrapped: the job's first ${Math.round((t - from) / 1000)} s aren't in it`;
    return undefined;
  }

  // Every ring's new lines since the last call.
  poll(): void {
    for (const b of ringBridges(this.dir)) {
      const f = ringFiles(this.dir, b);
      const s = this.seen.get(b);
      if (!s) {
        const size = readOwned(f.now, this.uid, 0, 0).size;
        this.seen.set(b, { offset: size, ours: false });
        this.take(b, readRing(this.dir, b, this.uid), true, readOwned(f.before, this.uid, 0, 0).size > 0);
        continue;
      }
      const r = readOwned(f.now, this.uid, s.offset);
      if (r.size < s.offset) {
        // The file turned: the rest of the one before, then the new one from its start.
        const before = readOwned(f.before, this.uid, s.offset);
        this.take(b, before.text, false);
        const now = readOwned(f.now, this.uid, 0);
        s.offset = now.size;
        this.take(b, now.text, false);
        continue;
      }
      // Only whole lines: one being written is read on the next call.
      const whole = r.text.slice(0, r.text.lastIndexOf("\n") + 1);
      s.offset = s.offset + Buffer.byteLength(whole);
      this.take(b, whole, false);
    }
    this.lines.sort((a, b) => a.t - b.t);
  }
}
