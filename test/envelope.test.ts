// The answers envelope, version 4, and the one schema module both sides read it with (v3 design,
// §3.1): round trips, N and N-1, lines printable and capped, and failing closed.
import { describe, expect, test } from "bun:test";
import { checkAnswer, helloAnswer, jobsAnswer, logAnswer, statusAnswer } from "../src/answers.ts";
import { agree, capLines, cleanLine, envelope, errorFromV3, gapError, LINES_MAX, nextOf, resultOf, versionsOf } from "../src/envelope.ts";
import { readAnswer } from "../src/laptop/schema.ts";
import { parseLine, pathOf } from "../src/registry.ts";
import { ENVELOPE, readEnvelopes } from "../src/schema.ts";
import type { State } from "../src/state.ts";

const ID = "0123456789abcdef0123456789abcdef";
const BOX = { name: "taskbox-1", installId: ID, release: "3.0.0" };
const AT = Date.parse("2026-11-23T14:02:11Z");
const one = (v3: Record<string, unknown>, command: string, extra: Partial<Parameters<typeof envelope>[0]> = {}) => JSON.stringify(envelope({ command, box: BOX, at: AT, exit: 0, result: resultOf(v3), lines: ["Read.", "", "Now: Ready.", "Did: Nothing changed.", "Next: Type taskbox status."], ...extra }));

const STATE = { word: "Ready", detail: "Waiting for a job.", next: "Nothing to do.", notify: false } as unknown as State;
const V3 = {
  hello: helloAnswer({ tag: "v3.0.0" } as never, ID),
  status: statusAnswer({ state: STATE, installed: undefined, othersLoggedIn: 0, job: undefined, lastJob: undefined, lastJobResult: undefined, slots: { total: 2, busy: 0 } }),
  jobs: jobsAnswer([]),
  log: logAnswer([{ at: AT, text: "Took a job." }]),
  check: checkAnswer([{ name: "Sleep", status: "OK", detail: "never" }], true),
};
const COMMAND = { hello: "hello", status: "status", jobs: "job.list", log: "logs", check: "check" } as const;

describe("the envelope", () => {
  test("has every field §3.1 names, ok as exit 0, and the time to the second in UTC", () => {
    const e = envelope({ command: "drain", box: BOX, at: AT, exit: 0, changed: true, result: {}, lines: ["Drained."], next: ["taskbox resume"] });
    expect(e).toEqual({ answers: 4, command: "drain", box: BOX, at: "2026-11-23T14:02:11Z", ok: true, exit: 0, changed: true, op: null, result: {}, lines: ["Drained."], error: null, next: ["taskbox resume"], final: true });
    expect(ENVELOPE(e)).toBeUndefined();
  });

  test("lines are printable ASCII, each cut to 120 characters, at most 200, keeping the footer", () => {
    expect(cleanLine("a\u001b[31mred\u0007 ‮evil  x")).toBe("a [31mred evil x");
    expect(cleanLine("x".repeat(500)).length).toBe(120);
    const long = Array.from({ length: 1000 }, (_, i) => `line ${i}`).concat(["Next: Type taskbox check."]);
    const capped = capLines(long, "job.list");
    expect(capped.length).toBe(LINES_MAX);
    expect(capped[0]).toBe("line 0");
    expect(capped.at(-1)).toBe("Next: Type taskbox check.");
    expect(capped[150]).toBe("(802 lines left out here: taskbox job list at the box shows them all.)");
    expect(ENVELOPE(envelope({ command: "logs", box: BOX, at: AT, exit: 0, lines: long }))).toBeUndefined();
  });

  test("next holds only commands the box has, from the footer's Next line", () => {
    const known = (w: string[]) => {
      const r = parseLine(w);
      return r.ok && !r.spec.internal ? pathOf(r.spec) : undefined;
    };
    expect(nextOf(["Next: Type taskbox check, then taskbox status -w."], known)).toEqual(["taskbox check", "taskbox status"]);
    expect(nextOf(["Next: As your admin user, type taskbox update first."], known)).toEqual(["taskbox update"]);
    // A job's own text naming a command can't put one in: it isn't on the Next line.
    expect(nextOf(["Job: run taskbox remove", "Next: Nothing to do."], known)).toEqual([]);
    expect(nextOf(["Next: taskbox frobnicate, taskbox guard."], known)).toEqual([]);
  });

  test("v3's error words become errors with a code from the closed list, a cause and who acts", () => {
    expect(errorFromV3("state-unreadable")).toEqual({ code: "failed", message: "The box's state can't be shown to you.", fix: "Nothing to do: agents fix it.", who: "waits" });
    expect(errorFromV3("usage").code).toBe("usage");
    expect(errorFromV3("anything else").message).toBe("The box couldn't answer.");
  });
});

