// Guarded keys: a setting that widens who or what reaches the box, moves trust, gives workspaces more
// of the box, or silences an alarm or evidence. A merged commit that widens one doesn't apply by
// itself: it waits for the owner's signed settings apply, and a first-tier key then also for confirm
// at the box. Narrowing applies at once. Each rule names a path; a change anywhere under it counts.
import { REACH_KEYS } from "./accounts.ts";

export type Tier = 1 | 2;
type Doc = Record<string, unknown>;

export interface Rule {
  path: string;
  tier: Tier;
  why: string;
  // Whether going from one value to the other only narrows. Absent: every change widens.
  narrows?: (from: unknown, to: unknown) => boolean;
}

// The canonical text of a value: keys sorted at every depth, so key order never counts as a change.
export function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Doc)[k])}`).join(",")}}`;
  return v === undefined ? "null" : JSON.stringify(v);
}
const same = (a: unknown, b: unknown) => stable(a) === stable(b);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]);
// Every item of to is one of from's: a person, a pin or a workflow taken away, none added or changed.
const subset = (from: unknown, to: unknown) => {
  const had = new Set(list(from).map(stable));
  return list(to).every((x) => had.has(stable(x)));
};
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const atMost = (from: unknown, to: unknown) => num(from) !== undefined && num(to) !== undefined && num(to)! <= num(from)!;
const atLeast = (from: unknown, to: unknown) => num(from) !== undefined && num(to) !== undefined && num(to)! >= num(from)!;
// Fewer pool accounts, or none: the same prefix, a smaller size.
const fewerPool = (from: unknown, to: unknown) => {
  if (to === undefined) return true;
  const f = from as { pool?: unknown; size?: unknown } | undefined;
  const t = to as { pool?: unknown; size?: unknown };
  return !!f && f.pool === t.pool && Object.keys(t).every((k) => k === "pool" || k === "size") && atMost(f.size, t.size);
};

const REACH_WHY: Record<(typeof REACH_KEYS)[number], string> = {
  "accounts.service": "who runs the loop",
  "accounts.agent": "who has taskbox's shell and the tailnet's accept rules",
  "accounts.ssh": "who reaches the box by Tailscale SSH",
  "accounts.people": "who reaches the box",
  "accounts.workspaces": "how many pool accounts exist",
  tailnetTag: "which of the tailnet's rules reach the box",
};
const REACH_NARROWS: Partial<Record<(typeof REACH_KEYS)[number], Rule["narrows"]>> = { "accounts.ssh": subset, "accounts.people": subset, "accounts.workspaces": fewerPool };

export const RULES: readonly Rule[] = [
  // First tier: reach and trust.
  ...REACH_KEYS.map((path): Rule => ({ path, tier: 1, why: REACH_WHY[path], ...(REACH_NARROWS[path] ? { narrows: REACH_NARROWS[path] } : {}) })),
  // Narrows when it goes, or ends sooner for the same person and user.
  { path: "adminSsh", tier: 1, why: "who reaches an admin user by Tailscale SSH", narrows: (f, t) => t === undefined || (!!f && typeof f === "object" && (f as Doc).login === (t as Doc).login && (f as Doc).user === (t as Doc).user && Date.parse(String((t as Doc).until)) <= Date.parse(String((f as Doc).until))) },
  { path: "screenSharingUsers", tier: 1, why: "who reaches the box by Screen Sharing", narrows: subset },
  { path: "runnerGroup", tier: 1, why: "which workflows reach the box's runners" },
  { path: "jobsFrom", tier: 1, why: "whose jobs the box runs" },
  { path: "org", tier: 1, why: "the organisation the box trusts" },
  { path: "appId", tier: 1, why: "the App the box trusts" },
  { path: "actionsAppId", tier: 1, why: "the App the box trusts" },
  { path: "sources", tier: 1, why: "the App and repos the box reads jobs from" },
  { path: "runnerApp", tier: 1, why: "the App the box trusts" },
  { path: "settingsRepo", tier: 1, why: "where the box's settings come from" },
  { path: "repo", tier: 1, why: "where the box's code comes from" },
  { path: "releaseRepo", tier: 1, why: "where the box's code comes from" },
  { path: "publicRepo", tier: 1, why: "where the box's code comes from" },
  { path: "approverKey", tier: 1, why: "whose signature the box trusts" },
  { path: "approverKeyChange", tier: 1, why: "whose signature the box trusts" },
  { path: "update.channel", tier: 1, why: "what installs by itself", narrows: (_f, t) => t === undefined || t === "stable" },
  // Second tier: more of the box, or less evidence.
  { path: "workspaces", tier: 2, why: "gives workspaces more of the box" },
  { path: "away", tier: 2, why: "could silence an alarm" },
  { path: "update.auto", tier: 2, why: "times what installs by itself", narrows: (_f, t) => t === false },
  { path: "update.window", tier: 2, why: "times what installs by itself" },
  { path: "update.delayHours", tier: 2, why: "times what installs by itself", narrows: atLeast },
  { path: "minFreeDiskGB", tier: 2, why: "the box's own room; at 0 the disk can fill", narrows: atLeast },
  { path: "boxKeepsGB", tier: 2, why: "the box's own room", narrows: atLeast },
  { path: "vmMaxHours", tier: 2, why: "how long a VM may live", narrows: atMost },
  { path: "network.diagnostics", tier: 2, why: "evidence", narrows: (_f, t) => t !== "off" },
  { path: "tools.entries", tier: 2, why: "what every job starts with", narrows: subset },
  { path: "tools.enabled", tier: 2, why: "what every job starts with", narrows: (_f, t) => t === false },
  { path: "image", tier: 2, why: "what every macOS job VM boots" },
  { path: "linux.image", tier: 2, why: "what every Linux job VM boots" },
];

