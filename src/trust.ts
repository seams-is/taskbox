// The first install's trust, checked at the box's own screen (spec 4.8.6): the install keeps the
// fingerprints of the release keys it pins in root's trust.json, and until an admin at the box's
// screen has typed yes to each (taskbox confirm), the box takes no update and starts no workspace.
// CI runs meanwhile. Nothing is pinned from the controller's word alone: the approver key's own yes
// is the approver offer's (approverkeys.ts), at the same screen.
import { join } from "node:path";
import type { Check, CheckContext } from "./checks.ts";
import { rootStateOf } from "./core/paths.ts";
import { isObj, plain, readOwnedJson, time, writeOwnedText, type WriteRules } from "./core/rootfile.ts";
import type { Row } from "./core/rows.ts";

export interface Trust {
  v: 1;
  signers: string[]; // SHA256:... of each release key the install pinned
  placedAt: number;
  confirmed?: { at: number; by: string };
}

export const trustPath = (p: { installId: string }) => join(rootStateOf(p).dir, "trust.json");
const PRINT = /^SHA256:[A-Za-z0-9+/]{43}$/;

export function parseTrust(v: unknown): Trust | string {
  if (!isObj(v) || v.v !== 1 || !Array.isArray(v.signers) || v.signers.length < 1 || v.signers.length > 4 || !v.signers.every((s) => typeof s === "string" && PRINT.test(s)) || !time(v.placedAt)) return "it isn't a trust record taskbox reads";
  const c = v.confirmed;
  if (c !== undefined && !(isObj(c) && time(c.at) && plain(c.by, 64))) return "its confirmation isn't one taskbox reads";
  return v as unknown as Trust;
}

export const readTrust = (p: { installId: string }, rootUid = 0) => readOwnedJson(trustPath(p), { owner: rootUid, max: 4096 }, parseTrust);
export const writeTrust = (p: { installId: string }, t: Trust, w: Pick<WriteRules, "chown"> & { rootUid?: number }) => writeOwnedText(trustPath(p), `${JSON.stringify(t)}\n`, { mode: 0o644, owner: w.rootUid ?? 0, ...(w.chown ? { chown: w.chown } : {}) });

export const TRUST_WAITS = "the release keys wait for an admin's yes at the box's screen: taskbox confirm there";

// Why the box waits on its first trust, or undefined. No record (a box from before this, or a guest
// test) waits on nothing; a record that can't be read waits, so a broken file never opens the box.
export function trustWaiting(p: { installId: string }, rootUid = 0): string | undefined {
  const r = readTrust(p, rootUid);
  if (r.kind === "missing") return undefined;
  if (r.kind !== "ok") return `the box's trust record can't be read, so ${TRUST_WAITS}`;
  return r.value.confirmed ? undefined : TRUST_WAITS;
}

export async function trustRow(c: CheckContext): Promise<Omit<Check, "name">> {
  const why = trustWaiting(c.paths, c.rootUid ?? 0);
  return why ? { status: "FAIL", detail: `No updates and no workspaces yet: ${why}` } : { status: "OK", detail: "an admin checked the release keys at the box's screen, or none wait" };
}

// After "Loop clock" (2127).
export const TRUST_ROWS: Row[] = [{ name: "Release keys checked", fn: trustRow, order: 2128, in: ["check", "away"] }];
