// A private answer to one signed request. Outcomes are files the agent account can read, and the
// owner's signed session reaches the box as that account, so anything private in an answer is sealed
// to a key only the controller's command holds: it makes an X25519 key pair for the one request and
// puts the public half in the signed args (--answer-key), so the owner's touch binds it and nobody can
// put their own key in its place. The box seals with a key pair of its own made for the answer:
// X25519, HKDF-SHA256 over the request's id, then AES-256-GCM. The private key never leaves the
// controller's process, so neither the agent account nor any other reader of the outcome can open it.
import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, type KeyObject, randomBytes } from "node:crypto";
import { isObj } from "./rootfile.ts";

export const ANSWER_KEY = /^[A-Za-z0-9_-]{43}$/; // a raw X25519 public key, base64url
export const SEALED_MAX = 2048; // the private answer's JSON, so the outcome stays under 4 KB
const INFO = "taskbox-answer v1";

export interface Sealed {
  key: string; // the box's public half for this answer, base64url
  iv: string;
  data: string; // ciphertext and tag, base64url
}

const pub = (raw: string): KeyObject => createPublicKey({ key: { kty: "OKP", crv: "X25519", x: raw }, format: "jwk" });
const raw = (k: KeyObject): string => k.export({ format: "jwk" }).x!;
const keyFor = (shared: Buffer, id: string) => Buffer.from(hkdfSync("sha256", shared, Buffer.from(id), INFO, 32));

// The controller's side: a key pair for one request. answerKey goes in --answer-key; secret stays.
export function answerKeyPair(): { answerKey: string; secret: string } {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  return { answerKey: raw(publicKey), secret: privateKey.export({ format: "jwk" }).d! };
}

export const isSealed = (v: unknown): v is Sealed => isObj(v) && Object.keys(v).join(",") === "key,iv,data" && typeof v.key === "string" && ANSWER_KEY.test(v.key) && typeof v.iv === "string" && /^[A-Za-z0-9_-]{16}$/.test(v.iv) && typeof v.data === "string" && /^[A-Za-z0-9_-]{22,2800}$/.test(v.data);

// The box's side: a private answer sealed to the request's answer key, bound to the request's id.
export function seal(answerKey: string, id: string, value: Record<string, unknown>): Sealed {
  if (!ANSWER_KEY.test(answerKey)) throw new Error("not an answer key");
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > SEALED_MAX) throw new Error("the private answer is over 2 KB");
  const mine = generateKeyPairSync("x25519");
  const k = keyFor(diffieHellman({ privateKey: mine.privateKey, publicKey: pub(answerKey) }), id);
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", k, iv);
  const data = Buffer.concat([c.update(text, "utf8"), c.final(), c.getAuthTag()]);
  return { key: raw(mine.publicKey), iv: iv.toString("base64url"), data: data.toString("base64url") };
}

// The controller's side: the private answer, or undefined when it isn't sealed to this secret and id.
export function openSealed(secret: string, answerKey: string, id: string, s: Sealed): Record<string, unknown> | undefined {
  try {
    const privateKey = createPrivateKey({ key: { kty: "OKP", crv: "X25519", x: answerKey, d: secret }, format: "jwk" });
    const k = keyFor(diffieHellman({ privateKey, publicKey: pub(s.key) }), id);
    const b = Buffer.from(s.data, "base64url");
    const d = createDecipheriv("aes-256-gcm", k, Buffer.from(s.iv, "base64url"));
    d.setAuthTag(b.subarray(b.length - 16));
    const v = JSON.parse(Buffer.concat([d.update(b.subarray(0, b.length - 16)), d.final()]).toString("utf8")) as unknown;
    return isObj(v) ? v : undefined;
  } catch {
    return undefined;
  }
}
