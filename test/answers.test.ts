// What a controller reads from a box: hello, the install ID, and --json.
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ANSWERS, checkAnswer, helloAnswer, jobsAnswer, logAnswer, readInstallId, statusAnswer, text } from "../src/answers.ts";
import { type CheckContext, otherUsers } from "../src/checks.ts";
import { type Installed, paths } from "../src/config.ts";
import { placeInstallId } from "../src/install.ts";
import type { JobRecord } from "../src/jobs.ts";
import { jsonLogEntries } from "../src/ops.ts";
import { commandFor } from "../src/shell.ts";
import { computeState } from "../src/state.ts";
import { FakeSys } from "./fake.ts";
import { CFG, testBox, quietBox } from "./helpers.ts";

const me = process.getuid!();
const INSTALLED: Installed = { commit: "0123456789abcdef0123456789abcdef01234567", pr: 10, title: "feat: taskbox 2", mergedAt: "2026-11-17T00:00:00Z", tag: "v2.0.0", installedAt: "x", files: {} };

function stateDir() {
  const r = mkdtempSync(join(tmpdir(), "taskbox-answers-"));
  const p = paths(r, testBox());
  mkdirSync(join(r, "opt/taskbox-state"), { recursive: true });
  return p;
}

describe("text from the box", () => {
  test("keeps printable ASCII only, and cuts it to 120 characters", () => {
    expect(text("ok\u001b[31mred\u0007")).toBe("ok [31mred");
    expect(text("a‮evil⁦b​c\u{E0041}d\u0085e")).toBe("a evil b c d e");
    expect(text("x".repeat(500))).toHaveLength(120);
    expect(text(42)).toBe("");
  });
});

describe("hello", () => {
  test("says role, release, install ID and the answers' version, and nothing else", () => {
    const h = helloAnswer(INSTALLED, "0".repeat(32));
    expect(h).toEqual({ answers: ANSWERS, kind: "hello", role: "box", release: "v2.0.0", installId: "0".repeat(32) });
  });
  test("a release that isn't a version tag reads as none", () => {
    expect(helloAnswer({ ...INSTALLED, tag: "v2.0.0\u001b]52;c;x" }, undefined).release).toBeNull();
    expect(helloAnswer(undefined, undefined)).toEqual({ answers: ANSWERS, kind: "hello", role: "box", release: null, installId: null });
  });
  test("remote's shell takes hello", () => {
    expect(commandFor("hello")).toEqual({ args: ["hello"] });
    expect(commandFor("taskbox hello")).toEqual({ args: ["hello"] });
  });
});

describe("--json", () => {
  test("status gives the state's word and plain facts, never the screen's sentences", () => {
    // The real state, with pat logged in beside a job: the screen's sentence names pat.
    const state = computeState({ now: 1_700_000_000_000, loop: { slot: "running a job", job: "build" }, others: ["pat"] } as Parameters<typeof computeState>[0]);
    expect(`${state.detail} ${state.next}`).toContain("pat");
    const a = statusAnswer({ state, installed: INSTALLED, othersLoggedIn: 1, job: "build", lastJob: "2026-11-17T01:00:00Z", lastJobResult: "done" });
    expect(Object.keys(a).sort()).toEqual(["answers", "commit", "job", "jobs", "kind", "lastJob", "othersLoggedIn", "release", "slots", "state"]);
    expect(JSON.stringify(a)).not.toContain("pat ");
    expect(JSON.stringify(a)).not.toContain(`"pat"`);
    expect(a.othersLoggedIn).toBe(1);
    expect(a.lastJob).toEqual({ at: Date.parse("2026-11-17T01:00:00Z"), result: "done" });
    expect(a.commit).toBe("0123456789ab");
  });
  test("a job's name shows only while one runs; an odd word or result reads as null", () => {
    const running = statusAnswer({ state: { word: "Running", detail: "", next: "", notify: false }, installed: undefined, othersLoggedIn: 0, job: "build \u001b[2J", lastJob: "2026-11-17T01:00:00Z", lastJobResult: "pwned" });
    expect(running.job).toBe("build [2J");
    expect(running.lastJob?.result).toBeNull();
    const a = statusAnswer({ state: { word: "Pwned" as never, detail: "", next: "", notify: false }, installed: undefined, othersLoggedIn: -3, job: "build", lastJob: undefined, lastJobResult: undefined });
    expect(a.state).toBeNull();
    expect(a.job).toBeNull();
    expect(a.othersLoggedIn).toBe(0);
    expect(a.lastJob).toBeNull();
  });
  test("jobs leaves out the repo and who was logged in", () => {
    const job: JobRecord = { v: 1, startedAt: 1, jobAt: 2, endedAt: 3, repo: "example-org/app", job: "build \u001b[2J", result: "passed", vmDeleted: true, guard: "ok", beside: ["pat"] };
    const a = jobsAnswer([job]);
    expect(a).toEqual({
      answers: ANSWERS,
      kind: "jobs",
      jobs: [
        { kind: "job", startedAt: 1, jobAt: 2, endedAt: 3, name: "build [2J", result: "passed", vmDeleted: true, phases: null, vmKind: "macos", slot: null, className: null, labels: null, usage: null },
      ],
    });
    expect(JSON.stringify(a)).not.toContain(`"pat"`);
    expect(JSON.stringify(a)).not.toContain("example-org");
  });
  test("log gives taskbox's own fixed sentences only: no names, errors or paths", () => {
    const at = "2026-11-17T01:00:00.000Z";
    const now = Date.parse(at) + 60_000;
    const lines = [
      `${at} job job-1 done`,
      `${at} hold: pat holds the box until 2026-11-17T04:00:00.000Z: render`,
      `${at} share: the hold ended early, asked by pat`,
      `${at} no new VM: held until 04:00 for "render", asked by pat`,
      `${at} ignored a request from user 501: bad JSON`,
      `${at} error: ENOENT: no such file, open '/opt/taskbox/app/x'`,
      `${at} pull failed: /Users/ci/.tart/tmp is full`,
    ];
    expect(logAnswer(jsonLogEntries(lines, now - 86_400_000)).lines.map((l) => l.text)).toEqual(["A job ran and finished.", "The download stopped."]);
    expect(logAnswer([{ at: 7, text: "x\u0000y" }]).lines).toEqual([{ at: 7, text: "x y" }]);
  });
  test("check leaves out each row's detail for anyone but ci and root", () => {
    const rows = [{ name: "Other users", status: "OK" as const, detail: "admin (admin user)" }];
    expect(checkAnswer(rows, false)).toEqual({ answers: ANSWERS, kind: "check", checks: [{ name: "Other users", status: "OK" }] });
    expect(checkAnswer(rows, true).checks[0]).toEqual({ name: "Other users", status: "OK", detail: "admin (admin user)" });
  });
});

