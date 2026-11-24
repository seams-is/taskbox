// Workspaces in tests: a clock, nonces that count, an approver key made in memory (sshsig.ts), and
// the real ssh-keygen for -Y verify, which only reads.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NAMESPACE, type Statement, statementText } from "../src/workspace/approval.ts";
import { approve, type BoxNow, type Ctx, emptyState, queue, type Result, type WsState } from "../src/workspace/model.ts";
import type { RunResult } from "../src/sys.ts";
import { keyPair, sshsig } from "./sshsig.ts";

export const T = 1_800_000_000_000;
export const INSTALL_ID = "0123456789abcdef0123456789abcdef";
export const BOOT1 = "11111111-2222-3333-4444-555555555555";
export const BOOT2 = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";
export const POOL = ["taskbox-ws1"];
export const N = (i: number) => i.toString(16).padStart(32, "0");

// A context whose nonces count up from start, at time now.
export function ctx(now = T, start = 100): Ctx & { pool: string[] } {
  let n = start;
  return { now, nonce: () => N(++n), pool: POOL };
}

export const box = (o: Partial<BoxNow> = {}): BoxNow => ({ now: T, boot: BOOT1, slotsBusy: 0, vmsLeft: 0, ready: POOL, diskLow: false, jobs: [], ...o });

export function ok(r: Result): WsState {
  if (!r.ok) throw new Error(r.why);
  return r.state;
}

export async function realKeygen(cmd: string, args: string[], opts: { stdin?: string | Uint8Array; timeoutMs?: number } = {}): Promise<RunResult> {
  if (cmd !== "/usr/bin/ssh-keygen" || args[0] !== "-Y" || args[1] !== "verify") throw new Error("only ssh-keygen -Y verify runs in tests");
  const p = Bun.spawn([cmd, ...args], { env: { PATH: "/usr/bin:/bin" }, stdin: opts.stdin === undefined ? "ignore" : new Blob([opts.stdin]), stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => p.kill(9), opts.timeoutMs ?? 10_000);
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  clearTimeout(timer);
  return { code, stdout, stderr };
}

// One folder for every check in a test run; each check makes and removes its own inside it.
let tmp: string | undefined;
export const verifyDeps = () => ({ run: realKeygen, tmp: (tmp ??= mkdtempSync(join(tmpdir(), "ws-verify-"))) });

export function approver() {
  const k = keyPair();
  return { k, key: k.key, sign: (s: Statement | string, o: { namespace?: string; flags?: number; blobNamespace?: string } = {}) => sshsig(k, new TextEncoder().encode(typeof s === "string" ? s : statementText(s)), { namespace: o.namespace ?? NAMESPACE, flags: o.flags, blobNamespace: o.blobNamespace }) };
}

// An armoured signature with its flags byte set to flags, as an attacker would edit it: the byte
// sits in the last 5 bytes of the blob, before the counter.
export function withFlags(armoured: string, flags: number): string {
  const b64 = /-----BEGIN SSH SIGNATURE-----\n([\s\S]+)-----END SSH SIGNATURE-----/.exec(armoured)![1]!.replace(/\n/g, "");
  const b = Buffer.from(b64, "base64");
  b[b.length - 5] = flags;
  return `-----BEGIN SSH SIGNATURE-----\n${b.toString("base64").match(/.{1,70}/g)!.join("\n")}\n-----END SSH SIGNATURE-----\n`;
}

// nova-1, queued and approved: Waiting, in taskbox-ws1.
export function approvedState(c = ctx()): WsState {
  const q = ok(queue(emptyState(), { agent: "nova", size: "whole", why: "Render the launch video" }, c));
  return ok(approve(q, { name: "nova-1", size: "whole", pool: POOL }, c));
}

// What the fence's clearing of a closed pool account asks a box where that account runs nothing:
// launchd has no domain of its to boot out, and it has no crontab (src/workspace/fence.ts). taskbox
// ignores both answers.
export function poolQuiet(sys: { fallbacks: ((cmd: string, args: string[]) => RunResult | undefined)[] }): void {
  sys.fallbacks.push((cmd, args) => {
    if (cmd === "/bin/launchctl" && args[0] === "bootout" && /^(gui|user)\/\d+$/.test(args[1] ?? "")) return { code: 3, stdout: "", stderr: "Boot-out failed: 3: No such process\n" };
    if (cmd === "/usr/bin/crontab" && args[0] === "-u" && args[2] === "-r") return { code: 1, stdout: "", stderr: `crontab: no crontab for ${args[1]}\n` };
    return undefined;
  });
}
