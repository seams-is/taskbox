import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lastLineAt, Parser, RATE } from "../src/net/netparse.ts";
import type { NetLine } from "../src/net/packet.ts";
import { pruneRings, readOwned, readRing, Ring, ringBridges, ringFiles } from "../src/net/ring.ts";
import { FLAGS, pcap, tcp } from "./net-frames.ts";

const T = 1_800_000_000_000;
const dir = () => mkdtempSync(join(tmpdir(), "taskbox-net-"));
const lines = (text: string) => text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as NetLine);
const syn = (i: number) => tcp({ src: "10.20.30.42", dst: "140.82.112.3", sp: 10_000 + (i % 50_000), dp: 443, flags: FLAGS.SYN });

describe("netparse", () => {
  test("a hello first, with the gap since the ring's last line; then a line per packet", () => {
    const out: string[] = [];
    let now = T + 30_000;
    const p = new Parser({ write: (l) => void out.push(...l) }, { names: true, now: () => now, lastAt: T });
    p.feed(pcap([{ t: T + 30_001, f: syn(1) }]));
    const got = out.map((l) => JSON.parse(l) as NetLine);
    expect(got[0]).toEqual({ t: T + 30_000, k: "hello", n2: 30_000 });
    expect(got[1]).toMatchObject({ k: "syn", sp: 10_001 });
    now += 5000;
    p.beat();
    expect(JSON.parse(out.at(-1)!)).toEqual({ t: T + 35_000, k: "beat" });
  });

  test("a flood is capped at RATE a second; the rest are one drop line, and no packet bytes reach the ring", () => {
    const out: string[] = [];
    const p = new Parser({ write: (l) => void out.push(...l) }, { names: true, now: () => T });
    const n = RATE + 1500;
    const stream = pcap(Array.from({ length: n }, (_, i) => ({ t: T + 1000 + Math.floor((i * 999) / n), f: syn(i) })));
    p.feed(stream);
    p.feed(pcap([{ t: T + 2500, f: syn(1) }]).subarray(24)); // a packet in the next second ends the count
    const got = out.map((l) => JSON.parse(l) as NetLine);
    expect(got.filter((l) => l.k === "syn").length).toBe(RATE + 1);
    expect(got.filter((l) => l.k === "drop")).toEqual([{ t: T + 1000, k: "drop", n2: 1500 }]);
    expect(out.join("\n")).not.toMatch(/\\u0000|ff/);
  });

  test("the ring holds at most its size: two halves, the older taking the older lines", () => {
    const d = dir();
    const r = new Ring(d, "bridge100", 64 * 1024);
    for (let i = 0; i < 5000; i++) r.write([JSON.stringify({ t: T + i, k: "beat" })]);
    r.close();
    const f = ringFiles(d, "bridge100");
    expect(statSync(f.now).size + statSync(f.before).size).toBeLessThanOrEqual(64 * 1024 + 100);
    const all = lines(readRing(d, "bridge100", undefined));
    expect(all.at(-1)!.t).toBe(T + 4999);
    expect(all.map((l) => l.t)).toEqual([...all.map((l) => l.t)].sort((a, b) => a - b));
    expect(lastLineAt(d, "bridge100", undefined)).toBe(T + 4999);
    expect(ringBridges(d)).toEqual(["bridge100"]);
    expect(() => new Ring(d, "en0", 1024)).toThrow(/bridge/);
  });

  test("a reader takes only plain files owned by the account it names, never a link", () => {
    const d = dir();
    writeFileSync(join(d, "x"), "hello\n");
    expect(readOwned(join(d, "x"), process.getuid!()).text).toBe("hello\n");
    expect(readOwned(join(d, "x"), process.getuid!() + 1).text).toBe("");
    require("node:fs").symlinkSync(join(d, "x"), join(d, "bridge101.jsonl"));
    expect(readOwned(join(d, "bridge101.jsonl"), undefined).text).toBe("");
  });

  test("netparse prunes the rings of bridges unwritten for keepDays, and keeps its own", () => {
    const d = dir();
    for (const b of ["bridge100", "bridge101", "bridge102"]) writeFileSync(ringFiles(d, b).now, "{}\n");
    const now = Date.now();
    const old = (now - 20 * 86_400_000) / 1000;
    utimesSync(ringFiles(d, "bridge101").now, old, old);
    utimesSync(ringFiles(d, "bridge102").now, old, old);
    expect(pruneRings(d, 14, now, "bridge102")).toEqual(["bridge101"]);
    expect(existsSync(ringFiles(d, "bridge101").now)).toBe(false);
    expect(readFileSync(ringFiles(d, "bridge102").now, "utf8")).toBe("{}\n");
  });
});
