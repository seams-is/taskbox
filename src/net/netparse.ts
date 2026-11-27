// netparse: one bridge's parser. launchd starts it as _taskboxnet from the first instruction (root
// never spawns it); it reads the pcap stream its bridge's tcpdump writes into a FIFO and writes
// metadata lines to its ring. At most RATE packets a second are read; the rest are counted and the
// count is one "drop" line. Packet bytes never reach disk. Once data comes it writes a "beat" line
// every BEAT_MS, so a restart's "hello" says how long capture was down to within a beat.
import { constants, createReadStream, openSync } from "node:fs";
import type { Clock } from "../clock.ts";
import { type NetLine, PcapReader, parseFrame } from "./packet.ts";
import { pruneRings, readRing, Ring } from "./ring.ts";

export const RATE = 2_000;
export const BEAT_MS = 5_000;

export class Parser {
  private reader = new PcapReader();
  private second = -1;
  private seen = 0;
  private dropped = 0;
  private said = false;
  constructor(
    private ring: Pick<Ring, "write">,
    private o: { names: boolean; now: () => number; lastAt?: number; rate?: number },
  ) {}

  // The first line once data comes: when the parser started reading, and how long since the ring's
  // last line, which netwatch reports as a capture gap.
  private hello(): string[] {
    if (this.said) return [];
    this.said = true;
    const t = this.o.now();
    const line: NetLine = { t, k: "hello", ...(this.o.lastAt !== undefined && t >= this.o.lastAt ? { n2: t - this.o.lastAt } : {}) };
    return [JSON.stringify(line)];
  }

  feed(chunk: Uint8Array): void {
    const out = this.hello();
    const rate = this.o.rate ?? RATE;
    for (const r of this.reader.push(chunk)) {
      const sec = Math.floor(r.t / 1000);
      if (sec !== this.second) {
        out.push(...this.flushDrops());
        this.second = sec;
        this.seen = 0;
      }
      if (++this.seen > rate) {
        this.dropped++;
        continue;
      }
      const line = parseFrame(r.t, r.frame, { names: this.o.names });
      if (line) out.push(JSON.stringify(line));
    }
    this.ring.write(out);
  }

  private flushDrops(): string[] {
    if (!this.dropped) return [];
    const line: NetLine = { t: this.second * 1000, k: "drop", n2: this.dropped };
    this.dropped = 0;
    return [JSON.stringify(line)];
  }

  beat(): void {
    if (this.said) this.ring.write([JSON.stringify({ t: this.o.now(), k: "beat" } satisfies NetLine)]);
  }

  end(): void {
    this.ring.write(this.flushDrops());
  }
}

// The time of the ring's last line, read once at the start.
export function lastLineAt(dir: string, bridge: string, uid: number | undefined): number | undefined {
  const text = readRing(dir, bridge, uid);
  const end = text.lastIndexOf("\n", text.length - 2);
  const last = text.slice(end + 1).trim();
  const t = /^\{"t":(\d{10,15})[,}]/.exec(last)?.[1];
  return t ? Number(t) : undefined;
}

// The whole run: open the FIFO (blocking until tcpdump opens it), read to its end, then exit, so
// launchd starts the parser and its tcpdump again together.
export async function runParser(o: { fifo: string; dir: string; bridge: string; ringMB: number; names: boolean; keepDays: number; clock: Clock; uid?: number }): Promise<void> {
  pruneRings(o.dir, o.keepDays, o.clock.now(), o.bridge);
  const ring = new Ring(o.dir, o.bridge, o.ringMB * 1024 * 1024);
  const p = new Parser(ring, { names: o.names, now: () => o.clock.now(), lastAt: lastLineAt(o.dir, o.bridge, o.uid) });
  // Opening a FIFO waits for its writer: tcpdump, once it has the device open.
  const stream = createReadStream("", { fd: openSync(o.fifo, constants.O_RDONLY | constants.O_NOFOLLOW), highWaterMark: 64 * 1024 });
  const stopBeat = o.clock.every(BEAT_MS, () => p.beat());
  try {
    for await (const chunk of stream) p.feed(chunk as Uint8Array);
  } finally {
    stopBeat();
    p.end();
    ring.close();
  }
}