describe("versions: N and N-1 (§3.1)", () => {
  test("agree takes the highest both read; a gap of two names who updates", () => {
    expect([agree([4, 3]), agree([5, 4]), agree([3]), agree([6, 5]), agree([2, 1])]).toEqual([4, 4, 3, undefined, undefined]);
    expect(gapError([6, 5]).fix).toBe("update the box");
    expect(gapError([2, 1]).fix).toBe("update the laptop");
    expect([versionsOf("4,3"), versionsOf("4"), versionsOf("x"), versionsOf("4,"), versionsOf("0")]).toEqual([[4, 3], [4], undefined, undefined, undefined]);
  });

  test("each answer round trips through the schema in version 4, and in version 3 from a v2.6.1 box", () => {
    for (const kind of ["hello", "status", "jobs", "log", "check"] as const) {
      const v3 = V3[kind] as unknown as Record<string, unknown>;
      const extra = kind === "hello" ? { result: { ...resultOf(v3), answers: 4, reads: [4, 3], writes: [4, 3] } } : {};
      const four = readAnswer(kind, one(v3, COMMAND[kind], extra), ID);
      expect({ kind, ok: four.ok, version: four.ok && four.version }).toEqual({ kind, ok: true, version: 4 });
      const three = readAnswer(kind, JSON.stringify(v3), ID);
      expect({ kind, ok: three.ok, version: three.ok && three.version }).toEqual({ kind, ok: true, version: 3 });
      // The same fields either way; hello's v4 result also says the versions each side reads.
      if (four.ok && three.ok) expect({ ...four.answer, answers: 3 }).toMatchObject(three.answer as never);
    }
  });

  test("an unknown field is ignored in version 4, refused in version 3", () => {
    const v3 = V3.status as unknown as Record<string, unknown>;
    expect(readAnswer("status", one({ ...v3, later: 1 }, "status")).ok).toBe(true);
    const e = JSON.parse(one(v3, "status"));
    expect(readEnvelopes(JSON.stringify({ ...e, laterField: true })).ok).toBe(true);
    expect(readAnswer("status", JSON.stringify({ ...v3, later: 1 })).ok).toBe(false);
  });

  test("a version this taskbox doesn't read is told apart", () => {
    const e = JSON.parse(one(V3.status as never, "status"));
    expect(readAnswer("status", JSON.stringify({ ...e, answers: 5 }))).toEqual({ ok: false, why: "version", theirs: 5 });
    expect(readAnswer("status", JSON.stringify({ ...(V3.status as object), answers: 2 }))).toEqual({ ok: false, why: "version", theirs: 2 });
  });

  test("a box's error comes back as its cause and fix", () => {
    const err = JSON.stringify(envelope({ command: "status", box: BOX, at: AT, exit: 1, lines: ["x"], error: errorFromV3("state-unreadable") }));
    expect(readAnswer("status", err)).toEqual({ ok: false, why: "box-error", error: { code: "failed", message: "The box's state can't be shown to you.", fix: "Nothing to do: agents fix it." } });
  });
});

describe("failing closed (§3.1): every one is unreachable, never a pass", () => {
  const good = JSON.parse(one(V3.status as never, "status"));
  const cases: [string, string, Parameters<typeof readEnvelopes>[1]?][] = [
    ["no answer", ""],
    ["not JSON", "{answers: 4"],
    ["two lines", `${JSON.stringify(good)}\n${JSON.stringify(good)}`],
    ["a list", "[4]"],
    ["version 3 where an envelope was asked", JSON.stringify(V3.status)],
    ["ok and exit disagree", JSON.stringify({ ...good, ok: false })],
    ["a line with a control character", JSON.stringify({ ...good, lines: ["\u001b[2J"] })],
    ["201 lines", JSON.stringify({ ...good, lines: Array.from({ length: 201 }, () => "x") })],
    ["a line of 121 characters", JSON.stringify({ ...good, lines: ["x".repeat(121)] })],
    ["an error code off the list", JSON.stringify({ ...good, ok: false, exit: 1, error: { code: "oops", message: "x", fix: null, who: null } })],
    ["a next that isn't a command line", JSON.stringify({ ...good, next: ["rm -rf /"] })],
    ["another install's answer", JSON.stringify(good), { installId: "f".repeat(32) }],
    ["another command's answer", JSON.stringify(good), { command: "check" }],
    ["a stream with no final line", JSON.stringify({ ...good, final: false }), { stream: true }],
    ["a final line before the end", `${JSON.stringify(good)}\n${JSON.stringify(good)}`, { stream: true }],
  ];
  test("each case", () => {
    for (const [why, stdout, o] of cases) {
      const r = readEnvelopes(stdout, o);
      expect({ why, code: r.ok ? "read" : r.code }).toEqual({ why, code: "unreachable" });
    }
  });

  test("a stream whose last line alone is final reads whole", () => {
    const mid = { ...good, final: false };
    const r = readEnvelopes(`${JSON.stringify(mid)}\n${JSON.stringify(mid)}\n${JSON.stringify(good)}`, { stream: true, installId: ID });
    expect(r.ok && r.envelopes.length).toBe(3);
  });
});
