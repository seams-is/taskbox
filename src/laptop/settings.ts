// The laptop's own settings for workspaces, in ~/Library/Application Support/taskbox/laptop.json at
// mode 600: the box's Tailscale name, the box's agent account, and the approver key's handle.
// taskbox approver writes it. The handle is the file ssh-keygen -K wrote for the Secure Enclave key:
// it names the key and holds no secret, since the key itself never leaves the Secure Enclave.
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { createHash } from "node:crypto";
import { approverKeyProblem, fingerprint } from "../approver.ts";
import { APPROVER_KEY } from "../workspace/approval.ts";
import { BOX_NAME } from "./box.ts";

export interface Laptop {
  v: 1;
  box: string;
  agent: string; // the box's accounts.agent
  key: string | null; // the approver key's handle
  next: string | null; // a new key named by taskbox approver --rotate, used once the box pins it
}

export const ACCOUNT = /^[A-Za-z_][A-Za-z0-9._-]{0,31}$/;
export const laptopFile = (home: string) => join(home, "Library/Application Support/taskbox/laptop.json");
export const keyDir = (home: string) => join(home, ".ssh/taskbox-approve");

const handleOk = (v: unknown) => v === null || (typeof v === "string" && isAbsolute(v) && v.length < 1024 && !/[\x00-\x1f]/.test(v));

// Why a laptop.json value isn't one readLaptop takes, or undefined.
export function laptopProblem(v: Record<string, unknown>): string | undefined {
  if (v.v !== 1) return "its version";
  if (typeof v.box !== "string" || !BOX_NAME.test(v.box)) return "the box's name";
  if (typeof v.agent !== "string" || !ACCOUNT.test(v.agent)) return "the agent account";
  if (!handleOk(v.key ?? null) || !handleOk(v.next ?? null)) return "a key's file, which must be a full path";
  return undefined;
}

export type LaptopRead = { ok: true; laptop: Laptop } | { ok: false; why: string };

export function readLaptop(home: string): LaptopRead {
  const f = laptopFile(home);
  const setup = "Type taskbox approver --box <the box's Tailscale name> --agent <the box's agent account> once.";
  let fd: number;
  try {
    fd = openSync(f, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return { ok: false, why: `This laptop isn't set up for workspaces yet. ${setup}` };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0 || st.size > 8192) return { ok: false, why: `${f} isn't this user's own file at mode 600. ${setup}` };
    const v = JSON.parse(readFileSync(fd, "utf8")) as Record<string, unknown>;
    if (laptopProblem(v)) return { ok: false, why: `${f} isn't one taskbox reads. ${setup}` };
    return { ok: true, laptop: { v: 1, box: v.box as string, agent: v.agent as string, key: (v.key as string | null) ?? null, next: (v.next as string | null) ?? null } };
  } catch {
    return { ok: false, why: `${f} isn't one taskbox reads. ${setup}` };
  } finally {
    closeSync(fd);
  }
}

// Written whole to a new name at mode 600 and renamed, in a folder of this user's at mode 700.
// Never anything readLaptop would refuse: this throws instead.
export function writeLaptop(home: string, l: Laptop): void {
  const bad = laptopProblem({ ...l });
  if (bad) throw new Error(`laptop.json would not read back: ${bad}`);
  const f = laptopFile(home);
  mkdirSync(dirname(f), { recursive: true, mode: 0o700 });
  chmodSync(dirname(f), 0o700);
  const tmp = `${f}.new`;
  rmSync(tmp, { force: true });
  writeFileSync(tmp, `${JSON.stringify({ v: 1, box: l.box, agent: l.agent, key: l.key, next: l.next }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  chmodSync(tmp, 0o600);
  renameSync(tmp, f);
}

// A key's public line, from its handle's .pub beside it: the type and base64, with no comment, as
// the box's approverKey takes it. Or why not.
export function publicKey(handle: string): { key: string; fingerprint: string } | { why: string } {
  const pub = handle.endsWith(".pub") ? handle : `${handle}.pub`;
  try {
    const st = lstatSync(pub);
    if (!st.isFile() || st.size > 4096) return { why: `${pub} isn't a public key file.` };
    const [type, b64] = readFileSync(pub, "utf8").trim().split(/\s+/);
    const key = `${type} ${b64}`;
    if (approverKeyProblem(key) !== undefined || !APPROVER_KEY.test(key)) return { why: `${pub} isn't a key the box takes as its approver key: an sk-ecdsa-sha2-nistp256@openssh.com key, as ssh-keygen -K gives for the Secure Enclave.` };
    return { key, fingerprint: fingerprint(key) };
  } catch {
    return { why: `${pub} can't be read.` };
  }
}

// The SHA-1 of a key's P-256 point, upper case: the public key hash sc_auth list-ctk-identities shows
// for a Secure Enclave identity. Undefined when the handle's key can't be read.
export function keyHash(handle: string): string | undefined {
  const p = publicKey(handle);
  if ("why" in p) return undefined;
  const blob = Buffer.from(p.key.split(" ")[1]!, "base64");
  // type, curve, point, application: each a length and its bytes.
  let at = 0;
  const next = () => {
    const n = blob.readUInt32BE(at);
    const v = blob.subarray(at + 4, at + 4 + n);
    at += 4 + n;
    return v;
  };
  next();
  next();
  return createHash("sha1").update(next()).digest("hex").toUpperCase();
}

// The private half's file for a handle given either way.
export const privateHandle = (file: string) => (file.endsWith(".pub") ? file.slice(0, -4) : file);
