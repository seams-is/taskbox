// The copies every user may read: cleaned, nothing secret, and trusted only when ci's alone.
import { describe, expect, test } from "bun:test";
import { chmodSync, linkSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../src/config.ts";
import { oneJob } from "../src/loop.ts";
import { Log } from "../src/log.ts";
import { mirrorPull, PullRecorder } from "../src/progress.ts";
import { LOG_COPY_BYTES, mirrorJson, mirrorLogLine, scrub, sharedPaths, sharedProblem } from "../src/shared.ts";
import { FakeSys } from "./fake.ts";
import { loopDeps, PEM, tempRoot, testBox } from "./helpers.ts";

const me = process.getuid!();
const box = () => {
  const p = paths(tempRoot(), testBox());
  mkdirSync(p.shared, { recursive: true });
  return p;
};

describe("a copy", () => {
  test("names ci's folder instead of spelling it, and drops control characters", () => {
    const p = box();
    expect(scrub({ line: `tart: ${p.serviceHome}/.tart/tmp/x failed\u001b[2J`, n: 3, a: [`${p.serviceHome}/k`] }, p.serviceHome)).toEqual({ line: "tart: the service account's folder/.tart/tmp/x failed[2J", n: 3, a: ["the service account's folder/k"] });
  });
  test("is written whole, readable by every user, and removed for null", () => {
    const p = box();
    mirrorJson(p, "stopped", { at: 1 });
    const f = join(p.shared, "stopped.json");
    expect(statSync(f).mode & 0o777).toBe(0o644);
    expect(JSON.parse(readFileSync(f, "utf8"))).toEqual({ at: 1 });
    mirrorJson(p, "stopped", null);
    expect(readdirSync(p.shared)).toEqual([]);
  });
  test("is no error before the install makes the folder", () => {
    const p = paths(tempRoot(), testBox());
    expect(() => mirrorJson(p, "loopState", { slot: "idle" })).not.toThrow();
    expect(() => mirrorLogLine(p, "x")).not.toThrow();
  });
});

describe("the readers' trust", () => {
  test("trusts the folder only when it and each file are ci's alone and not links", () => {
    const p = box();
    expect(sharedProblem(p, me, me)).toBeUndefined();
    expect(sharedProblem(p, me + 1, me)).toContain("isn't the service account's alone");
    expect(sharedProblem(p, undefined, me)).toBe("there is no service account");
    writeFileSync(join(p.shared, "loop-state.json"), "{}");
    chmodSync(join(p.shared, "loop-state.json"), 0o666);
    expect(sharedProblem(p, me, me)).toContain("loop-state.json isn't the service account's alone");
    const q = box();
    symlinkSync(join(q.serviceHome, "pull.json"), join(q.shared, "pull.json"));
    expect(sharedProblem(q, me, me)).toContain("pull.json isn't the service account's alone");
    const r = box();
    chmodSync(r.shared, 0o777);
    expect(sharedProblem(r, me, me)).toContain("isn't the service account's alone");
    expect(sharedProblem(paths(tempRoot(), testBox()), me, me)).toContain("isn't there");
  });
  test("other users' paths point at the copies, and nothing else moves", () => {
    const p = paths(tempRoot(), testBox());
    const s = sharedPaths(p);
    expect([s.loopState, s.pull, s.stopped, s.log]).toEqual(["loop-state.json", "pull.json", "stopped.json", "loop.log"].map((f) => join(p.shared, f)));
    expect(s.key).toBe(p.key);
  });
});

describe("the copies every user reads", () => {
  test("a hard link someone else makes doesn't blank the view, and points at a copy nobody reads", () => {
    const p = box();
    mirrorLogLine(p, "first");
    const log = join(p.shared, "loop.log");
    const link = join(p.shared, "..", "hard-link");
    linkSync(log, link);
    expect(sharedProblem(p, me, me)).toBeUndefined();
    mirrorLogLine(p, "second");
    expect(readFileSync(log, "utf8")).toBe("first\nsecond\n");
    expect(readFileSync(link, "utf8")).toBe("first\n");
  });
  test("a parent that isn't root's alone isn't trusted", () => {
    const p = box();
    expect(sharedProblem(p, me, me + 1)).toContain("isn't root's alone");
    chmodSync(join(p.shared, ".."), 0o777);
    expect(sharedProblem(p, me, me)).toContain("isn't root's alone");
  });
  // test.serial: more than 50 ms of work alone (test/setup.ts).
  test.serial("the log's copy keeps its last 256 KB", () => {
    const p = box();
    for (let i = 0; i < 400; i++) mirrorLogLine(p, `${i} ${"x".repeat(1000)}`);
    const text = readFileSync(join(p.shared, "loop.log"), "utf8");
    expect(text.length).toBeLessThanOrEqual(LOG_COPY_BYTES + 1100);
    expect(text.trimEnd().split("\n").at(-1)).toStartWith("399 ");
  });
  test("only the fields the screens read are copied, and tokens are redacted", () => {
    const p = box();
    mirrorJson(p, "loopState", { slot: "idle", runner: "job-x", registeredAt: "t", somethingNew: "ghs_" + "a".repeat(36) });
    expect(JSON.parse(readFileSync(join(p.shared, "loop-state.json"), "utf8"))).toEqual({ slot: "idle" });
    mirrorJson(p, "pull", { image: "x", error: `denied: token ghs_${"b".repeat(36)} eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmno` });
    const pull = readFileSync(join(p.shared, "pull.json"), "utf8");
    expect(pull).not.toContain("ghs_");
    expect(pull).not.toContain("eyJ");
  });
  test("a copy is readable by every user whatever ci's umask", () => {
    const p = box();
    const old = process.umask(0o077);
    try {
      mirrorJson(p, "stopped", { at: 1 });
      mirrorLogLine(p, "x");
    } finally {
      process.umask(old);
    }
    expect(statSync(join(p.shared, "stopped.json")).mode & 0o777).toBe(0o644);
    expect(statSync(join(p.shared, "loop.log")).mode & 0o777).toBe(0o644);
  });
});

describe("the writers", () => {
  test("a job leaves copies of the state and the log with nothing secret and no path into ci's folder", async () => {
    const sys = new FakeSys();
    sys.onSpawn = (pr) => {
      if (pr.args[0] === "exec") {
        queueMicrotask(() => {
          pr.opts.onLine?.("Listening for Jobs");
          pr.opts.onLine?.("Running job: integration");
          pr.exit(0);
        });
      }
    };
    const d = loopDeps(sys, tempRoot());
    mkdirSync(d.paths.shared, { recursive: true });
    const log = new Log(d.paths.log, (line) => mirrorLogLine(d.paths, line));
    log.secret(PEM);
    d.log = log;
    d.log.write(`a line naming ${d.paths.serviceHome}/.taskbox and the key ${PEM}`);
    expect(await oneJob(d, () => "c0ffee0", "c0ffee0")).toBe("done");
    for (const name of readdirSync(d.paths.shared)) {
      const text = readFileSync(join(d.paths.shared, name), "utf8");
      expect(text).not.toContain(d.paths.serviceHome);
      expect(text).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY|gh[pousr]_[A-Za-z0-9]{20,}|jitconfig|encoded_jit_config/i);
    }
    expect(JSON.parse(readFileSync(join(d.paths.shared, "loop-state.json"), "utf8")).slot).toBe("idle");
    expect(readFileSync(join(d.paths.shared, "loop.log"), "utf8")).toContain("the service account's folder/.taskbox");
  });
  test("the download's progress is copied each time it's written", () => {
    const p = box();
    mirrorPull(p.pull, (s) => mirrorJson(p, "pull", s));
    mkdirSync(p.projectState, { recursive: true });
    const rec = new PullRecorder(p.pull, "img", () => 1_000_000, "ghcr.io/x/y@sha256:" + "0".repeat(64));
    rec.finish(false, `tart failed under ${p.serviceHome}/.tart/tmp`);
    const copy = join(p.shared, "pull.json");
    const s = JSON.parse(readFileSync(copy, "utf8"));
    expect(s.image).toBe("img");
    expect(JSON.stringify(s)).not.toContain(p.serviceHome);
  });
});
