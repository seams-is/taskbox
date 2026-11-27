// What a box keeps of its releases: each install folder's install.json, written
// once at its install and again when its update ends, and root's updates.json, the marks auto-update
// goes by. install.json is outside the install's file hashes (checks.ts listFiles), so its ending can
// be written without the folder reading as changed.
//
// - install.json: the version, its signed statement and signature, the tarball's SHA-256 (for
//   update --repair), the settings commit it was installed with (a rollback runs with it), when, by
//   whom, and how it ended.
// - updates.json: releases marked bad (a failed proof: never auto-installed again), the version held
//   after a rollback (auto-update takes only a release newer than the one rolled back from), and when
//   a release check last succeeded (for the 7-day freezing warning).
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { type Read, readOwnedJson, writeOwnedText, type WriteRules } from "../core/rootfile.ts";
import { compareVersions, parseStatement, parseVersion, type Statement } from "../release.ts";

export const INSTALL_RECORD = "install.json";
export const ENDINGS = ["installing", "installed", "rolled-back", "failed", "repaired"] as const;
export type Ending = (typeof ENDINGS)[number];

export interface InstallRecord {
  v: 1;
  version: string;
  statement: string; // the signed statement's text
  signature: string; // its armoured signature
  sha256: string; // the tarball's
  settingsCommit: string | null; // the settings commit in use at its install
  at: number;
  by: string;
  from: string | null; // the version it replaced
  ended: Ending;
  why?: string;
}

const plainLine = (t: unknown, max: number) => typeof t === "string" && t.length <= max && !/[\x00-\x1f\x7f]/.test(t);

export function parseInstallRecord(v: unknown): InstallRecord | string {
  if (!v || typeof v !== "object" || Array.isArray(v)) return "it isn't an object";
  const r = v as InstallRecord;
  if (r.v !== 1) return "its version isn't one taskbox reads";
  if (!parseVersion(r.version)) return "its version isn't a release";
  const s = typeof r.statement === "string" ? parseStatement(r.statement) : undefined;
  if (!s || s.version !== r.version || s.sha256 !== r.sha256) return "its statement isn't its release's";
  if (typeof r.signature !== "string" || r.signature.length > 16_384) return "its signature isn't one taskbox reads";
  if (!(r.settingsCommit === null || (typeof r.settingsCommit === "string" && /^[0-9a-f]{40}$/.test(r.settingsCommit)))) return "its settings commit isn't a commit";
  if (!Number.isSafeInteger(r.at) || !plainLine(r.by, 120)) return "its time or who isn't one taskbox reads";
  if (!(r.from === null || parseVersion(r.from))) return "its from isn't a release";
  if (!(ENDINGS as readonly unknown[]).includes(r.ended)) return "its ending isn't one taskbox reads";
  if (r.why !== undefined && !plainLine(r.why, 240)) return "its why isn't a short line";
  return r;
}

export const statementOf = (r: InstallRecord): Statement => parseStatement(r.statement)!;

export function readInstallRecord(dir: string, rootUid = 0): Read<InstallRecord> {
  return readOwnedJson(join(dir, INSTALL_RECORD), { owner: rootUid, max: 64 * 1024 }, parseInstallRecord);
}

export function writeInstallRecord(dir: string, r: InstallRecord, w: Pick<WriteRules, "chown"> & { rootUid?: number } = {}): void {
  const why = parseInstallRecord(r);
  if (typeof why === "string") throw new Error(`the install record isn't one taskbox writes: ${why}`);
  writeOwnedText(join(dir, INSTALL_RECORD), `${JSON.stringify(r)}\n`, { mode: 0o644, owner: w.rootUid ?? 0, ...(w.chown ? { chown: w.chown } : {}) });
}

// An install folder's name: /opt/taskbox-<version>-<6 random>, and v2's /opt/taskbox-<commit>-<6>.
export const V3_INSTALL = /^taskbox-((?:0|[1-9]\d{0,3})\.(?:0|[1-9]\d{0,3})\.(?:0|[1-9]\d{0,3})(?:-rc\.[1-9]\d{0,3})?)-[A-Za-z0-9]{6}$/;

export interface Kept {
  dir: string;
  record: InstallRecord;
}

// The kept v3 installs beside /opt/taskbox, newest version first, each with a record that reads.
export function keptInstalls(optParent: string, rootUid = 0): Kept[] {
  let names: string[] = [];
  try {
    names = readdirSync(optParent);
  } catch {
    return [];
  }
  const out: Kept[] = [];
  for (const n of names) {
    const m = V3_INSTALL.exec(n);
    if (!m) continue;
    const dir = join(optParent, n);
    const r = readInstallRecord(dir, rootUid);
    if (r.kind === "ok" && r.value.version === m[1]) out.push({ dir, record: r.value });
  }
  return out.sort((a, b) => compareVersions(b.record.version, a.record.version) || b.record.at - a.record.at);
}

// root's updates.json.
export interface Marks {
  v: 1;
  bad: { version: string; why: string; at: number }[];
  // After a rollback from this version, auto-update takes only a release newer than it.
  heldBelow?: string;
  checkedAt?: number; // the last release check that read the list
  etag?: string;
}
export const noMarks = (): Marks => ({ v: 1, bad: [] });

export function parseMarks(v: unknown): Marks | string {
  if (!v || typeof v !== "object" || Array.isArray(v)) return "it isn't an object";
  const m = v as Marks;
  if (m.v !== 1 || !Array.isArray(m.bad) || m.bad.length > 100) return "its shape isn't one taskbox reads";
  if (!m.bad.every((b) => b && parseVersion(b.version) && plainLine(b.why, 240) && Number.isSafeInteger(b.at))) return "a bad mark isn't one taskbox reads";
  if (m.heldBelow !== undefined && !parseVersion(m.heldBelow)) return "its hold isn't a release";
  if (m.checkedAt !== undefined && !Number.isSafeInteger(m.checkedAt)) return "its check time isn't one taskbox reads";
  if (m.etag !== undefined && !plainLine(m.etag, 200)) return "its ETag isn't one taskbox reads";
  return m;
}

export function readMarks(path: string, rootUid = 0): Marks {
  const r = readOwnedJson(path, { owner: rootUid, max: 64 * 1024 }, parseMarks);
  return r.kind === "ok" ? r.value : noMarks();
}

export function writeMarks(path: string, m: Marks, w: Pick<WriteRules, "chown"> & { rootUid?: number } = {}): void {
  writeOwnedText(path, `${JSON.stringify(m)}\n`, { mode: 0o644, owner: w.rootUid ?? 0, ...(w.chown ? { chown: w.chown } : {}) });
}

export const markBad = (m: Marks, version: string, why: string, at: number): Marks => ({ ...m, bad: [...m.bad.filter((b) => b.version !== version), { version, why: why.slice(0, 240), at }].slice(-100) });
export const isBad = (m: Marks, version: string) => m.bad.some((b) => b.version === version);
// After a rollback from `from`: held below it, unless a hold already stands higher.
export const holdAfterRollback = (m: Marks, from: string): Marks => ({ ...m, heldBelow: m.heldBelow && compareVersions(m.heldBelow, from) > 0 ? m.heldBelow : from });

// The release check hasn't read the list for this long: status and check warn.
export const FROZEN_MS = 7 * 86_400_000;
export function frozenLine(m: Marks, now: number): string | undefined {
  if (m.checkedAt === undefined || now - m.checkedAt < FROZEN_MS) return undefined;
  return "couldn't read the releases for 7 days";
}
