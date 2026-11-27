// The joins: a rollback's settings narrowed, a signer removal raised for confirm and its yes taken,
// a revoke read from the release that carries the change, and a workspace holding an update.
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPending } from "../src/core/pending.ts";
import { rootStateIn } from "../src/core/paths.ts";
import { writeOwnedText } from "../src/core/rootfile.ts";
import { NAMESPACE, signerFingerprint } from "../src/release.ts";
import { meet, REVOKE, shaOf, type SignerState } from "../src/release/signers.ts";
import { emptyState } from "../src/workspace/model.ts";
import { HOLD_MAX_MS, holdsPast, workspaceHold } from "../src/update/auto.ts";
import { workspacesBlock } from "../src/workspace/show.ts";
import { narrowed } from "../src/update/narrow.ts";
import { raiseRemoval, readRevoke, signerFiles, takeSignerYes } from "../src/update/signerwatch.ts";
import { FakeSys } from "./fake.ts";
import { approved, asked, readyState, T } from "./ws-helpers.ts";
import { writeStateFile } from "../src/workspace/write.ts";
import { keyPair, sshsig } from "./sshsig.ts";

const me = process.getuid!();
const BOOT = "11111111-2222-3333-4444-555555555555";

describe("a rollback's settings", () => {
  test("the recorded commit, with each guarded key that would widen held at today's value", () => {
    const now = { update: { channel: "stable" }, tools: { enabled: false }, vmMaxHours: 4, timings: { a: 2 } };
    const recorded = { update: { channel: "beta" }, tools: { enabled: true }, vmMaxHours: 2, timings: { a: 1 } };
    const n = narrowed(recorded, now);
    expect(n.doc).toMatchObject({ update: { channel: "stable" }, tools: { enabled: false }, vmMaxHours: 2, timings: { a: 1 } });
    expect(n.held.sort()).toEqual(["tools.enabled", "update.channel"]);
  });
});

function state() {
  const dir = mkdtempSync(join(tmpdir(), "taskbox-joins-"));
  chmodSync(dir, 0o755);
  mkdirSync(join(dir, "update"), { mode: 0o755 });
  chmodSync(join(dir, "update"), 0o755);
  return rootStateIn(dir);
}

describe("a release signer removal", () => {
  const a = keyPair();
  const b = keyPair();
  const fp = (k: ReturnType<typeof keyPair>) => signerFingerprint(k.line.trim())!;
  const transition = `${JSON.stringify({ v: 1, type: "signers", old: [fp(a), fp(b)].sort(), new: [a.line.trim()], fromVersion: "3.0.4" })}\n`;

  test("is raised for confirm, and an admin's yes there lets it apply", async () => {
    const s = state();
    const m = meet({ v: 1, pinned: `${a.line}${b.line}` }, transition, "3.0.4", { wall: 1, mono: 1, boot: BOOT });
    if ("why" in m) throw new Error(m.why);
    writeOwnedText(signerFiles(s).state, JSON.stringify(m.state), { mode: 0o644, owner: me });
    const sys = new FakeSys();
    const d = { sys, state: s, rootUid: me, moment: async () => ({ wall: sys.now(), mono: 1000, boot: BOOT }), log: () => {} };
    await raiseRemoval(d);
    const p = readPending(s.pending, me);
    expect(p.kind === "ok" && p.value.items.map((i) => [i.kind, i.shows[0]])).toEqual([["signers", `The release signers change removes ${fp(b)}.`]]);
    const sha = m.state.waiting![0]!.sha;
    writeOwnedText(signerFiles(s).yes, JSON.stringify({ sha, yes: true }), { mode: 0o644, owner: me });
    expect(takeSignerYes(d)).toBe("an admin confirmed the release signers' removal at the box");
    // A no drops the change, and records it as refused.
    writeOwnedText(signerFiles(s).yes, JSON.stringify({ sha, yes: false }), { mode: 0o644, owner: me });
    expect(takeSignerYes(d)).toBe("an admin refused a release signer change at the box, and it is dropped");
    const after = JSON.parse(await Bun.file(signerFiles(s).state).text()) as SignerState;
    expect(after.waiting).toBeUndefined();
    expect(after.refused).toEqual([sha]);
  });

  test("a revoke published on the release that carries an add, signed by the kept key, cancels it", async () => {
    const s = state();
    const add = `${JSON.stringify({ v: 1, type: "signers", old: [fp(a)], new: [a.line.trim(), b.line.trim()], fromVersion: "3.0.4" })}\n`;
    const m = meet({ v: 1, pinned: a.line }, add, "3.0.4", { wall: 1, mono: 1, boot: BOOT });
    if ("why" in m) throw new Error(m.why);
    writeOwnedText(signerFiles(s).state, JSON.stringify(m.state), { mode: 0o644, owner: me });
    const body = new TextEncoder().encode(`${JSON.stringify({ v: 1, type: "revoke", transition: shaOf(add) })}\n`);
    const files: Record<string, Uint8Array | string> = { "statement.json": "{}", "statement.json.sig": "x", [REVOKE]: body, [`${REVOKE}.sig`]: sshsig(a, body, { namespace: NAMESPACE }) };
    const sys = new FakeSys();
    sys.fetch = async (url) => {
      const u = String(url);
      if (u.includes("/releases/tags/")) return new Response(JSON.stringify({ tag_name: "v3.0.4", draft: false, prerelease: false, assets: Object.entries(files).map(([name, v]) => ({ name, size: v.length })) }));
      const name = decodeURIComponent(u.split("/").pop()!);
      return new Response(files[name] as BodyInit);
    };
    // ssh-keygen as nobody, run for real without sudo.
    sys.responders.push((cmd, args, o) => {
      if (cmd !== "/usr/bin/sudo") return undefined;
      const argv = args.slice(args.indexOf("/usr/bin/ssh-keygen"));
      const r = Bun.spawnSync(argv, { env: { PATH: "/usr/bin:/bin" }, stdin: o?.stdin ? new Blob([o.stdin]) : "ignore" });
      return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
    });
    const d = { sys, state: s, repo: "example-org/taskbox-public", rootUid: me, moment: async () => ({ wall: 1, mono: 1, boot: BOOT }), log: () => {} };
    expect(await readRevoke(d)).toBe("the signer change was revoked");
    const after = JSON.parse(await Bun.file(signerFiles(s).state).text()) as SignerState;
    expect(after.waiting).toBeUndefined();
    expect(after.revoked).toEqual([shaOf(add)]);
  }, 20_000);
});

