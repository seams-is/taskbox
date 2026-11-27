// confirm applies a lasting change first and takes it out of pending.json after (confirmapply.ts):
// a write that fails, for any kind, leaves the item waiting for another yes.
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fingerprint } from "../src/approver.ts";
import { applyConfirm } from "../src/confirmapply.ts";
import { trustFirst, updateApprovers } from "../src/core/approvers.ts";
import { bootId, monoNow } from "../src/core/boot.ts";
import { eventLog } from "../src/core/events.ts";
import { rootStateIn } from "../src/core/paths.ts";
import { type Ask, raise, readPending, updatePending } from "../src/core/pending.ts";
import { FakeSys } from "./fake.ts";
import { keyPair } from "./sshsig.ts";

const me = process.getuid!();
const SHA40 = "a".repeat(40);

async function box(make: (now: number) => Ask, block: (dir: string) => (() => void) | Promise<() => void>) {
  const sys = new FakeSys();
  const ask = make(sys.now());
  const dir = join(mkdtempSync(join(tmpdir(), "taskbox-confirm-")), "opt/taskbox-state");
  mkdirSync(dir, { recursive: true });
  const state = rootStateIn(dir);
  const at = { wall: sys.now(), mono: await monoNow(sys), boot: await bootId(sys) };
  const id = await updatePending(state.pending, { rootUid: me }, (s) => {
    const r = raise(s, ask, at);
    if (!r.ok) throw new Error(r.why);
    return { state: r.state, out: r.item.id };
  });
  const p = { installId: join(dir, "install-id"), workspaces: join(dir, "workspaces.json") } as never;
  const d = { sys, p, rootUid: me, events: eventLog("guard", { dir: state.events, owner: me }, sys) };
  const unblock = await block(dir);
  const ids = () => {
    const r = readPending(state.pending, me);
    return r.kind === "ok" ? r.value.items.map((x) => x.id) : [];
  };
  return { yes: () => applyConfirm(d, { id, yes: true, admin: "admin1" }), unblock, ids, id };
}

// A file where a folder goes, a folder where a file goes, or a folder taskbox can't write in: the write fails.
const fileAt = (path: string) => (writeFileSync(path, "x"), () => rmSync(path));
const folderAt = (path: string) => (mkdirSync(path), () => rmSync(path, { recursive: true }));
const fp = () => fingerprint(keyPair().key);

const KINDS: [string, (now: number) => Ask, (dir: string) => (() => void) | Promise<() => void>][] = [
  ["a settings commit", () => ({ kind: "settings", subject: "settings", shows: ["Settings commit."], actor: "owner", payload: { sha: SHA40 } }), (dir) => fileAt(join(dir, "settings"))],
  ["a standing rule", (now) => ({ kind: "rule", subject: "rules", shows: ["A rule."], actor: "owner", payload: { agent: "nova", key: fp(), size: "light", window: { from: 0, to: 1439 }, expiresAt: now + 86_400_000, signedAt: now, by: "owner" } }), (dir) => folderAt(join(dir, "workspaces.json"))],
  ["an approver key", () => ({ kind: "approver-add", subject: "box", shows: ["A second approver key."], actor: "owner", payload: { key: keyPair().key } }), async (dir) => {
    // The first key, pinned at the box's screen, so a second one can be added.
    await updateApprovers(rootStateIn(dir).approvers, { rootUid: me }, (s) => trustFirst(s, keyPair().key, Date.now(), "screen"));
    chmodSync(dir, 0o555);
    return () => chmodSync(dir, 0o755);
  }],
  ["a release signer change", () => ({ kind: "signers", subject: "signers", shows: ["Drop a release key."], actor: "taskbox", payload: { sha: SHA40 } }), (dir) => fileAt(join(dir, "update"))],
];

describe("confirm: a failed write never loses the waiting change", () => {
  for (const [what, ask, block] of KINDS)
    test(`${what} stays waiting when its write fails, and leaves once a yes applies it`, async () => {
      const b = await box(ask, block);
      const first = await b.yes();
      expect(first.ok).toBe(false);
      expect(b.ids()).toEqual([b.id]);
      b.unblock();
      const again = await b.yes();
      expect(again).toMatchObject({ ok: true });
      expect(b.ids()).toEqual([]);
    });
});
