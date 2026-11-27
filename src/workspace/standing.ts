// Standing rules: the owner signs a rule once (workspace rule add), an admin confirms it at the box
// (taskbox confirm, which shows the agent, its claim-key fingerprint, the size, the window and the
// expiry), and from then the guard approves that agent's matching requests with no touch. Each card
// says which rule approved it. Pure: every step takes the time, and the minute of the box's day.
//
// Bounds: no rule approves a Whole; a rule lasts at most 30 days; at most 5 rules. A rule names a
// claim key as well as a name, so another agent claiming the name doesn't match. Narrowing never
// waits: a rule is deleted at once.
import { FINGERPRINT } from "./claim.ts";
import { AGENT, fitsIn, put, move, type Size, type Step, type StandingRule, type WsState, find, assign, SIZE_WORD } from "./model.ts";

export const MAX_RULES = 5;
export const MAX_RULE_MS = 30 * 86_400_000;
export const RULE_ID = /^r_[0-9a-z]{3,8}$/;
const WINDOW = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;

export type RuleAsk = Omit<StandingRule, "id" | "uses">;

// "22:00-07:00" as minutes of the day; a window may run past midnight. The same start and end isn't one.
export function parseWindow(v: string): { from: number; to: number } | undefined {
  const m = WINDOW.exec(v);
  if (!m) return undefined;
  const from = Number(m[1]) * 60 + Number(m[2]);
  const to = Number(m[3]) * 60 + Number(m[4]);
  return from === to ? undefined : { from, to };
}
const hhmm = (n: number) => `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
export const windowWord = (w: { from: number; to: number }) => `${hhmm(w.from)}-${hhmm(w.to)}`;
export const inWindow = (w: { from: number; to: number }, minute: number) => (w.from < w.to ? minute >= w.from && minute < w.to : minute >= w.from || minute < w.to);
// The minute of the box's own day, in its own time zone, as the owner reads a window.
export const minuteOf = (at: number) => {
  const d = new Date(at);
  return d.getHours() * 60 + d.getMinutes();
};
const dayWord = (at: number) => new Date(at).toUTCString().slice(5, 11).replace(/^0/, "");

// A rule as the owner asked it, checked, and the lines confirm shows. Not yet a rule: it waits for
// the admin's yes at the box.
export function askRule(o: { agent: string; key: string | undefined; size: string; window: string; expiresMs: number; by: string; now: number }): { ok: true; rule: RuleAsk; shows: string[] } | { ok: false; why: string } {
  if (!AGENT.test(o.agent)) return { ok: false, why: "--agent is an agent's name, such as nova." };
  if (o.size === "whole") return { ok: false, why: "No rule approves a Whole: each Whole needs its own approval." };
  if (o.size !== "light" && o.size !== "heavy") return { ok: false, why: "--size is light or heavy." };
  const w = parseWindow(o.window);
  if (!w) return { ok: false, why: "--window is HH:MM-HH:MM in the box's time, such as 22:00-07:00." };
  if (!Number.isSafeInteger(o.expiresMs) || o.expiresMs <= 0 || o.expiresMs > MAX_RULE_MS) return { ok: false, why: "--expires is at most 30 days, such as 30d." };
  if (!o.key || !FINGERPRINT.test(o.key)) return { ok: false, why: `${o.agent} has no claim key on this box yet. It asks for a workspace once, then the rule can name its key.` };
  const rule: RuleAsk = { agent: o.agent, key: o.key, size: o.size, window: w, expiresAt: o.now + o.expiresMs, signedAt: o.now, by: o.by.slice(0, 120) };
  return { ok: true, rule, shows: showsOf(rule) };
}

export function showsOf(r: RuleAsk): string[] {
  return [`A standing rule for ${r.agent}: its ${SIZE_WORD[r.size]} requests approve themselves, with no touch.`, `Claim key: ${r.key}`, `Window: ${windowWord(r.window)}, in the box's time`, `Expires: ${new Date(r.expiresAt).toISOString().slice(0, 16)}Z`, `Signed by ${r.by.slice(0, 80)}`];
}

export function ruleProblem(v: unknown): string | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return "a rule isn't an object";
  const r = v as Record<string, unknown>;
  const t = (x: unknown) => Number.isSafeInteger(x) && (x as number) > 0;
  const win = r.window as Record<string, unknown> | undefined;
  if (typeof r.id !== "string" || !RULE_ID.test(r.id)) return "a rule's id isn't one taskbox reads";
  if (typeof r.agent !== "string" || !AGENT.test(r.agent)) return "a rule's agent isn't one taskbox reads";
  if (typeof r.key !== "string" || !FINGERPRINT.test(r.key)) return "a rule's claim key isn't one taskbox reads";
  if (r.size !== "light" && r.size !== "heavy") return "a rule's size is light or heavy";
  if (!win || typeof win !== "object" || ![win.from, win.to].every((x) => Number.isInteger(x) && (x as number) >= 0 && (x as number) < 1440) || win.from === win.to) return "a rule's window isn't one taskbox reads";
  if (!t(r.expiresAt) || !t(r.signedAt) || (r.expiresAt as number) - (r.signedAt as number) > MAX_RULE_MS) return "a rule's times aren't ones taskbox reads";
  if (typeof r.by !== "string" || r.by.length > 120 || !/^[\x20-\x7e]*$/.test(r.by)) return "a rule's signer isn't one taskbox reads";
  if (!Number.isSafeInteger(r.uses) || (r.uses as number) < 0) return "a rule's uses aren't a count";
  return undefined;
}

