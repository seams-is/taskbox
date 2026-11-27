// The owner's approver keys on the box: trusted first at the box's screen,
// rotated by a signed request the old key makes and an admin's yes at confirm, reset at the box for a
// lost controller. approvers.json (core/approvers.ts) holds the keys; pending.json (core/pending.ts)
// holds a rotation while it waits for confirm.
//
// The first key comes as an offer: the controller's box add leaves its public key in the agent spool
// (approver-offer), the guard keeps the newest one, and `key trust approver` at the box shows its
// fingerprint for the admin to compare with the controller's before the typed yes. Anyone with the
// agent account can offer a key; only the admin's yes, against what the box itself shows, pins one.
import { approverKeyProblem, fingerprint, FINGERPRINT } from "./approver.ts";
import { readApprovers, replaceKey, resetKeys, trustFirst, updateApprovers, addKey, type Change } from "./core/approvers.ts";
import { bootId, monoNow } from "./core/boot.ts";
import type { Answer, HandlerCtx, UnsignedHandler } from "./core/dispatch.ts";
import type { EventLog } from "./core/events.ts";
import { begin, end, listOps, type Op, type OpFolder, readOp, toPhase, writeOp, opEvent } from "./core/ops.ts";
import { drop, type Moment, type Pending, raise, type Raised, updatePending } from "./core/pending.ts";
import type { RootState } from "./core/paths.ts";
import { isObj, readOwnedJson, writeOwnedText, type WriteRules } from "./core/rootfile.ts";
import type { Sys } from "./sys.ts";
import { opType } from "./optypes/index.ts";
import { ROTATE } from "./optypes/keys.ts";
import { join } from "node:path";
import { rmSync } from "node:fs";

export const grouped = (fp: string) => `SHA256:${fp.replace(/^SHA256:/, "").match(/.{1,4}/g)!.join(" ")}`;
export const KEY_TYPE = "sk-ecdsa-sha2-nistp256@openssh.com";
// A key's base64 alone travels as a word: no space for the agent shell to split.
export const KEY_B64 = /^[A-Za-z0-9+/]{100,400}={0,2}$/;
export const keyOf = (b64: string) => `${KEY_TYPE} ${b64}`;
export const OFFER_KIND = "approver-offer";
export const OFFER_FOR_MS = 60 * 60_000;
export const offerPath = (s: Pick<RootState, "dir">) => join(s.dir, "approver-offer.json");

export interface KeysCtx {
  sys: Pick<Sys, "run" | "now">;
  state: RootState;
  rootUid: number;
  chown?: WriteRules["chown"];
  events: EventLog;
}
const w = (c: Pick<KeysCtx, "rootUid" | "chown">) => ({ rootUid: c.rootUid, ...(c.chown ? { chown: c.chown } : {}) });
const opsOf = (c: Pick<KeysCtx, "state" | "rootUid" | "chown">): OpFolder => ({ dir: c.state.ops, owner: c.rootUid, ...(c.chown ? { chown: c.chown } : {}) });

export async function momentOf(sys: Pick<Sys, "run" | "now">): Promise<Moment> {
  return { wall: sys.now(), mono: await monoNow(sys).catch(() => undefined), boot: await bootId(sys).catch(() => undefined) };
}

// ---- The offer ----
export type Offer = { v: 1; key: string; at: number };
export function offerProblem(body: Record<string, unknown>): string | undefined {
  if (Object.keys(body).join(",") !== "key" || typeof body.key !== "string" || !KEY_B64.test(body.key)) return "an approver offer is one key's base64";
  return approverKeyProblem(keyOf(body.key));
}
export function readOffer(s: Pick<RootState, "dir">, rootUid: number, now: number): Offer | undefined {
  const r = readOwnedJson(offerPath(s), { owner: rootUid, max: 4096 }, (v) => (isObj(v) && v.v === 1 && typeof v.key === "string" && approverKeyProblem(v.key) === undefined && Number.isSafeInteger(v.at) ? (v as unknown as Offer) : "not an offer"));
  if (r.kind !== "ok") return undefined;
  return now - r.value.at <= OFFER_FOR_MS && r.value.at <= now ? r.value : undefined;
}
export const OFFER_HANDLER: UnsignedHandler = {
  kind: OFFER_KIND,
  check: offerProblem,
  async apply(c, r) {
    const key = keyOf(r.body.key as string);
    const a = readApprovers(c.state.approvers, c.rootUid);
    if (a.kind === "ok" && a.value.cleared.includes(fingerprint(key))) return { ok: false, code: "denied", said: "That key was cleared at this box with key reset approver, so it is never pinned again. Make a new one." };
    writeOwnedText(offerPath(c.state), `${JSON.stringify({ v: 1, key, at: c.now })}\n`, { mode: 0o644, owner: c.rootUid, ...(c.chown ? { chown: c.chown } : {}) });
    const pinned = a.kind === "ok" && a.value.keys.length > 0;
    return { ok: true, said: pinned ? `The box pins a key already. ${fingerprint(key)} waits for a rotation from a paired controller.` : `The box has ${fingerprint(key)}. At the box, as your admin user: taskbox key trust approver. Check its screen shows ${fingerprint(key)} before you type yes.` };
  },
};

