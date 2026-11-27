// Standing rules (workspace/standing.ts) and claim keys (workspace/claim.ts), pure: rules match by
// agent, claim key, size and window; no rule approves a Whole; at most 5 and 30 days; they expire.
// A claim proof works once, by its own key, for its own workspace, within 5 minutes.
import { describe, expect, test } from "bun:test";
import { lstatSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkProof, claimFor, claimKept, claimText, fingerprint, makeClaim, nextProof, parseProof, proofWord, signProof } from "../src/workspace/claim.ts";
import { emptyState, find, type WsState } from "../src/workspace/model.ts";
import { addRule, approveByRule, askRule, deleteRule, expireRules, inWindow, matchRule, MAX_RULE_MS, parseWindow, ruleLines, type RuleAsk } from "../src/workspace/standing.ts";
import { parseState, stateText } from "../src/workspace/store.ts";
import { asked, MIN, ok, OWNER, POOL, T } from "./ws-helpers.ts";

const DAY = 86_400_000;
const KEY = fingerprint(makeClaim().pub);
const OTHER = fingerprint(makeClaim().pub);
const ask = (o: Partial<Parameters<typeof askRule>[0]> = {}) => askRule({ agent: "nova", key: KEY, size: "light", window: "22:00-07:00", expiresMs: 30 * DAY, by: OWNER, now: T, ...o });
const rule = (o: Partial<Parameters<typeof askRule>[0]> = {}): RuleAsk => {
  const r = ask(o);
  if (!r.ok) throw new Error(r.why);
  return r.rule;
};
const withRule = (s: WsState, a: RuleAsk = rule(), now = T) => {
  const r = addRule(s, a, now);
  if (!r.ok) throw new Error(r.why);
  return r.state;
};

describe("windows", () => {
  test("a window may run past midnight; the same start and end isn't one", () => {
    const w = parseWindow("22:00-07:00")!;
    expect([inWindow(w, 22 * 60), inWindow(w, 23 * 60 + 59), inWindow(w, 0), inWindow(w, 6 * 60 + 59), inWindow(w, 7 * 60), inWindow(w, 12 * 60)]).toEqual([true, true, true, true, false, false]);
    const day = parseWindow("09:00-17:30")!;
    expect([inWindow(day, 9 * 60), inWindow(day, 17 * 60 + 29), inWindow(day, 17 * 60 + 30)]).toEqual([true, true, false]);
    for (const bad of ["22:00-22:00", "24:00-07:00", "7:00-8:00", "22:00", "22:00-07:00x"]) expect(parseWindow(bad)).toBeUndefined();
  });
});

describe("asking for a rule", () => {
  test("no rule approves a Whole; at most 30 days; a window; a claim key", () => {
    expect(ask({ size: "whole" })).toMatchObject({ ok: false, why: expect.stringContaining("No rule approves a Whole") });
    expect(ask({ expiresMs: MAX_RULE_MS + 1 })).toMatchObject({ ok: false });
    expect(ask({ expiresMs: MAX_RULE_MS }).ok).toBe(true);
    expect(ask({ window: "7-8" }).ok).toBe(false);
    expect(ask({ key: undefined })).toMatchObject({ ok: false, why: expect.stringContaining("no claim key") });
    expect(ask({ agent: "owner!" }).ok).toBe(false);
  });
  test("confirm shows the agent, the claim key's fingerprint, the size, the window and the expiry", () => {
    const r = ask();
    expect(r.ok && r.shows.join("\n")).toContain("nova");
    expect(r.ok && r.shows.join("\n")).toContain(KEY);
    expect(r.ok && r.shows.join("\n")).toContain("Light");
    expect(r.ok && r.shows.join("\n")).toContain("22:00-07:00");
    expect(r.ok && r.shows.join("\n")).toContain(new Date(T + 30 * DAY).toISOString().slice(0, 16));
  });
});