const rulesOf = (s: WsState) => s.rules ?? [];

// The admin's yes at the box: the rule joins, with its id. The bounds are read again here.
export function addRule(s: WsState, a: RuleAsk, now: number): { ok: true; state: WsState; rule: StandingRule; steps: Step[] } | { ok: false; why: string } {
  const live = rulesOf(s).filter((r) => r.expiresAt > now);
  if (a.expiresAt <= now) return { ok: false, why: "That rule expired before it was confirmed." };
  if (live.length >= MAX_RULES) return { ok: false, why: `${MAX_RULES} rules are on this box already, the most. taskbox workspace rule delete removes one.` };
  const seq = (s.ruleSeq ?? 0) + 1;
  const rule: StandingRule = { ...a, id: `r_${seq.toString(36).padStart(3, "0")}`, uses: 0 };
  return { ok: true, state: { ...s, ruleSeq: seq, rules: [...live, rule] }, rule, steps: [{ name: rule.id, type: "rule-added", text: `rule ${rule.id} added: ${rule.agent}'s ${SIZE_WORD[rule.size]} requests, ${windowWord(rule.window)}, until ${dayWord(rule.expiresAt)}` }] };
}

export function deleteRule(s: WsState, id: string): { ok: true; state: WsState; steps: Step[] } | { ok: false; why: string } {
  if (!rulesOf(s).some((r) => r.id === id)) return { ok: false, why: `No rule ${id} on this box. taskbox workspace rule list shows them.` };
  return { ok: true, state: { ...s, rules: rulesOf(s).filter((r) => r.id !== id) }, steps: [{ name: id, type: "rule-deleted", text: `rule ${id} deleted` }] };
}

// Expired rules leave the list.
export function expireRules(s: WsState, now: number): { state: WsState; steps: Step[] } {
  const gone = rulesOf(s).filter((r) => r.expiresAt <= now);
  if (!gone.length) return { state: s, steps: [] };
  return { state: { ...s, rules: rulesOf(s).filter((r) => r.expiresAt > now) }, steps: gone.map((r) => ({ name: r.id, type: "rule-expired", text: `rule ${r.id} for ${r.agent} expired` })) };
}

// The rule that approves a request, or undefined: its agent and claim key, a size no bigger than
// the rule's, never a Whole, inside the window, before it expires.
export function matchRule(s: WsState, o: { agent: string; key: string | undefined; size: Size }, now: number, minute: number): StandingRule | undefined {
  if (o.size === "whole" || !o.key) return undefined;
  return rulesOf(s).find((r) => r.agent === o.agent && r.key === o.key && fitsIn(o.size, r.size) && r.expiresAt > now && inWindow(r.window, minute));
}

// A request a rule matched: approved at its size, by the rule, with the rule's use counted.
export function approveByRule(s: WsState, name: string, rule: StandingRule, pool: readonly string[], now: number): { ok: true; state: WsState; said: string; steps: Step[] } | { ok: false; why: string } {
  const w = find(s, name);
  if (!w || w.state !== "requested") return { ok: false, why: `${name} isn't a request.` };
  if (!pool.length) return { ok: false, why: "This box has no pool account, so no workspace can start." };
  const by = `rule ${rule.id} (signed ${dayWord(rule.signedAt)})`;
  const next = move(w, "approved", now, { approvedAt: now, by, order: s.orderSeq + 1, rule: rule.id });
  const counted: WsState = { ...s, orderSeq: s.orderSeq + 1, rules: rulesOf(s).map((x) => (x.id === rule.id ? { ...x, uses: x.uses + 1 } : x)) };
  const a = assign(put(counted, next), pool, now);
  return { ok: true, state: a.state, said: `${name} approved by ${by}. It starts when its room is free.`, steps: [{ name, type: "rule-matched", text: `${name} approved by ${by}` }, ...a.steps] };
}

// The rules as rule list shows them.
export function ruleLines(s: WsState | undefined, now: number): string[] {
  const list = s ? rulesOf(s) : [];
  if (!list.length) return ["No standing rules on this box."];
  return list.map((r) => `${r.id}  ${r.agent}  ${SIZE_WORD[r.size]}  ${windowWord(r.window)}  ${r.expiresAt > now ? `until ${new Date(r.expiresAt).toISOString().slice(0, 10)}` : "expired"}  ${r.uses} used  key ${r.key.slice(0, 20)}  by ${r.by}`.slice(0, 160));
}