describe("the install ID", () => {
  test("made once: 32 hex characters, read-only, kept by every later install", () => {
    const p = stateDir();
    placeInstallId(p, () => {}, me);
    const id = readFileSync(p.installId, "utf8").trim();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(statSync(p.installId).mode & 0o777).toBe(0o444);
    expect(readInstallId(p.installId, me)).toBe(id);
    placeInstallId(p, () => {}, me);
    expect(readFileSync(p.installId, "utf8").trim()).toBe(id);
  });
  test("two boxes get different IDs", () => {
    const a = stateDir();
    const b = stateDir();
    placeInstallId(a, () => {}, me);
    placeInstallId(b, () => {}, me);
    expect(readInstallId(a.installId, me)).not.toBe(readInstallId(b.installId, me));
  });
  test("a link, a writable file, someone else's or odd text reads as none, and stops the install", () => {
    const cases: ((f: string) => void)[] = [
      (f) => symlinkSync("/etc/hosts", f),
      (f) => writeFileSync(f, `${"a".repeat(32)}\n`, { mode: 0o644 }),
      (f) => {
        writeFileSync(f, "not an id\n");
        chmodSync(f, 0o444);
      },
    ];
    for (const make of cases) {
      const p = stateDir();
      make(p.installId);
      expect(readInstallId(p.installId, me)).toBeUndefined();
      expect(() => placeInstallId(p, () => {}, me)).toThrow("isn't taskbox's");
    }
    const p = stateDir();
    writeFileSync(p.installId, `${"a".repeat(32)}\n`, { mode: 0o444 });
    expect(readInstallId(p.installId, me + 1)).toBeUndefined();
  });
});

describe("taskbox check as anyone but ci", () => {
  test("the Other users row gives counts, and names nobody", async () => {
    const sys = new FakeSys();
    quietBox(sys);
    sys.responders.push((cmd, args) => {
      if (cmd === "/usr/bin/dscl" && args[1] === "-list") return { code: 0, stdout: "admin 501\ntaskbox 502\npat 503\ntaskbox-agent 504\n", stderr: "" };
      if (cmd === "/usr/bin/dscl" && args[1] === "-read") return { code: 0, stdout: "GroupMembership: root admin\n", stderr: "" };
      return undefined;
    });
    const r = await otherUsers({ sys, cfg: CFG, paths: stateDir(), uid: 504, serviceUid: 502 } as unknown as CheckContext);
    expect(r).toEqual({ status: "OK", detail: "3 users: 1 admin, 2 standard, 0 logged in" });
  });
});

describe("jobs --json and the history from before v2.2.0", () => {
  test("hold lines in jobs.jsonl are dropped as they're read, so the answer has jobs only", async () => {
    const { readJobs } = await import("../src/jobs.ts");
    const p = stateDir();
    mkdirSync(p.shared, { recursive: true });
    const job = { v: 1, startedAt: 1, endedAt: 3, repo: "example-org/app", job: "build", result: "passed", vmDeleted: true, guard: "ok" };
    writeFileSync(p.jobsFile, [job, { v: 1, kind: "hold", at: 4, until: 5, by: "pat", reason: "render" }, { ...job, startedAt: 6 }].map((l) => JSON.stringify(l)).join("\n") + "\n");
    const a = jobsAnswer(readJobs(p, me)!);
    expect(a.jobs.map((j) => [j.kind, j.startedAt])).toEqual([["job", 6], ["job", 1]]);
    expect(JSON.stringify(a)).not.toContain("hold");
    expect(JSON.stringify(a)).not.toContain("render");
  });
});