describe("a workspace holding an update", () => {
  test("only a running or saving Whole or Heavy holds, for HOLD_MAX_MS from its approval; an approved one, a Light, a torn state or none don't", () => {
    const s = state();
    const file = join(s.dir, "workspaces.json");
    expect(workspaceHold(file, me, T)).toBeUndefined();
    writeStateFile({ rootUid: me }, file, approved(asked(emptyState()), "nova-1", "whole"));
    expect(workspaceHold(file, me, T)).toBeUndefined();
    const light = readyState("light");
    writeStateFile({ rootUid: me }, file, light);
    expect(workspaceHold(file, me, T)).toBeUndefined();
    const whole = readyState("whole");
    writeStateFile({ rootUid: me }, file, whole);
    const name = whole.workspaces[0]!.name;
    expect(workspaceHold(file, me, T)).toBe(`workspace ${name} (whole, ready)`);
    const heavy = readyState("heavy");
    writeStateFile({ rootUid: me }, file, heavy);
    expect(workspaceHold(file, me, T)).toBe(`workspace ${name} (heavy, ready)`);
    // Bounded: past HOLD_MAX_MS from its approval, it holds no more.
    expect(workspaceHold(file, me, T + HOLD_MAX_MS - 1)).toBeDefined();
    expect(workspaceHold(file, me, T + HOLD_MAX_MS)).toBeUndefined();
    expect(holdsPast(heavy, T + HOLD_MAX_MS)).toEqual([name]);
    writeStateFile({ rootUid: me }, file, { ...whole, workspaces: whole.workspaces.map((w) => ({ ...w, state: "ended" as const })) });
    expect(workspaceHold(file, me, T)).toBeUndefined();
    writeFileSync(file, "{ torn");
    expect(workspaceHold(file, me, T)).toBeUndefined();
  });
  test("status shows the hold and its latest end", () => {
    const s = state();
    const file = join(s.dir, "workspaces.json");
    writeStateFile({ rootUid: me }, file, readyState("whole"));
    expect(workspacesBlock(file, T, me).at(-1)).toBe(`Updates:   held by workspace nova-1 (whole, ready) until ${new Date(T + HOLD_MAX_MS).toISOString().slice(11, 16)} UTC at the latest`);
  });
});
