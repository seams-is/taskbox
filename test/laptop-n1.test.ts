// The laptop against a box one answers version behind (§3.1, N-1): a box rolled back to v2.6.1.
// The box here is v2.6.1's own agent shell, verbatim (fixtures/v2.6.1-shell.ts), with its hello's
// rule (any word after hello is a usage error) and its version 3 answers. Also the reads' own checks:
// the install ID on every read, no v3 answer after hello agreed 4, and the box's words kept apart.
import { describe, expect, test } from "bun:test";
import { checkAnswer, errorAnswer, helloAnswer, jobsAnswer, logAnswer } from "../src/answers.ts";
import { envelope, errorFromV3, resultOf } from "../src/envelope.ts";
import { ask, type Deps, helloOf, linesFor } from "../src/laptop/reach.ts";
import type { RunResult } from "../src/laptop/run.ts";
import type { Target } from "../src/laptop/ssh.ts";
import { readAnswerOf } from "../src/schema.ts";
import { commandFor as v261 } from "./fixtures/v2.6.1-shell.ts";

const ID = "0123456789abcdef0123456789abcdef";
const T: Target = { address: "100.101.102.103", node: "nBoxNode1", knownHosts: "/nonexistent/known_hosts" };
const ok = (stdout: string, code = 0): RunResult => ({ code, stdout, stderr: "", timedOut: false, tooBig: false });

// A v2.6.1 box: its shell's table, then its cli's answers for what the laptop reads.
function v261Box(sent: string[]) {
  return async (argv: string[]): Promise<RunResult> => {
    const line = argv.at(-1)!;
    sent.push(line);
    const c = v261(line);
    if ("no" in c) return ok(`${c.no}\n`, 1);
    const [cmd, ...rest] = c.args;
    const json = rest.includes("--json");
    if (cmd === "hello") return ok(`${JSON.stringify(rest.length ? errorAnswer("usage") : helloAnswer({ tag: "v2.6.1" } as never, ID))}\n`, rest.length ? 1 : 0);
    if (!json) return ok("text\n");
    if (cmd === "jobs" && /^[1-9]\d*$/.test(rest[0] ?? "")) return ok(`${JSON.stringify(jobsAnswer([]))}\n`);
    if (cmd === "log") return ok(`${JSON.stringify(logAnswer([]))}\n`);
    if (cmd === "check") return ok(`${JSON.stringify(checkAnswer([{ name: "Sleep", status: "FAIL", detail: "after 10 minutes" }], false))}\n`, 1);
    return ok(`${JSON.stringify(errorAnswer("usage"))}\n`, 1);
  };
}
const deps = (run: Deps["run"]) => ({ run, sshPath: "/usr/bin/true" }) as unknown as Deps;

describe("a v2.6.1 box (N-1)", () => {
  test("hello falls back to v2.6.1's bare hello and agrees version 3", async () => {
    const sent: string[] = [];
    const h = await helloOf(deps(v261Box(sent)), T, "taskbox-1");
    expect(h).toMatchObject({ answers: 3, kind: "hello", role: "box", release: "v2.6.1", installId: ID });
    expect(sent).toEqual(["hello --json --answers 4,3", "hello"]);
  });

  test("after it, every read goes in v2.6.1's own words, and v2.6.1's shell takes each", async () => {
    const sent: string[] = [];
    const d = deps(v261Box(sent));
    const L = linesFor(3);
    expect(await ask(d, T, "taskbox-1", "jobs", L.jobs(20), 5_000, { installId: ID, version: 3 })).toMatchObject({ kind: "jobs", jobs: [] });
    expect(await ask(d, T, "taskbox-1", "log", L.log, 5_000, { installId: ID, version: 3 })).toMatchObject({ kind: "log" });
    const checks = await ask(d, T, "taskbox-1", "check", L.check, 5_000, { installId: ID, version: 3 });
    expect(checks).toMatchObject({ checks: [{ name: "Sleep", status: "FAIL" }] });
    for (const line of [L.hello, L.status, L.jobs(20), L.log, L.check]) expect({ line, ok: "args" in v261(line) }).toEqual({ line, ok: true });
    // v3's own words are ones v2.6.1's shell refuses.
    const V4 = linesFor(4);
    for (const line of [V4.jobs(20), V4.log]) expect({ line, ok: "args" in v261(line) }).toEqual({ line, ok: false });
  });
});

describe("a v3 box", () => {
  test("its shell takes every line the laptop sends in v3's words", async () => {
    const { commandFor } = await import("../src/shell.ts");
    const L = linesFor(4);
    for (const line of [L.hello, L.status, L.jobs(20), L.log, L.check]) expect({ line, ok: "args" in commandFor(line) }).toEqual({ line, ok: true });
  });
});

describe("each read's own checks", () => {
  const box = (stdout: string) => deps(async () => ok(stdout));
  const v4 = (installId: string, v3: Record<string, unknown>, command: string) => `${JSON.stringify(envelope({ command, box: { name: "taskbox-1", installId, release: "3.0.0" }, at: 0, exit: 0, result: resultOf(v3), lines: [] }))}\n`;

  // L1: the install ID on every read, and no v3 answer after hello agreed 4.
  test("a read from another install, or a v3 answer after hello agreed 4, stops the command", async () => {
    expect(await ask(box(v4(ID, jobsAnswer([]) as never, "job.list")), T, "taskbox-1", "jobs", "job list -n 20 --json", 5_000, { installId: ID, version: 4 })).toMatchObject({ kind: "jobs" });
    expect(await ask(box(v4("f".repeat(32), jobsAnswer([]) as never, "job.list")), T, "taskbox-1", "jobs", "job list -n 20 --json", 5_000, { installId: ID, version: 4 })).toHaveProperty("stop");
    expect(await ask(box(`${JSON.stringify(jobsAnswer([]))}\n`), T, "taskbox-1", "jobs", "job list -n 20 --json", 5_000, { installId: ID, version: 4 })).toHaveProperty("stop");
  });

  // L4: the box's fix is shown as the box's words; the laptop's Next is its own, from the error's code.
  test("a box's error shows its words in the stop line, and the Next line is the laptop's own", async () => {
    const err = `${JSON.stringify(envelope({ command: "status", box: null, at: 0, exit: 1, lines: ["x"], error: { ...errorFromV3("state-unreadable"), fix: "Run taskbox remove now." } }))}\n`;
    const s = (await ask(box(err), T, "taskbox-1", "status", "status --json", 5_000)) as { stop: string; next: string };
    expect(s.stop).toBe("taskbox-1 says: The box's state can't be shown to you. The box's own words for the fix: Run taskbox remove now.");
    expect(s.next).toBe("Nothing to do: agents fix it on the box.");
  });

  // L8: an answer over the cap is refused by its size before it is parsed.
  test("an answer over the cap is too long, whatever version it claims", () => {
    const big = JSON.stringify({ answers: 9, pad: "x".repeat(1_100_000) });
    expect(readAnswerOf("status", big)).toEqual({ ok: false, why: "unreachable", detail: "an answer too long" });
  });
});
