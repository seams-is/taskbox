// Workspaces in tests: a fixed clock, the rules a 32 GB box gets, and states made by the model's own
// steps, so every state a test starts from is one the model can reach.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approve, assign, emptyState, ready, request, type Result, type Rules, start, type WsState } from "../src/workspace/model.ts";
import type { RunResult } from "../src/sys.ts";
import { keyPair, sshsig } from "./sshsig.ts";
import { lasting } from "./tmpclean.ts";

export const T = 1_800_000_000_000;
export const INSTALL_ID = "0123456789abcdef0123456789abcdef";
export const BOOT1 = "11111111-2222-3333-4444-555555555555";
export const BOOT2 = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";
export const POOL = ["taskbox-ws1", "taskbox-ws2"];
export const OWNER = "owner (signed, key SHA256:abc)";
export const MIN = 60_000;
export const HOUR = 3_600_000;
export const N = (i: number) => i.toString(16).padStart(32, "0");

// The rules of a box with a 22.4 GB VM budget and 10 CPUs, and the default settings.
export const RULES: Rules = {
  requestMs: 24 * HOUR,
  maxRequests: 20,
  progressMs: 10 * MIN,
  quietMs: 60 * MIN,
  saveMs: 20 * MIN,
  approvalMs: 24 * HOUR,
  keepMs: 30 * 24 * HOUR,
  sizes: { light: { memoryMB: 8192, cpus: 2, maxAtOnce: 2 }, heavy: { memoryMB: 18432, cpus: 6, maxAtOnce: 1 }, whole: { memoryMB: 22360, cpus: 10, maxAtOnce: 1 } },
  budget: { memoryMB: 22360, cpus: 10 },
};

export function ok(r: Result): WsState {
  if (!r.ok) throw new Error(r.why);
  return r.state;
}

// The model's own steps, in order: a request, an approval, an account and a start, and ready.
export function asked(s: WsState, agent = "nova", size: "light" | "heavy" | "whole" = "whole", now = T): WsState {
  return ok(request(s, { agent, size, why: "Render the launch video" }, RULES, now));
}
export function approved(s: WsState, name: string, size: "light" | "heavy" | "whole", now = T, pool = POOL): WsState {
  return ok(approve(s, { name, size, by: OWNER, pool }, RULES, now));
}
export function started(s: WsState, now = T): WsState {
  return start(assign(s, POOL, now).state, RULES, now).state;
}
export function readyIn(s: WsState, name: string, now = T, boot = BOOT1): WsState {
  return ok(ready(s, name, boot, now));
}
// nova-1 ready in taskbox-ws1, at the size given.
export function readyState(size: "light" | "heavy" | "whole" = "whole", now = T): WsState {
  return readyIn(started(approved(asked(emptyState(), "nova", size, now), "nova-1", size, now), now), "nova-1", now);
}

// An approver key made in memory, and a signer of any text in a namespace (taskbox-control by default).
export function approver() {
  const k = keyPair();
  return { k, key: k.key, sign: (text: string, o: { namespace?: string; flags?: number; blobNamespace?: string } = {}) => sshsig(k, new TextEncoder().encode(text), { namespace: o.namespace ?? "taskbox-control", flags: o.flags, blobNamespace: o.blobNamespace }) };
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
export const verifyDeps = () => ({ run: realKeygen, tmp: (tmp ??= lasting("ws-verify-")) });

// An armoured signature with its flags byte set to flags, as an attacker would edit it: the byte
// sits in the last 5 bytes of the blob, before the counter.
export function withFlags(armoured: string, flags: number): string {
  const b64 = /-----BEGIN SSH SIGNATURE-----\n([\s\S]+)-----END SSH SIGNATURE-----/.exec(armoured)![1]!.replace(/\n/g, "");
  const b = Buffer.from(b64, "base64");
  b[b.length - 5] = flags;
  return `-----BEGIN SSH SIGNATURE-----\n${b.toString("base64").match(/.{1,70}/g)!.join("\n")}\n-----END SSH SIGNATURE-----\n`;
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

export { emptyState };