// ---- key trust approver, at the box ----
export interface AtBox extends KeysCtx {
  say(line: string): void;
  ask(prompt: string): Promise<string>;
  yes: boolean; // -y, at the box's own terminal
  admin: string;
}

export async function trustApprover(d: AtBox): Promise<number> {
  const a = readApprovers(d.state.approvers, d.rootUid);
  if (a.kind === "bad") return (d.say(`The box's approvers.json can't be read (${a.why}), so nothing is pinned over it. Type taskbox key reset approver first.`), 1);
  if (a.kind === "ok" && a.value.keys.length) return (d.say(`This box pins ${a.value.keys.map((k) => k.fingerprint).join(", ")} already. A new key is rotated in from the controller that holds one, and confirmed here. A lost controller: taskbox key reset approver, then trust again.`), 1);
  const offer = readOffer(d.state, d.rootUid, d.sys.now());
  if (!offer) return (d.say("No controller has offered its approver key in the last hour. On the controller: taskbox box add, then type this again."), 1);
  const fp = fingerprint(offer.key);
  d.say(`The key a controller offered this box: ${fp}`);
  // In groups of four, as the controller's box add shows it, so the two are compared group by group.
  d.say(`  ${grouped(fp)}`);
  d.say("Pin it only if it is the fingerprint your controller shows. It then signs every signed request to this box.");
  if (!d.yes && (await d.ask("Type yes to pin it: ")).trim().toLowerCase() !== "yes") return (d.say("Not pinned. Nothing changed."), 1);
  const r = await updateApprovers(d.state.approvers, w(d), (s) => trustFirst(s, offer.key, d.sys.now(), "screen"));
  if (!r.ok) return (d.say(`Not pinned: ${r.why}`), 1);
  rmSync(offerPath(d.state), { force: true });
  d.events.write({ type: "key.trusted", actor: `admin ${d.admin}`, subject: "box", text: `Pinned approver key ${fp} at the box.`, data: { key: "approver", fingerprint: fp } });
  d.say(r.said);
  return 0;
}

// ---- key reset approver, at the box ----
export async function resetApprover(d: AtBox): Promise<number> {
  const a = readApprovers(d.state.approvers, d.rootUid);
  const fps = a.kind === "ok" ? a.value.keys.map((k) => k.fingerprint) : [];
  if (a.kind !== "bad" && !fps.length) return (d.say("No approver key is pinned on this box. Nothing changed."), 0);
  d.say(a.kind === "bad" ? `The box's approvers.json can't be read (${a.why}); a reset writes it anew with no key.` : `This box pins ${fps.join(", ")}.`);
  d.say("Clearing them stops every signed request and workspace until a new key is trusted here, and this box never takes these keys again. Clear them when the controller that holds one is lost.");
  if (!d.yes && (await d.ask("Type yes to clear them: ")).trim().toLowerCase() !== "yes") return (d.say("Not cleared. Nothing changed."), 1);
  let r: Change;
  if (a.kind === "bad") {
    rmSync(d.state.approvers, { force: true });
    r = { ok: true, state: { v: 1, gen: Math.floor(d.sys.now() / 1000), keys: [], cleared: [] }, said: "Cleared approvers.json." };
    await updateApprovers(d.state.approvers, w(d), () => r);
  } else r = await updateApprovers(d.state.approvers, w(d), resetKeys);
  if (!r.ok) return (d.say(`Not cleared: ${r.why}`), 1);
  // A rotation waiting for confirm can't pin a key into the cleared box.
  const dropped = await updatePending(d.state.pending, w(d), (s) => {
    const x = drop(s, (p) => p.kind === "approver-rotate" || p.kind === "approver-add");
    return { state: x.state, out: x.dropped };
  });
  for (const p of dropped) endApproverOp(d, p.op, "failed", "the approver keys were reset at the box");
  d.events.write({ type: "key.reset", actor: `admin ${d.admin}`, subject: "box", text: r.said, data: { key: "approver", cleared: fps } });
  d.say(`${r.said} Next: on the controller, taskbox box add, then taskbox key trust approver here.`);
  return 0;
}