const PART = /^[A-Za-z][A-Za-z0-9]{0,40}$/;
// The value at a dotted path, or undefined. Only own keys are read.
export function at(doc: unknown, path: string): unknown {
  let v: unknown = doc;
  for (const k of path.split(".")) {
    if (!v || typeof v !== "object" || Array.isArray(v) || !Object.hasOwn(v, k)) return undefined;
    v = (v as Doc)[k];
  }
  return v;
}
// A copy of doc with the path set to value, or taken out when value is undefined. Paths come from
// RULES only, never from a file.
export function put(doc: Doc, path: string, value: unknown): Doc {
  const parts = path.split(".");
  if (!parts.every((p) => PART.test(p))) throw new Error(`${path} isn't a settings path`);
  const out = structuredClone(doc);
  let o: Doc = out;
  for (const k of parts.slice(0, -1)) {
    const next = Object.hasOwn(o, k) ? o[k] : undefined;
    if (next === undefined && value === undefined) return out;
    if (!next || typeof next !== "object" || Array.isArray(next)) o[k] = {};
    o = o[k] as Doc;
  }
  const last = parts.at(-1)!;
  if (value === undefined) delete o[last];
  else o[last] = structuredClone(value);
  return out;
}

export interface Change {
  path: string;
  tier: Tier;
  narrows: boolean;
  from: unknown;
  to: unknown;
  words: string; // the box's own words for it, whole, for the Touch ID sheet, settings show and confirm
}

// A change's words are never cut: confirm shows each one whole, wrapped to its lines. A change too
// long to show whole, or a commit with more lines than confirm shows, is refused (core/pending.ts).
export const WORDS_MAX = 2000;
const shown = (v: unknown) => (v === undefined ? "nothing" : stable(v).replace(/[^\x20-\x7e]/g, " "));
export const wordsOf = (path: string, from: unknown, to: unknown, why: string): string => `${path}: ${shown(from)} to ${shown(to)} (${why})`;


// Each guarded key that differs between the settings in force and a commit's.
export function guardedChanges(from: Doc, to: Doc): Change[] {
  const out: Change[] = [];
  for (const r of RULES) {
    const a = at(from, r.path);
    const b = at(to, r.path);
    if (same(a, b)) continue;
    out.push({ path: r.path, tier: r.tier, narrows: r.narrows?.(a, b) === true, from: a, to: b, words: wordsOf(r.path, a, b, r.why) });
  }
  return out;
}

// Whether a path is guarded: it is a rule's path, or lies under or over one.
export const guarded = (path: string): boolean => RULES.some((r) => path === r.path || path.startsWith(`${r.path}.`) || r.path.startsWith(`${path}.`));

// A commit's settings with each widening change held back at the value in force.
export function holdBack(to: Doc, from: Doc, held: readonly string[]): Doc {
  let out = to;
  for (const p of held) out = put(out, p, at(from, p));
  return out;
}

// The same, with the paths given taken from the commit: what in force becomes once they apply.
export function letThrough(inForce: Doc, commit: Doc, paths: readonly string[]): Doc {
  let out = inForce;
  for (const p of paths) out = put(out, p, at(commit, p));
  return out;
}
