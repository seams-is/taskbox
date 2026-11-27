// The settings in force, from the settings repo: root's guard is their one writer, in its own folder
// of the state, /opt/taskbox-state/settings (root's, 755). Every reader takes them from here, the
// loop and check too, so a job that escaped to the service account can't feed root a settings file.
// - commits/<sha>.json: a commit's files as the guard fetched and validated them;
// - inforce.json: what is in force now, the commit's settings with any widening guarded key held at
//   its old value (guarded.ts);
// - state.json: the settings op's own record: the head read, the commit in use, what waits.
import { lstatSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { isObj, plain, readOwnedJson, type Read, time, updateOwnedJson, writeOwnedText, type WriteRules } from "../core/rootfile.ts";
import { type Change, WORDS_MAX } from "./guarded.ts";

export const SETTINGS_V = 1;
export const DOC_MAX = 256 * 1024;
export const SHA = /^[0-9a-f]{40}$/;
export const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;

export interface SettingsFiles {
  dir: string;
  commits: string;
  commit: (sha: string) => string;
  inForce: string;
  state: string;
}
export function settingsFiles(stateDir: string): SettingsFiles {
  const dir = join(stateDir, "settings");
  return {
    dir,
    commits: join(dir, "commits"),
    commit: (sha) => {
      if (!SHA.test(sha)) throw new Error("not a commit's SHA");
      return join(dir, "commits", `${sha}.json`);
    },
    inForce: join(dir, "inforce.json"),
    state: join(dir, "state.json"),
  };
}
// From an install's app folder, /opt/taskbox/app, the state folder beside it, /opt/taskbox-state.
export const settingsFilesForApp = (app: string): SettingsFiles => settingsFiles(join(dirname(dirname(app)), "taskbox-state"));

// A commit as the guard validated it: the product file and the overlay's kept keys, apart, so
// settings show can say where each key came from, and their layering.
export interface Validated {
  v: 1;
  sha: string;
  repo: string;
  box: string; // the overlay's name, boxes/<box>.json
  product: Record<string, unknown>;
  overlay: Record<string, unknown> | null; // the overlay's kept keys, or null when there is none
  doc: Record<string, unknown>; // product with the overlay over it
  unknown: string[]; // product keys this release doesn't know
  overlayIgnored: string[]; // overlay keys outside its class
  overlayProblem?: string; // the overlay failed, so doc is the product file alone
  readAt: number;
}

export interface InForce {
  v: 1;
  sha: string;
  at: number;
  held: string[]; // guarded paths still at their old value
  doc: Record<string, unknown>;
  overlayKeys: string[];
  overlayIgnored: string[];
  overlayProblem?: string;
  unknown: string[];
}

export type Phase = "needs-owner" | "needs-confirm";
export interface Waiting {
  sha: string;
  op: string;
  phase: Phase;
  changes: Change[]; // the widening guarded changes, both tiers, as the commit makes them
  first: boolean; // the box's first commit: confirm stands in for settings apply
  pending?: string; // the confirm item, once raised
  shown?: string; // sha256 of the lines that confirm item shows: a yes applies only those words
  appliedBy?: string; // who signed settings apply
}

export interface SettingsState {
  v: 1;
  repo?: string;
  head?: { sha: string; etag?: string; readAt: number };
  inUse?: string;
  problem?: { sha?: string; why: string; at: number };
  waiting?: Waiting;
  // An admin's yes at the box, written by confirm, for the guard to apply on its next tick.
  confirmed?: { pending: string; sha: string; by: string; at: number; yes: boolean }[];
  readNow?: boolean; // read the head on the next tick, not the next hour
  passed?: string; // a commit whose guarded changes were refused or withdrawn: not taken again
  // A commit whose keys change a job VM: it waits for the update window, then a drain, then applies
  // (update/gate.ts). held: its guarded paths still held back.
  deferred?: { sha: string; op: string; held: string[]; drained?: boolean };
}
export const noState = (): SettingsState => ({ v: 1 });

const strings = (v: unknown, n: number, max: number) => Array.isArray(v) && v.length <= n && v.every((x) => plain(x, max));

export function parseValidated(v: unknown): Validated | string {
  if (!isObj(v) || v.v !== SETTINGS_V || typeof v.sha !== "string" || !SHA.test(v.sha) || typeof v.repo !== "string" || !REPO.test(v.repo) || !plain(v.box, 63)) return "it isn't a validated commit taskbox reads";
  if (!isObj(v.product) || !(v.overlay === null || isObj(v.overlay)) || !isObj(v.doc)) return "its files aren't objects";
  if (!strings(v.unknown, 200, 60) || !strings(v.overlayIgnored, 200, 60) || !(v.overlayProblem === undefined || plain(v.overlayProblem, 240)) || !time(v.readAt)) return "its notes aren't ones taskbox reads";
  return v as unknown as Validated;
}

export function parseInForce(v: unknown): InForce | string {
  if (!isObj(v) || v.v !== SETTINGS_V || typeof v.sha !== "string" || !SHA.test(v.sha) || !time(v.at)) return "it isn't settings in force taskbox reads";
  if (!isObj(v.doc) || !strings(v.held, 100, 60) || !strings(v.overlayKeys, 100, 60) || !strings(v.overlayIgnored, 200, 60) || !strings(v.unknown, 200, 60)) return "its settings aren't ones taskbox reads";
  if (!(v.overlayProblem === undefined || plain(v.overlayProblem, 240))) return "its overlay note isn't a short line";
  return v as unknown as InForce;
}

function changeOk(c: unknown): boolean {
  return isObj(c) && plain(c.path, 60) && (c.tier === 1 || c.tier === 2) && typeof c.narrows === "boolean" && plain(c.words, WORDS_MAX);
}
export function parseState(v: unknown): SettingsState | string {
  if (!isObj(v) || v.v !== SETTINGS_V) return "it isn't a settings state taskbox reads";
  if (v.repo !== undefined && !(typeof v.repo === "string" && REPO.test(v.repo))) return "its repo isn't one";
  if (v.head !== undefined && !(isObj(v.head) && typeof v.head.sha === "string" && SHA.test(v.head.sha) && (v.head.etag === undefined || plain(v.head.etag, 200)) && time(v.head.readAt))) return "its head isn't one taskbox reads";
  if (v.inUse !== undefined && !(typeof v.inUse === "string" && SHA.test(v.inUse))) return "its commit in use isn't a SHA";
  if (v.problem !== undefined && !(isObj(v.problem) && plain(v.problem.why, 240) && time(v.problem.at) && (v.problem.sha === undefined || (typeof v.problem.sha === "string" && SHA.test(v.problem.sha))))) return "its problem isn't one taskbox reads";
  const w = v.waiting;
  if (w !== undefined) {
    if (!isObj(w) || typeof w.sha !== "string" || !SHA.test(w.sha) || typeof w.op !== "string" || !/^op_[0-9A-HJKMNP-TV-Z]{26}$/.test(w.op)) return "what waits isn't one taskbox reads";
    if ((w.phase !== "needs-owner" && w.phase !== "needs-confirm") || typeof w.first !== "boolean" || !Array.isArray(w.changes) || w.changes.length > 60 || !w.changes.every(changeOk)) return "what waits isn't one taskbox reads";
    if ((w.pending !== undefined && !(typeof w.pending === "string" && /^pc_[0-9A-HJKMNP-TV-Z]{26}$/.test(w.pending))) || (w.appliedBy !== undefined && !plain(w.appliedBy, 120)) || (w.shown !== undefined && !(typeof w.shown === "string" && /^[0-9a-f]{64}$/.test(w.shown)))) return "what waits isn't one taskbox reads";
  }
  if (v.confirmed !== undefined && !(Array.isArray(v.confirmed) && v.confirmed.length <= 20 && v.confirmed.every((c) => isObj(c) && typeof c.pending === "string" && typeof c.sha === "string" && SHA.test(c.sha) && plain(c.by, 120) && time(c.at) && typeof c.yes === "boolean"))) return "its confirmations aren't ones taskbox reads";
  if (v.readNow !== undefined && typeof v.readNow !== "boolean") return "its readNow isn't true or false";
  if (v.passed !== undefined && !(typeof v.passed === "string" && SHA.test(v.passed))) return "its passed commit isn't a SHA";
  const df = v.deferred;
  if (df !== undefined && !(isObj(df) && typeof df.sha === "string" && SHA.test(df.sha) && typeof df.op === "string" && /^op_[0-9A-HJKMNP-TV-Z]{26}$/.test(df.op) && Array.isArray(df.held) && df.held.length <= 60 && df.held.every((h) => plain(h, 120)) && (df.drained === undefined || typeof df.drained === "boolean"))) return "what is deferred isn't one taskbox reads";
  return v as unknown as SettingsState;
}

export const readValidated = (f: SettingsFiles, sha: string, rootUid = 0): Read<Validated> => readOwnedJson(f.commit(sha), { owner: rootUid, max: 4 * DOC_MAX }, parseValidated);
export const readInForce = (f: SettingsFiles, rootUid = 0): Read<InForce> => readOwnedJson(f.inForce, { owner: rootUid, max: 2 * DOC_MAX }, parseInForce);
export const readState = (f: SettingsFiles, rootUid = 0): Read<SettingsState> => readOwnedJson(f.state, { owner: rootUid, max: DOC_MAX }, parseState);

export interface Writer {
  rootUid?: number;
  chown?: WriteRules["chown"];
}
const rules = (w: Writer): WriteRules => ({ mode: 0o644, owner: w.rootUid ?? 0, ...(w.chown ? { chown: w.chown } : {}) });

// Root's folders for the settings, made 755 when missing. One that is there and isn't root's alone
// is refused: nothing is written into a folder another account could change.
export function makeFolders(f: SettingsFiles, w: Writer): void {
  for (const d of [f.dir, f.commits]) {
    try {
      mkdirSync(d, { mode: 0o755 });
      w.chown?.(d, w.rootUid ?? 0, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const st = lstatSync(d);
    if (!st.isDirectory() || st.uid !== (w.rootUid ?? 0) || (st.mode & 0o022) !== 0) throw new Error(`${d} isn't root's alone`);
  }
}

export function writeValidated(f: SettingsFiles, v: Validated, w: Writer): void {
  makeFolders(f, w);
  writeOwnedText(f.commit(v.sha), `${JSON.stringify(v)}\n`, rules(w));
}
export function writeInForce(f: SettingsFiles, v: InForce, w: Writer): void {
  makeFolders(f, w);
  const back = parseInForce(JSON.parse(JSON.stringify(v)));
  if (typeof back === "string") throw new Error(`the settings in force would not read back: ${back}`);
  writeOwnedText(f.inForce, `${JSON.stringify(v)}\n`, rules(w));
}
export function updateState<O>(f: SettingsFiles, w: Writer, change: (s: SettingsState) => Promise<{ state: SettingsState; out: O }> | { state: SettingsState; out: O }): Promise<O> {
  makeFolders(f, w);
  return updateOwnedJson(f.state, { owner: w.rootUid ?? 0, max: DOC_MAX }, parseState, noState, async (s) => {
    const r = await change(s);
    if (r.state !== s) {
      const back = parseState(JSON.parse(JSON.stringify(r.state)));
      if (typeof back === "string") throw new Error(`the settings state would not read back: ${back}`);
    }
    return r;
  }, rules(w));
}
