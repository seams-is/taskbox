// The spool's red-team tests, for every v3 spool (core/spool.ts): what an asker who controls the
// spool's folder could plant, and what root does with it.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drainSpool, newSpoolMemory, noOutcomes, orderBy, outcomeOf, readRequest, recordOutcome, type SpoolFile, type SpoolReport, spoolProblem, writeSpoolFile, OUTCOMES_MAX } from "../../src/core/spool.ts";

const uid = process.getuid!();
const T = 1_800_000_000_000;
const KINDS = ["signed", "drain", "pause"];
const kinds = { signed: (b: Record<string, unknown>) => (typeof b.word === "string" ? undefined : "the request's word isn't one taskbox reads"), drain: () => undefined, pause: () => undefined };

function spool(): string {
  const parent = mkdtempSync(join(tmpdir(), "taskbox-spool-"));
  chmodSync(parent, 0o755);
  const dir = join(parent, "agent-spool");
  mkdirSync(dir, { mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}
let n = 0;
const rand = (k: number) => {
  const b = new Uint8Array(k);
  b[k - 1] = ++n & 0xff;
  b[k - 2] = (n >> 8) & 0xff;
  return b;
};
const at = (t: number) => ({ now: () => t });
const rules = (dir: string, o: Partial<Parameters<typeof drainSpool>[0]> = {}) => ({ dir, owner: uid, rootUid: uid, isRequest: (name: string) => /^rq_.*\.json$/.test(name), order: orderBy(KINDS, (k) => (k === "signed" ? 0 : 1)), ...o });
async function pass(dir: string, o: Partial<Parameters<typeof drainSpool>[0]> = {}, now = T, mem = newSpoolMemory()) {
  const report: SpoolReport = { did: [], problems: [] };
  const taken: { name: string; f: SpoolFile | undefined; there: boolean }[] = [];
  await drainSpool(rules(dir, o), mem, at(now), report, async (name, f) => {
    taken.push({ name, f, there: existsSync(join(dir, name)) });
  });
  return { report, taken, mem };
}

describe("a spool", () => {
  test("a request is written to a temporary name and renamed, and read back whole", async () => {
    const dir = spool();
    const { file } = writeSpoolFile(dir, "drain", { timeout: 0 }, at(T), rand);
    expect(readdirSync(dir)).toEqual([file]);
    const { taken } = await pass(dir);
    expect(taken.map((t) => t.name)).toEqual([file]);
    const r = readRequest(file, taken[0]!.f!, { owner: uid, now: T, kinds });
    expect(r).toMatchObject({ ok: true, request: { kind: "drain", body: { timeout: 0 } } });
  });
  test("each request is unlinked before it is applied", async () => {
    const dir = spool();
    writeSpoolFile(dir, "drain", {}, at(T), rand);
    const { taken } = await pass(dir);
    expect(taken[0]!.there).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });
  test("signed requests first, then oldest first, at most 20 a pass", async () => {
    const dir = spool();
    const names: string[] = [];
    for (let i = 0; i < 25; i++) {
      const { file } = writeSpoolFile(dir, "pause", {}, at(T + i), rand);
      utimesSync(join(dir, file), (T + i) / 1000, (T + i) / 1000);
      names.push(file);
    }
    const s = writeSpoolFile(dir, "signed", { word: "x" }, at(T + 100), rand).file;
    utimesSync(join(dir, s), (T + 100) / 1000, (T + 100) / 1000);
    const { taken } = await pass(dir);
    expect(taken.map((t) => t.name)).toEqual([s, ...names.slice(0, 19)]);
    expect(readdirSync(dir)).toHaveLength(6);
  });
  test("a link is removed, never followed, and what it points to is untouched", async () => {
    const dir = spool();
    const secret = join(dirname(dir), "root-only");
    writeFileSync(secret, "root's");
    symlinkSync(secret, join(dir, "rq_01JD8Q4AAAAAAAAAAAAAAAAAAA.drain.json"));
    const { taken, report } = await pass(dir);
    expect(taken).toEqual([]);
    expect(readFileSync(secret, "utf8")).toBe("root's");
    expect(readdirSync(dir)).toEqual([]);
    expect(report.did.join()).toContain("isn't a plain file");
  });
  test("a FIFO is removed without blocking", async () => {
    const dir = spool();
    Bun.spawnSync(["/usr/bin/mkfifo", join(dir, "rq_01JD8Q4AAAAAAAAAAAAAAAAAAA.drain.json")]);
    const { taken } = await pass(dir);
    expect(taken).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });
  test("a second hard link is read as a stat only, and refused", async () => {
    const dir = spool();
    const { file } = writeSpoolFile(dir, "drain", {}, at(T), rand);
    linkSync(join(dir, file), join(dirname(dir), "kept"));
    const { taken } = await pass(dir);
    expect(taken[0]!.f!.bytes.length).toBe(0);
    expect(readRequest(file, taken[0]!.f!, { owner: uid, now: T, kinds })).toMatchObject({ ok: false, why: "the request isn't a plain file" });
  });
  test("a file another user owns is refused", async () => {
    const dir = spool();
    const { file } = writeSpoolFile(dir, "drain", {}, at(T), rand);
    const { taken } = await pass(dir, { owner: uid, isRequest: () => true });
    const f = { ...taken[0]!.f!, uid: uid + 1 };
    expect(readRequest(file, f, { owner: uid, now: T, kinds })).toMatchObject({ ok: false });
  });
  test("over 4 KB is refused without reading it all", async () => {
    const dir = spool();
    const name = "rq_01JD8Q4AAAAAAAAAAAAAAAAAAA.drain.json";
    writeFileSync(join(dir, name), "x".repeat(10_000));
    const { taken } = await pass(dir);
    expect(taken[0]!.f!.bytes.length).toBe(4097);
    expect(readRequest(name, taken[0]!.f!, { owner: uid, now: T, kinds })).toMatchObject({ ok: false, why: "the request is over 4 KB" });
  });
  test("a flood: past 50 the oldest go", async () => {
    const dir = spool();
    for (let i = 0; i < 60; i++) {
      const { file } = writeSpoolFile(dir, "pause", {}, at(T + i), rand);
      utimesSync(join(dir, file), (T + i) / 1000, (T + i) / 1000);
    }
    const { report, taken } = await pass(dir);
    expect(report.did.join()).toContain("dropped the 10 oldest");
    expect(taken).toHaveLength(20);
    expect(readdirSync(dir)).toHaveLength(30);
  });
  test("a temporary name left behind goes once it is over 2 minutes old", async () => {
    const dir = spool();
    writeFileSync(join(dir, ".rq_x.tmp"), "half");
    utimesSync(join(dir, ".rq_x.tmp"), (T - 1000) / 1000, (T - 1000) / 1000);
    expect((await pass(dir, {}, T)).taken).toEqual([]);
    expect(readdirSync(dir)).toEqual([".rq_x.tmp"]);
    await pass(dir, {}, T + 3 * 60_000);
    expect(readdirSync(dir)).toEqual([]);
  });
  test("a spool that isn't its user's 700 folder in root's folder is closed", async () => {
    const dir = spool();
    chmodSync(dir, 0o755);
    expect((await pass(dir)).report.problems[0]).toContain("isn't mode 700");
    chmodSync(dir, 0o700);
    expect(spoolProblem(dir, uid + 1, uid, "the service account")).toBe("the spool isn't the service account's");
    chmodSync(dirname(dir), 0o777);
    expect(spoolProblem(dir, uid, uid)).toContain("isn't root's alone");
    chmodSync(dirname(dir), 0o755);
    const fake = join(dirname(dir), "link-spool");
    symlinkSync(dir, fake);
    expect(spoolProblem(fake, uid, uid)).toBe("the spool isn't a folder");
  });
  test("the time budget leaves the rest for the next pass", async () => {
    const dir = spool();
    for (let i = 0; i < 3; i++) writeSpoolFile(dir, "pause", {}, at(T), rand);
    let t = T;
    const report: SpoolReport = { did: [], problems: [] };
    const taken: string[] = [];
    await drainSpool(rules(dir), newSpoolMemory(), { now: () => t }, report, async (name) => {
      taken.push(name);
      t += 5_000;
    });
    expect(taken).toHaveLength(1);
    expect(report.did).toContain("left the rest of the spool for the next pass");
  });
});

describe("a request", () => {
  const f = (text: string): SpoolFile => ({ bytes: new TextEncoder().encode(text), uid, nlink: 1, isFile: true });
  const name = "rq_01JD8Q4AAAAAAAAAAAAAAAAAAA.signed.json";
  const good = { v: 1, id: "rq_01JD8Q4AAAAAAAAAAAAAAAAAAA", at: T, kind: "signed", body: { word: "w" } };
  test("is read strictly: its name's id and kind, its time, its kind's body", () => {
    expect(readRequest(name, f(JSON.stringify(good)), { owner: uid, now: T, kinds }).ok).toBe(true);
    const bad: [Record<string, unknown>, string][] = [
      [{ ...good, id: "rq_01JD8Q4BBBBBBBBBBBBBBBBBBB" }, "id"],
      [{ ...good, kind: "drain" }, "kind"],
      [{ ...good, at: T - 3 * 60_000 }, "2 minutes"],
      [{ ...good, body: { word: 1 } }, "word"],
      [{ ...good, extra: 1 }, "fields"],
      [{ ...good, v: 2 }, "version"],
    ];
    for (const [v, why] of bad) expect(readRequest(name, f(JSON.stringify(v)), { owner: uid, now: T, kinds })).toMatchObject({ ok: false, why: expect.stringContaining(why) });
    expect(readRequest("rq_x.unknown.json", f(JSON.stringify(good)), { owner: uid, now: T, kinds }).ok).toBe(false);
    expect(readRequest(name, { ...f("x"), bytes: new Uint8Array([0xff]) }, { owner: uid, now: T, kinds })).toMatchObject({ why: "the request isn't UTF-8" });
  });
  test("its outcome is kept once, by id, the newest 200", () => {
    let s = noOutcomes();
    s = recordOutcome(s, { id: good.id, at: T, ok: true, said: "Drained." });
    s = recordOutcome(s, { id: good.id, at: T, ok: false, said: "again" });
    expect(outcomeOf(s, good.id)).toMatchObject({ ok: true, said: "Drained." });
    for (let i = 0; i < OUTCOMES_MAX + 5; i++) s = recordOutcome(s, { id: `rq_${String(i).padStart(26, "0")}`, at: T, ok: true, said: "x" });
    expect(s.outcomes).toHaveLength(OUTCOMES_MAX);
    expect(outcomeOf(s, good.id)).toBeUndefined();
  });
});

function dirname(p: string): string {
  return p.slice(0, p.lastIndexOf("/"));
}
