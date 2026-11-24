// Every timer in src goes through the clock (src/clock.ts), so the fake clock drives them all in a
// test. This reads src and fails on any direct timer call outside clock.ts.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { realClock } from "../src/clock.ts";

const SRC = join(import.meta.dir, "../src");
const CLOCK = "clock.ts";

// The names that start or end a real timer, wherever they appear: setTimeout(f), globalThis.setTimeout,
// a socket's s.setTimeout, or typeof setTimeout.
const TIMER_NAMES = new Set(["setTimeout", "setInterval", "setImmediate", "clearTimeout", "clearInterval", "clearImmediate"]);
// The reads of the real time, and the waits, as object.name.
const TIMER_MEMBERS = new Set(["Date.now", "Bun.sleep", "Bun.sleepSync", "Bun.nanoseconds", "performance.now", "process.hrtime", "AbortSignal.timeout", "Atomics.wait"]);
const TIMER_MODULES = new Set(["timers", "node:timers", "timers/promises", "node:timers/promises"]);

// Each direct timer call in one file's text, as "line: what".
function timerCalls(text: string, file = "x.ts"): string[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: string[] = [];
  const at = (n: ts.Node, what: string) => found.push(`${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}: ${what}`);
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && TIMER_NAMES.has(n.text)) at(n, n.text);
    else if (ts.isPropertyAccessExpression(n) && TIMER_MEMBERS.has(`${n.expression.getText(sf)}.${n.name.text}`)) at(n, `${n.expression.getText(sf)}.${n.name.text}`);
    else if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression) && TIMER_NAMES.has(n.argumentExpression.text)) at(n, n.argumentExpression.text);
    // new Date() reads the time; new Date(t) only formats t.
    else if (ts.isNewExpression(n) && n.expression.getText(sf) === "Date" && !n.arguments?.length) at(n, "new Date()");
    else if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier) && TIMER_MODULES.has(n.moduleSpecifier.text)) at(n, `import ${n.moduleSpecifier.text}`);
    else if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteral(n.arguments[0]) && TIMER_MODULES.has(n.arguments[0].text)) at(n, `import ${n.arguments[0].text}`);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

function srcFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? srcFiles(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []));
}

describe("every timer goes through the clock", () => {
  test("src calls no timer directly outside clock.ts", () => {
    const files = srcFiles(SRC);
    expect(files.length).toBeGreaterThan(50);
    const found = files
      .filter((f) => relative(SRC, f) !== CLOCK)
      .flatMap((f) => timerCalls(readFileSync(f, "utf8"), f).map((c) => `src/${relative(SRC, f)}:${c}`));
    expect(found).toEqual([]);
  });

  test("the check finds each way of reaching a real timer, and not a mention in a comment or a string", () => {
    const bad = [
      "setTimeout(f, 10);",
      "const t = setInterval(f, 10); clearInterval(t);",
      "globalThis.setTimeout(f, 1);",
      'globalThis["setTimeout"](f, 1);',
      "socket.setTimeout(3000, f);",
      "let t: ReturnType<typeof setTimeout>;",
      "setImmediate(f);",
      "const now = Date.now();",
      "const n = Date.now;",
      "const d = new Date();",
      "await Bun.sleep(5);",
      "const t = performance.now();",
      "fetch(u, { signal: AbortSignal.timeout(5) });",
      'import { setTimeout as wait } from "node:timers/promises";',
      'const m = await import("timers");',
    ];
    for (const line of bad) expect([line, timerCalls(line).length > 0]).toEqual([line, true]);
    const fine = ["// setTimeout(f, 10) and Date.now()", 'const s = "Date.now() and setTimeout";', "const d = new Date(t).toISOString();", "await sys.sleep(5);", "const t = sys.now();", "clock.after(5, f);", "fetch(u, { signal: sys.timeout(5) });"];
    for (const line of fine) expect([line, timerCalls(line)]).toEqual([line, []]);
  });

  test("clock.ts holds the real timers, and only them", () => {
    const own = timerCalls(readFileSync(join(SRC, CLOCK), "utf8")).map((c) => c.replace(/^\d+: /, ""));
    expect(new Set(own)).toEqual(new Set(["Date.now", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "AbortSignal.timeout"]));
  });

  test("the real clock's timers run, and a cancelled one doesn't", async () => {
    const fired: string[] = [];
    const cancel = realClock.after(5, () => fired.push("cancelled"));
    realClock.after(5, () => fired.push("after"));
    cancel();
    const stop = realClock.every(2, () => fired.push("every"));
    const t0 = realClock.now();
    await realClock.sleep(20);
    stop();
    expect(realClock.now() - t0).toBeGreaterThanOrEqual(15);
    expect(fired).toContain("after");
    expect(fired).toContain("every");
    expect(fired).not.toContain("cancelled");
    const signal = realClock.timeout(1);
    await realClock.sleep(10);
    expect(signal.aborted).toBe(true);
  });
});
