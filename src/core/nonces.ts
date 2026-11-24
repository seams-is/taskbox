// One nonce per subject (design §3.7), in root's nonces.json, 644, the guard its one writer. A
// signed statement names the subject's current nonce; once a signed request for that subject
// applies, the guard makes a new one, so a statement works once. Subjects: "box" (availability,
// updates, keys, connect), "rules" (standing rules), and a workspace's name.
import { randomBytes } from "node:crypto";
import { isObj, readOwnedJson, type Read, time, writeOwnedText, type WriteRules } from "./rootfile.ts";

export const NONCE = /^[0-9a-f]{32}$/;
export const SUBJECT = /^(box|rules|[a-z][a-z0-9]{0,15}-[1-9][0-9]{0,8})$/;
export const NONCES_V = 1;
export const NONCES_MAX_BYTES = 64 * 1024;
// Past this many subjects, the oldest workspace subjects go; box and rules always stay.
export const SUBJECTS_MAX = 200;

export interface Nonces {
  v: 1;
  subjects: Record<string, { nonce: string; at: number }>;
}
export const emptyNonces = (): Nonces => ({ v: 1, subjects: {} });

export type NonceRand = () => string;
export const realNonce: NonceRand = () => randomBytes(16).toString("hex");

export function parseNonces(v: unknown): Nonces | string {
  if (!isObj(v) || v.v !== NONCES_V || !isObj(v.subjects)) return "it isn't a nonces file taskbox reads";
  const keys = Object.keys(v.subjects);
  if (keys.length > SUBJECTS_MAX) return "it holds too many subjects";
  for (const k of keys) {
    const n = v.subjects[k];
    if (!SUBJECT.test(k) || !isObj(n) || typeof n.nonce !== "string" || !NONCE.test(n.nonce) || !time(n.at)) return "a subject's nonce isn't one taskbox reads";
  }
  return v as unknown as Nonces;
}

// The subject's nonce now, or undefined when it has none yet.
export const currentNonce = (s: Nonces, subject: string): string | undefined => (Object.hasOwn(s.subjects, subject) ? s.subjects[subject]!.nonce : undefined);

// The subject's nonce, made when it has none: what the laptop asks for before it signs.
export function nonceFor(s: Nonces, subject: string, now: number, rand: NonceRand = realNonce): { state: Nonces; nonce: string; changed: boolean } {
  if (!SUBJECT.test(subject)) throw new Error("not a subject for a nonce");
  const have = currentNonce(s, subject);
  if (have) return { state: s, nonce: have, changed: false };
  return { ...rotateNonce(s, subject, now, rand), changed: true };
}

// A new nonce for the subject, after a signed request for it applied. The old one never comes back.
export function rotateNonce(s: Nonces, subject: string, now: number, rand: NonceRand = realNonce): { state: Nonces; nonce: string } {
  if (!SUBJECT.test(subject)) throw new Error("not a subject for a nonce");
  const old = currentNonce(s, subject);
  let nonce = rand();
  if (!NONCE.test(nonce) || nonce === old) nonce = realNonce();
  const subjects = { ...s.subjects, [subject]: { nonce, at: now } };
  return { state: { v: 1, subjects: trim(subjects) }, nonce };
}

// A workspace's subject goes when it ends.
export function dropNonce(s: Nonces, subject: string): Nonces {
  if (!Object.hasOwn(s.subjects, subject)) return s;
  const subjects = { ...s.subjects };
  delete subjects[subject];
  return { v: 1, subjects };
}

function trim(subjects: Nonces["subjects"]): Nonces["subjects"] {
  const keys = Object.keys(subjects);
  if (keys.length <= SUBJECTS_MAX) return subjects;
  const drop = keys
    .filter((k) => k !== "box" && k !== "rules")
    .sort((a, b) => subjects[a]!.at - subjects[b]!.at)
    .slice(0, keys.length - SUBJECTS_MAX);
  const out = { ...subjects };
  for (const k of drop) delete out[k];
  return out;
}

export function readNonces(path: string, rootUid = 0): Read<Nonces> {
  return readOwnedJson(path, { owner: rootUid, max: NONCES_MAX_BYTES }, parseNonces);
}

export function writeNonces(path: string, s: Nonces, w: Omit<WriteRules, "mode">): void {
  const text = `${JSON.stringify(s)}\n`;
  if (typeof parseNonces(JSON.parse(text)) === "string") throw new Error("the nonces would not read back");
  writeOwnedText(path, text, { ...w, mode: 0o644 });
}