// ---- key rotate approver, signed from the controller ----
// The old key signs the new one in: the request is the box's standard signed statement, with the new
// key's base64 as --new. It raises a lasting change, and the op waits in its waiting phase for confirm.
export const NEW_KEY = /^[A-Za-z0-9+/]{100,400}={0,2}$/;
export function newKeyProblem(b64: unknown): string | undefined {
  if (typeof b64 !== "string" || !NEW_KEY.test(b64)) return "key rotate approver takes --new, the new key's base64";
  return approverKeyProblem(keyOf(b64));
}

const signerFp = (actor: string) => /key (SHA256:[A-Za-z0-9+/]{43})\)?$/.exec(actor)?.[1];

export const raiseApproverRotate = (c: RaiseCtx, newB64: string, actor: string) => raiseApprover(c, "rotate", newB64, actor);

// ---- A second controller ----
// Its box add offers its key (approver-offer). A paired controller reads the offer (key list) and
// signs key add approver --new with that key's base64, which must be the box's offer now. The box
// then shows it at confirm, beside the key that approved it, and an admin's yes pins it.
export const raiseApproverAdd = (c: RaiseCtx, newB64: string, actor: string) => raiseApprover(c, "add", newB64, actor);

type RaiseCtx = Pick<HandlerCtx, "sys" | "state" | "rootUid" | "chown" | "events" | "now">;
async function raiseApprover(c: RaiseCtx, how: "rotate" | "add", newB64: string, actor: string): Promise<Answer> {
  const from = signerFp(actor);
  if (!from || !FINGERPRINT.test(from)) return { ok: false, code: "denied", said: "The change is signed by a key this box pins." };
  const key = keyOf(newB64);
  const fp = fingerprint(key);
  const a = readApprovers(c.state.approvers, c.rootUid);
  if (a.kind !== "ok" || !a.value.keys.some((k) => k.fingerprint === from)) return { ok: false, code: "denied", said: `${from} isn't pinned on this box any more.` };
  if (a.value.cleared.includes(fp)) return { ok: false, code: "denied", said: `${fp} was cleared at this box with key reset approver, so it is never pinned again.` };
  if (a.value.keys.some((k) => k.fingerprint === fp)) return { ok: true, said: `${fp} is pinned on this box already. Nothing changed.` };
  if (how === "add") {
    const offer = readOffer(c.state, c.rootUid, c.now);
    if (!offer || offer.key !== key) return { ok: false, code: "not-found", said: `No controller offered ${fp} to this box in the last hour. On the new controller: taskbox box add, then approve it again.` };
    if (a.value.keys.length >= 3) return { ok: false, code: "failed", said: "The box pins 3 keys already. Rotate one out first." };
  }
  const ops = opsOf(c);
  const m = await momentOf(c.sys);
  const b = begin(listOps(ops).ops, opType(ROTATE.approver), { subject: "box", params: { from, to: fp, how }, actor }, c.now);
  if (b.kind === "busy") return { ok: false, code: "busy", said: b.why, op: b.op.id };
  const shows = how === "rotate"
    ? ["Rotate the approver key.", `From: ${from}`, `To:   ${fp}`, "Asked by the controller that holds the old key, signed with it.", "Check the new fingerprint is the one your controller shows."]
    : ["Add a second controller's approver key.", `New:         ${fp}`, `Approved by: ${from}`, "Its controller offered it to this box; a paired controller signed it in.", "Check the new fingerprint is the one the new controller shows."];
  const r = await updatePending<Raised>(c.state.pending, w(c), (s) => {
    const x = raise(s, { kind: how === "rotate" ? "approver-rotate" : "approver-add", subject: how === "rotate" ? from : fp, shows, actor, op: b.op.id, payload: { from, key } }, m);
    return x.ok ? { state: x.state, out: x } : { state: s, out: x };
  });
  if (!r.ok) return { ok: false, code: "failed", said: r.why };
  const opId = r.item.op ?? b.op.id;
  if (b.kind === "start" && !r.again) {
    writeOp(ops, b.op);
    const e = opEvent(undefined, b.op);
    if (e) c.events.write(e);
    c.events.write({ type: `key.${how}-asked`, op: b.op.id, actor, subject: "box", text: how === "rotate" ? `A rotation of approver key ${from} to ${fp} waits for confirm at the box.` : `A second approver key ${fp}, approved by ${from}, waits for confirm at the box.`, data: { key: "approver", from, to: fp } });
  }
  return { ok: false, code: "needs-confirm", said: `The box waits for confirm: at the box, as your admin user, taskbox confirm, and check it shows ${fp}.${how === "rotate" ? ` Until then the box keeps ${from}.` : ""}`, op: opId };
}

