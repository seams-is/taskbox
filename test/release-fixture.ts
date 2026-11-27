// Shared fixtures for the release tests: a v1 statement for a version, the bytes it names, and the
// real ssh-keygen, which only reads.
import { expect } from "bun:test";
import { createHash } from "node:crypto";
import { channelOf, NAMESPACE, type Statement, statementText, type VerifyDeps } from "../src/release.ts";
import { keyPair, sshsig } from "./sshsig.ts";

export const realKeygen: VerifyDeps = {
  run: async (cmd, args, opts = {}) => {
    expect(cmd).toBe("/usr/bin/ssh-keygen");
    const p = Bun.spawn([cmd, ...args], { env: { PATH: "/usr/bin:/bin" }, stdin: opts.stdin === undefined ? "ignore" : new Blob([opts.stdin]), stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => p.kill(9), opts.timeoutMs ?? 10_000);
    const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    clearTimeout(timer);
    return { code, stdout, stderr };
  },
};

export const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
export const TGZ = new TextEncoder().encode("the release tarball");
export const ASSET = new TextEncoder().encode("tailscale build");

export function statementFor(version: string, over: Partial<Statement> = {}): Statement {
  return {
    v: 1,
    name: "taskbox",
    version,
    channel: channelOf(version),
    tag: `v${version}`,
    tarball: `taskbox-v${version}.tar.gz`,
    sha256: sha(TGZ),
    tree: "a".repeat(40),
    assets: { "tailscale-1.104.5.tar.gz": sha(ASSET) },
    minFrom: "2.6.1",
    settingsSchema: [4, 4],
    answers: [3, 4],
    pr: 61,
    mergedAt: "2026-11-30T10:00:00Z",
    commit: "c".repeat(40),
    notes: "",
    ...over,
  };
}

// A statement's text, signed by key in the release namespace.
export function signed(key: ReturnType<typeof keyPair>, s: Statement | string, flags = 0x05): { statement: Uint8Array; signature: Uint8Array } {
  const statement = new TextEncoder().encode(typeof s === "string" ? s : statementText(s));
  return { statement, signature: new TextEncoder().encode(sshsig(key, statement, { namespace: NAMESPACE, flags })) };
}
