// The joins: a rollback's settings narrowed, a signer removal raised for confirm and its yes taken,
// a revoke read from the release that carries the change, and a workspace holding an update.
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPending } from "../src/core/pending.ts";
import { rootStateIn } from "../src/core/paths.ts";
import { writeOwnedText } from "../src/core/rootfile.ts";
import { NAMESPACE, signerFingerprint, statementText } from "../src/release.ts";
import { meet, REVOKE, shaOf, type SignerState } from "../src/release/signers.ts";
import { REVOKES, revokeListText } from "../src/release/revokes.ts";
import { sha, statementFor } from "./release-fixture.ts";
import { emptyState } from "../src/workspace/model.ts";
import { workspaceHold } from "../src/update/auto.ts";
import { narrowed } from "../src/update/narrow.ts";
import { raiseRemoval, readRevoke, signerFiles, takeSignerYes } from "../src/update/signerwatch.ts";
import { FakeSys } from "./fake.ts";
import { approved, asked, readyState } from "./ws-helpers.ts";
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
    const m = meet({ v: 1, pinned: `${a.line}${b.line}` }, transition, "3.0.4", 1);
    if ("why" in m) throw new Error(m.why);
    writeOwnedText(signerFiles(s).state, JSON.stringify(m.state), { mode: 0o644, owner: me });
    const sys = new FakeSys();
    const d = { sys, state: s, rootUid: me, moment: async () => ({ wall: sys.now(), mono: 1000, boot: BOOT }), log: () => {} };
    await raiseRemoval(d);
    const p = readPending(s.pending, me);
    expect(p.kind === "ok" && p.value.items.map((i) => [i.kind, i.shows[0]])).toEqual([["signers", `The release signers change removes ${fp(b)}.`]]);
    writeOwnedText(signerFiles(s).yes, JSON.stringify({ sha: m.state.pending!.sha }), { mode: 0o644, owner: me });
    expect(takeSignerYes(d)).toBe("an admin confirmed the release signers' removal at the box");
  });

  // The release v3.0.4 that carries an add, its statement signed by a, its revoke list, and more files.
  function carrying(add: string, o: { list?: string | null; extra?: Record<string, Uint8Array | string> } = {}) {
    const list = o.list === undefined ? revokeListText([]) : o.list;
    const st = statementText(statementFor("3.0.4", { assets: list === null ? {} : { [REVOKES]: sha(list) } }));
    const files: Record<string, Uint8Array | string> = { "statement.json": st, "statement.json.sig": sshsig(a, new TextEncoder().encode(st), { namespace: NAMESPACE }), ...(list === null ? {} : { [REVOKES]: list }), ...o.extra };
    const s = state();
    const m = meet({ v: 1, pinned: a.line }, add, "3.0.4", 1);
    if ("why" in m) throw new Error(m.why);
    writeOwnedText(signerFiles(s).state, JSON.stringify(m.state), { mode: 0o644, owner: me });
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
    const after = async () => JSON.parse(await Bun.file(signerFiles(s).state).text()) as SignerState;
    return { d, after };
  }
  const add = () => `${JSON.stringify({ v: 1, type: "signers", old: [fp(a)], new: [a.line.trim(), b.line.trim()], fromVersion: "3.0.4" })}\n`;

  test("a revoke published on the release that carries an add, signed by the kept key, cancels it", async () => {
    const t = add();
    const body = new TextEncoder().encode(`${JSON.stringify({ v: 1, type: "revoke", transition: shaOf(t) })}\n`);
    const w = carrying(t, { extra: { [REVOKE]: body, [`${REVOKE}.sig`]: sshsig(a, body, { namespace: NAMESPACE }) } });
    expect(await readRevoke(w.d)).toBe("the signer change was revoked");
    const after = await w.after();
    expect(after.pending).toBeUndefined();
    expect(after.revoked).toEqual([shaOf(t)]);
  }, 20_000);

  test("the revoke list named in the carrying release's statement cancels it too, and a good read is kept for the wait", async () => {
    const t = add();
    expect(await readRevoke(carrying(t, { list: revokeListText([shaOf(t)]) }).d)).toBe("the signer change was revoked");
    const none = carrying(t);
    expect(await readRevoke(none.d)).toBeUndefined();
    expect((await none.after()).pending?.revokeReadAt).toBe(none.d.sys.now());
  }, 20_000);

  test("a revoke list that is gone, or another, fails closed: the add waits, and status has the reason", async () => {
    const t = add();
    const gone = carrying(t, { list: null });
    expect(await readRevoke(gone.d)).toBe("FAIL 3.0.4's statement names no revoke list, so the release key add waits");
    const swapped = carrying(t, { extra: { [REVOKES]: revokeListText(["9".repeat(64)]) } });
    expect(await readRevoke(swapped.d)).toBe("FAIL 3.0.4's revoke list isn't the one its statement names, so the release key add waits");
    const after = await swapped.after();
    expect(after.revokeProblem).toBe("3.0.4's revoke list isn't the one its statement names");
    expect(after.pending?.revokeReadAt).toBeUndefined();
    const deleted = carrying(t);
    deleted.d.sys.fetch = async () => new Response("", { status: 404 });
    expect(await readRevoke(deleted.d)).toBe("FAIL the release v3.0.4 that carries the signer change can't be read, so the release key add waits");
  }, 20_000);
});

describe("a workspace holding an update", () => {
  test("approved, ready or saving holds the box; ended or none doesn't", () => {
    const s = state();
    const file = join(s.dir, "workspaces.json");
    expect(workspaceHold(file, me)).toBeUndefined();
    const ap = approved(asked(emptyState()), "nova-1", "whole");
    writeStateFile({ rootUid: me }, file, ap);
    expect(workspaceHold(file, me)).toBe("workspace nova-1 (approved)");
    const rd = readyState("light");
    writeStateFile({ rootUid: me }, file, rd);
    expect(workspaceHold(file, me)).toBe(`workspace ${rd.workspaces[0]!.name} (ready)`);
    writeStateFile({ rootUid: me }, file, { ...rd, workspaces: rd.workspaces.map((w) => ({ ...w, state: "ended" as const })) });
    expect(workspaceHold(file, me)).toBeUndefined();
    writeStateFile({ rootUid: me }, file, emptyState());
    expect(workspaceHold(file, me)).toBeUndefined();
  });
});