// ---- What confirm applies ----
export async function applyApprover(c: KeysCtx & { actor: string }, p: Pending): Promise<{ ok: boolean; said: string }> {
  const pl = isObj(p.payload) ? p.payload : {};
  const key = typeof pl.key === "string" ? pl.key : "";
  if (approverKeyProblem(key)) return { ok: false, said: "The change's key isn't an approver key. Nothing was pinned." };
  if (p.op) {
    const op = readOp(opsOf(c), p.op);
    if (op.kind === "ok" && op.value.state !== "running") return { ok: false, said: `Its op ${p.op} ended (${op.value.state}), so nothing was pinned.` };
    if (op.kind === "ok") writeOp(opsOf(c), toPhase(op.value, "pinning"));
  }
  const now = c.sys.now();
  const r = await updateApprovers(c.state.approvers, w(c), (s) => (p.kind === "approver-rotate" ? replaceKey(s, String(pl.from ?? ""), key, now) : addKey(s, key, now)));
  if (!r.ok) {
    endApproverOp(c, p.op, "failed", r.why);
    return { ok: false, said: r.why };
  }
  const fp = fingerprint(key);
  const o = readOffer(c.state, c.rootUid, c.sys.now());
  if (o?.key === key) rmSync(offerPath(c.state), { force: true });
  c.events.write({ type: "key.pinned", ...(p.op ? { op: p.op } : {}), actor: c.actor, subject: "box", text: r.said, data: { key: "approver", fingerprint: fp, ...(typeof pl.from === "string" ? { from: pl.from } : {}) } });
  endApproverOp(c, p.op, "succeeded");
  return { ok: true, said: r.said };
}

export function endApproverOp(c: Pick<KeysCtx, "state" | "rootUid" | "chown" | "events" | "sys">, id: string | undefined, state: "succeeded" | "failed" | "cancelled", why?: string): void {
  if (!id) return;
  const ops = opsOf(c);
  const r = readOp(ops, id);
  if (r.kind !== "ok" || r.value.state !== "running") return;
  const next = end(r.value, state, c.sys.now(), why ? { why } : {});
  writeOp(ops, next);
  const e = opEvent(r.value, next);
  if (e) c.events.write(e);
}

// op cancel's hook: the rotation's wait for confirm goes. How many waits went.
export async function dropApproverWait(c: Pick<HandlerCtx, "state" | "rootUid" | "chown">, op: string): Promise<number> {
  const out = await updatePending(c.state.pending, w(c), (s) => {
    const x = drop(s, (p) => p.op === op && (p.kind === "approver-rotate" || p.kind === "approver-add"));
    return { state: x.state, out: x.dropped.length };
  });
  return out;
}

export type { Op };

// ---- key trust release FILE, at the box ----
// Every pinned release key lost: the admin pins the key in a file the owner checked by eye (a signers
// file, or one public key line), after the box shows each fingerprint. It replaces the whole pinned
// set, and drops a signer change waiting, as a first install's trust does.
export async function trustRelease(d: AtBox & { file: string; signersFile: string }): Promise<number> {
  const { signersProblem, signerPrints } = await import("./release.ts");
  const { lstatSync, readFileSync: read } = await import("node:fs");
  let text: string;
  try {
    const st = lstatSync(d.file);
    if (!st.isFile() || st.size > 4096) return (d.say(`${d.file} isn't a plain file of at most 4 KB.`), 1);
    text = read(d.file, "utf8");
  } catch {
    return (d.say(`${d.file} can't be read.`), 1);
  }
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const signers = `${lines.map((l) => (l.startsWith("taskbox-release ") ? l : `taskbox-release namespaces="taskbox-release" ${l.split(/\s+/).slice(0, 2).join(" ")}`)).join("\n")}\n`;
  const why = signersProblem(signers);
  if (why) return (d.say(`Not pinned: ${why}. The file holds a release key's public line, or a signers file.`), 1);
  const fps = signerPrints(signers);
  d.say("The release keys in that file:");
  for (const fp of fps) d.say(`  ${grouped(fp)}`);
  d.say("Pin them only if they are the fingerprints the signing Mac shows. They replace every release key this box pins, and every update is checked against them.");
  if (!d.yes && (await d.ask("Type yes to pin them: ")).trim().toLowerCase() !== "yes") return (d.say("Not pinned. Nothing changed."), 1);
  const { readSigners } = await import("./update/box.ts");
  const was = readSigners(d.signersFile, signers, d.rootUid);
  writeOwnedText(d.signersFile, `${JSON.stringify({ v: 1, pinned: signers, ...(was.revoked ? { revoked: was.revoked } : {}) })}\n`, { mode: 0o644, owner: d.rootUid, ...(d.chown ? { chown: d.chown } : {}) });
  d.events.write({ type: "key.trusted", actor: `admin ${d.admin}`, subject: "box", text: `Pinned release ${fps.length === 1 ? "key" : "keys"} ${fps.join(", ")} at the box.`, data: { key: "release", fingerprints: fps } });
  d.say(`Pinned ${fps.join(", ")}.`);
  return 0;
}