describe("the rules on the box", () => {
  test("at most 5; ids never given twice; expired ones go; delete applies at once", () => {
    let s = emptyState();
    for (let i = 0; i < 5; i++) s = withRule(s);
    expect(s.rules!.map((r) => r.id)).toEqual(["r_001", "r_002", "r_003", "r_004", "r_005"]);
    expect(addRule(s, rule(), T)).toMatchObject({ ok: false, why: expect.stringContaining("5 rules") });
    const d = deleteRule(s, "r_003");
    expect(d.ok && d.state.rules!.length).toBe(4);
    expect(deleteRule(s, "r_009").ok).toBe(false);
    const after = d.ok ? withRule(d.state) : s;
    expect(after.rules!.at(-1)!.id).toBe("r_006");
    const e = expireRules(after, T + 30 * DAY);
    expect(e.state.rules).toEqual([]);
    expect(e.steps.map((x) => x.type)).toEqual(Array(5).fill("rule-expired"));
    // The state reads back with its rules.
    const back = parseState(stateText(after));
    expect(back.kind).toBe("ok");
  });
  test("a rule past its expiry by the time of the yes isn't added", () => {
    expect(addRule(emptyState(), rule({ expiresMs: MIN }), T + 2 * MIN).ok).toBe(false);
  });
  test("matches by agent, claim key, a size it covers and the window, never a Whole", () => {
    const s = withRule(emptyState(), rule({ size: "heavy" }));
    const night = 23 * 60;
    expect(matchRule(s, { agent: "nova", key: KEY, size: "light" }, T, night)?.id).toBe("r_001");
    expect(matchRule(s, { agent: "nova", key: KEY, size: "heavy" }, T, night)?.id).toBe("r_001");
    expect(matchRule(s, { agent: "nova", key: KEY, size: "whole" }, T, night)).toBeUndefined();
    // Another agent claiming the name, with its own key, doesn't match.
    expect(matchRule(s, { agent: "nova", key: OTHER, size: "light" }, T, night)).toBeUndefined();
    expect(matchRule(s, { agent: "nova", key: undefined, size: "light" }, T, night)).toBeUndefined();
    expect(matchRule(s, { agent: "orion", key: KEY, size: "light" }, T, night)).toBeUndefined();
    expect(matchRule(s, { agent: "nova", key: KEY, size: "light" }, T, 12 * 60)).toBeUndefined();
    expect(matchRule(s, { agent: "nova", key: KEY, size: "light" }, T + 30 * DAY, night)).toBeUndefined();
    const light = withRule(emptyState(), rule({ size: "light" }));
    expect(matchRule(light, { agent: "nova", key: KEY, size: "heavy" }, T, night)).toBeUndefined();
  });
  test("a matched request is approved by the rule, counted, and its card names the rule", () => {
    const s = withRule(asked(emptyState(), "nova", "light"));
    const r = approveByRule(s, "nova-1", s.rules![0]!, POOL, T + MIN);
    if (!r.ok) throw new Error(r.why);
    expect(find(r.state, "nova-1")).toMatchObject({ state: "approved", rule: "r_001", user: "taskbox-ws1" });
    expect(find(r.state, "nova-1")!.by).toMatch(/^rule r_001 \(signed \d+ \w+\)$/);
    expect(r.state.rules![0]!.uses).toBe(1);
    expect(r.steps[0]!.type).toBe("rule-matched");
    expect(ruleLines(r.state, T)[0]).toContain("1 used");
    parseState(stateText(r.state));
  });
});

describe("claim keys", () => {
  test("a proof by the key, for its workspace, newer and on time, is taken once", () => {
    const k = makeClaim();
    const p = signProof(k.pem, "progress", "nova-3", 10, T);
    expect(parseProof(proofWord(p))).toEqual(p);
    expect(checkProof({ key: k.pub, n: 0 }, "progress", "nova-3", p, T)).toEqual({ ok: true, n: 10 });
    expect(checkProof({ key: k.pub, n: 10 }, "progress", "nova-3", p, T)).toMatchObject({ ok: false, why: expect.stringContaining("used before") });
    expect(checkProof({ key: k.pub, n: 0 }, "progress", "nova-4", p, T)).toMatchObject({ ok: false, why: expect.stringContaining("isn't by") });
    expect(checkProof({ key: k.pub, n: 0 }, "end", "nova-3", p, T)).toMatchObject({ ok: false, why: expect.stringContaining("for end") });
    expect(checkProof({ key: makeClaim().pub, n: 0 }, "progress", "nova-3", p, T)).toMatchObject({ ok: false });
    expect(checkProof({ key: k.pub, n: 0 }, "progress", "nova-3", p, T + 5 * MIN + 1)).toMatchObject({ ok: false, why: expect.stringContaining("5 minutes") });
    expect(checkProof({ key: k.pub, n: 0 }, "progress", "nova-3", undefined, T)).toMatchObject({ ok: false, why: expect.stringContaining("no proof") });
    // A signature over other text doesn't pass: the step is in it.
    expect(claimText("connect", "nova-3", 1, T)).toBe(`taskbox-claim v2\nconnect\nnova-3\n1\n${T}\n`);
    for (const bad of ["1.2", "0.1." + "A".repeat(86), "x"]) expect(parseProof(bad)).toBeUndefined();
  });
  test("the requesting side keeps one key per box and agent at 0600, and counts up", () => {
    const home = mkdtempSync(join(tmpdir(), "claims-"));
    const a = claimFor(home, "taskbox-1", "nova");
    expect(claimFor(home, "taskbox-1", "nova").pub).toBe(a.pub);
    expect(claimFor(home, "taskbox-2", "nova").pub).not.toBe(a.pub);
    const path = join(home, ".taskbox", "claims", "taskbox-1", "nova.key");
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    expect(lstatSync(join(home, ".taskbox", "claims", "taskbox-1")).mode & 0o777).toBe(0o700);
    expect(claimKept(home, "taskbox-1", "orion")).toBeUndefined();
    const p1 = nextProof(home, "taskbox-1", "end", "nova-3", T)!;
    const p2 = nextProof(home, "taskbox-1", "end", "nova-3", T)!;
    expect(p2.n).toBeGreaterThan(p1.n);
    expect(checkProof({ key: a.pub, n: p1.n }, "end", "nova-3", p2, T)).toEqual({ ok: true, n: p2.n });
    expect(nextProof(home, "taskbox-1", "end", "orion-4", T)).toBeUndefined();
    expect(readFileSync(path, "utf8")).toContain("PRIVATE KEY");
    expect(() => claimFor(home, "../x", "nova")).toThrow();
  });
});
