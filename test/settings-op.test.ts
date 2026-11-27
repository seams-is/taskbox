// The settings op: the settings repo read through the GitHub key keeper by SHA, validated by this
// release, applied as far as it may be, and guarded keys held until the owner's signed settings apply
// and, for the first tier, an admin's confirm at the box. Narrowing applies at once.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Answer, Ask } from "../src/broker.ts";
import { applyConfirm } from "../src/confirmapply.ts";
import { loadConfig } from "../src/config.ts";
import { readOp } from "../src/core/ops.ts";
import { readPending, waiting as live } from "../src/core/pending.ts";
import { rootStateIn } from "../src/core/paths.ts";
import { handlers } from "../src/handlers/settings.ts";
import { classOf } from "../src/settings/classes.ts";
import { findSettingsRepo, overlaid, validateCommit } from "../src/settings/commit.ts";
import { guarded, guardedChanges, RULES } from "../src/settings/guarded.ts";
import { readInForce, readState, settingsFiles, settingsFilesForApp, updateState, writeInForce } from "../src/settings/inforce.ts";
import { applySigned, readHead, type SettingsDeps, takeConfirmed } from "../src/settings/op.ts";
import { FakeSys } from "./fake.ts";
import { CFG } from "./helpers.ts";

const me = process.getuid!();
const BOOT = "11111111-2222-3333-4444-555555555555";
const sha = (n: number) => n.toString(16).padStart(40, "0");
const BASE = { ...CFG, tools: { entries: [] } } as unknown as Record<string, unknown>;
const text = (o: unknown) => JSON.stringify(o);
const PIN = { name: "node.tar.gz", os: "macos", url: "https://example.com/node.tar.gz", sha256: "a".repeat(64) };

function box(o: { v2?: Record<string, unknown>; box?: Record<string, unknown> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "taskbox-settings-"));
  mkdirSync(join(dir, "ops"));
  mkdirSync(join(dir, "events"));
  const state = rootStateIn(dir);
  const files = settingsFiles(dir);
  const written: { type: string; text: string; actor: string }[] = [];
  const asks: Ask[] = [];
  let head: { sha: string; product?: string; overlay?: string } = { sha: sha(1), product: text(BASE) };
  let boxKeys: Record<string, unknown> | undefined = { settingsRepo: "example-org/box-settings", ...o.box };
  const t = { now: 1_800_000_000_000, mono: 5_000 };
  const ask = async (a: Ask): Promise<Answer> => {
    asks.push(a);
    if (a.ask === "settings-files") {
      if (a.etag === `"${head.sha}"`) return { ok: true, unchanged: true };
      return { ok: true, sha: head.sha, etag: `"${head.sha}"`, ...(head.product !== undefined ? { product: head.product } : {}), ...(head.overlay !== undefined ? { overlay: head.overlay } : {}) };
    }
    if (a.ask === "runner-repos") return { ok: true, repos: ["example-org/taskbox", "example-org/box-settings"] };
    return { ok: false, why: "no", class: "ask" };
  };
  const d: SettingsDeps = {
    now: () => t.now,
    files,
    state,
    rootUid: me,
    events: { write: (e) => (written.push({ type: e.type, text: e.text, actor: e.actor }), { ...e, id: "ev", at: "", writer: "guard" }) as never },
    log: () => {},
    ask,
    box: "box-1",
    boxKeys: () => boxKeys,
    setBoxKeys: (set) => void (boxKeys = { ...boxKeys, ...set }),
    v2: () => o.v2,
    moment: async () => ({ wall: t.now, mono: t.mono, boot: BOOT }),
  };
  const commit = (n: number, product: Record<string, unknown>, overlay?: Record<string, unknown>) => (head = { sha: sha(n), product: text(product), ...(overlay ? { overlay: text(overlay) } : {}) });
  const st = () => {
    const r = readState(files, me);
    if (r.kind !== "ok") throw new Error(`no state: ${r.kind}`);
    return r.value;
  };
  const inForce = () => {
    const r = readInForce(files, me);
    if (r.kind !== "ok") throw new Error(`nothing in force: ${r.kind}`);
    return r.value;
  };
  const op = (id: string) => {
    const r = readOp({ dir: state.ops, owner: me }, id);
    if (r.kind !== "ok") throw new Error("no op");
    return r.value;
  };
  const pending = async () => {
    const p = readPending(state.pending, me);
    return p.kind === "ok" ? live(p.value, { wall: t.now, mono: t.mono, boot: BOOT }) : [];
  };
  // An admin's yes at the box, as confirm leaves it for the guard.
  const confirmYes = async (yes = true) => {
    const item = (await pending())[0]!;
    await updateState(files, { rootUid: me }, (s) => ({ state: { ...s, confirmed: [{ pending: item.id, sha: (item.payload as { sha: string }).sha, by: "an admin", at: t.now, yes }] }, out: undefined }));
    return takeConfirmed(d);
  };
  return { d, dir, state, files, written, asks, t, commit, st, inForce, op, pending, confirmYes, boxKeys: () => boxKeys };
}

describe("the classes and the overlay", () => {
  test("a box's own numbers are box keys; the overlay holds only those, and linux's numbers", () => {
    for (const k of ["runnerNamePrefix", "vmsAtMost", "minFreeDiskGB", "accounts", "tailnetTag"]) expect({ k, c: classOf(k) }).toEqual({ k, c: "box" });
    expect(classOf("settingsRepo")).toBe("local");
    const o = overlaid({ ...BASE, linux: { label: "l", image: "i", vmCpus: 4, vmMemoryMB: 8192 } }, { vmMaxHours: 6, image: "x", linux: { vmMemoryMB: 4096, image: "y" }, sources: [] });
    expect(o.kept).toEqual({ vmMaxHours: 6, linux: { vmMemoryMB: 4096 } });
    expect(o.doc.linux).toEqual({ label: "l", image: "i", vmCpus: 4, vmMemoryMB: 4096 });
    expect(o.doc.image).toBe(CFG.image);
    expect(o.ignored.sort()).toEqual(["image", "linux.image", "sources"]);
  });

  test("a key that reaches a prototype refuses the file", () => {
    const c = validateCommit({ sha: sha(1), repo: "a/b", box: "box-1", product: '{"__proto__":{"x":1}}', overlay: undefined, now: 1 });
    expect(c).toMatchObject({ ok: false, why: expect.stringMatching(/__proto__ isn't taken/) });
  });

  test("a product file that fails refuses the commit; an overlay that fails is set aside alone", () => {
    expect(validateCommit({ sha: sha(1), repo: "a/b", box: "box-1", product: text({ ...BASE, slots: 2 }), overlay: undefined, now: 1 })).toMatchObject({ ok: false, why: expect.stringMatching(/slots stays 1/) });
    const c = validateCommit({ sha: sha(1), repo: "a/b", box: "box-1", product: text({ ...BASE, someday: 1 }), overlay: text({ tailscaleTun: "eth0" }), now: 1 });
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.v.overlay).toBeNull();
    expect(c.v.overlayProblem).toMatch(/^with boxes\/box-1\.json, /);
    expect(c.v.unknown).toEqual(["someday"]);
    expect(validateCommit({ sha: sha(1), repo: "a/b", box: "box-1", product: undefined, overlay: undefined, now: 1 })).toEqual({ ok: false, why: "the settings repo has no taskbox.json" });
  });

  test("the settings repo is found among the runner App's repos: one, none, or several", () => {
    expect(findSettingsRepo(["o/taskbox", "o/box-settings"], "o/taskbox")).toEqual({ repo: "o/box-settings" });
    expect(findSettingsRepo(["o/taskbox"], "o/taskbox")).toEqual({ none: true });
    expect(findSettingsRepo(["o/a", "o/b"])).toEqual({ several: ["o/a", "o/b"] });
  });
});

describe("the guarded keys", () => {
  test("every key that names an account, a workflow, a channel, an alarm, a pin or a digest is guarded", () => {
    for (const k of ["accounts", "accounts.people", "accounts.ssh", "tailnetTag", "runnerGroup", "jobsFrom", "screenSharingUsers", "away", "update.channel", "tools.entries", "image", "linux.image", "approverKey", "sources", "runnerApp", "appId", "org", "workspaces", "network.diagnostics"]) expect({ k, g: guarded(k) }).toEqual({ k, g: true });
    for (const k of ["timings", "classes", "label", "vmCpus"]) expect({ k, g: guarded(k) }).toEqual({ k, g: false });
    expect(RULES.filter((r) => r.path === "tailnetTag")[0]?.tier).toBe(1);
  });

  test("a person added widens and is first tier; one taken away narrows", () => {
    const one = { ...BASE, accounts: { ...CFG.accounts, people: ["person1"] } };
    const two = { ...BASE, accounts: { ...CFG.accounts, people: ["person1", "person2"] } };
    expect(guardedChanges(one, two)).toMatchObject([{ path: "accounts.people", tier: 1, narrows: false }]);
    expect(guardedChanges(two, one)).toMatchObject([{ path: "accounts.people", tier: 1, narrows: true }]);
  });

  test("a new pin, an image digest and less room are second tier; the channel to beta is first, to stable narrows", () => {
    const c = guardedChanges(BASE, { ...BASE, tools: { entries: [PIN] }, image: CFG.image.replace(/0{64}$/, "1".repeat(64)), minFreeDiskGB: 10, update: { channel: "beta" } });
    expect(c.map((x) => [x.path, x.tier, x.narrows])).toEqual([["update.channel", 1, false], ["minFreeDiskGB", 2, false], ["tools.entries", 2, false], ["image", 2, false]]);
    expect(guardedChanges({ ...BASE, update: { channel: "beta" } }, { ...BASE, update: { channel: "stable" } })[0]?.narrows).toBe(true);
    expect(guardedChanges({ ...BASE, tools: { entries: [PIN] } }, BASE)[0]).toMatchObject({ path: "tools.entries", narrows: true });
  });

  test("the words say each change, on one line of at most 120 characters", () => {
    const [c] = guardedChanges(BASE, { ...BASE, tailnetTag: "tag:taskbox-studio" });
    expect(c!.words).toBe('tailnetTag: nothing to "tag:taskbox-studio" (which of the tailnet\'s rules reach the box)');
    const long = guardedChanges(BASE, { ...BASE, tools: { entries: Array.from({ length: 5 }, (_, i) => ({ ...PIN, name: `t${i}.tar.gz` })) } })[0]!;
    expect(long.words.length).toBeLessThanOrEqual(120);
  });
});

describe("the settings op", () => {
  test("the first commit, the same as v2.6.1's file, applies whole and at once", async () => {
    const b = box({ v2: BASE });
    expect(await readHead(b.d)).toBe(`settings: commit ${sha(1).slice(0, 12)} applied`);
    expect(b.inForce()).toMatchObject({ sha: sha(1), held: [] });
    expect(b.st()).toMatchObject({ inUse: sha(1), repo: "example-org/box-settings", head: { sha: sha(1), etag: `"${sha(1)}"` } });
    expect(b.written.map((e) => e.type)).toEqual(["op.started", "op.progress", "settings.applied", "op.succeeded"]);
    // Asked by SHA through the guard's socket, for this box's overlay.
    expect(b.asks[0]).toEqual({ ask: "settings-files", repo: "example-org/box-settings", box: "box-1" });
  });

  test("an unchanged head costs one ETag read and changes nothing", async () => {
    const b = box({ v2: BASE });
    await readHead(b.d);
    const before = readFileSync(b.files.inForce, "utf8");
    b.t.now += 3600_000;
    expect(await readHead(b.d)).toBe("");
    expect(b.asks.at(-1)).toMatchObject({ etag: `"${sha(1)}"` });
    expect(readFileSync(b.files.inForce, "utf8")).toBe(before);
    expect(b.st().head?.readAt).toBe(b.t.now);
  });

  test("a change to keys that aren't guarded applies at once; the overlay's keys are this box's", async () => {
    const b = box({ v2: BASE });
    await readHead(b.d);
    b.commit(2, { ...BASE, timings: { floorMinutes: 20 } }, { vmMaxHours: 12 });
    expect(await readHead(b.d)).toMatch(/applied$/);
    expect(b.inForce()).toMatchObject({ sha: sha(2), held: [], overlayKeys: ["vmMaxHours"] });
    expect(b.inForce().doc).toMatchObject({ timings: { floorMinutes: 20 }, vmMaxHours: 12 });
  });

  test("a guarded widening waits for settings apply, held at its old value, while the rest applies", async () => {
    const b = box({ v2: BASE });
    await readHead(b.d);
    b.commit(2, { ...BASE, tools: { entries: [PIN] }, timings: { floorMinutes: 20 } });
    expect(await readHead(b.d)).toMatch(/waits for settings apply$/);
    expect(b.inForce()).toMatchObject({ sha: sha(2), held: ["tools.entries"] });
    expect(b.inForce().doc).toMatchObject({ tools: { entries: [] }, timings: { floorMinutes: 20 } });
    const w = b.st().waiting!;
    expect(w).toMatchObject({ sha: sha(2), phase: "needs-owner", first: false });
    expect(b.op(w.op)).toMatchObject({ type: "settings", state: "running", phase: "needs-owner" });
    // An update's signature never applies it: only the owner's settings apply does.
    const r = await applySigned(b.d, sha(2), "owner (signed, key 3f9a)");
    expect(r).toMatchObject({ ok: true, said: expect.stringMatching(/tools\.entries/) });
    expect(b.inForce()).toMatchObject({ held: [] });
    expect(b.inForce().doc).toMatchObject({ tools: { entries: [PIN] } });
    expect(b.op(w.op).state).toBe("succeeded");
    expect(b.st().waiting).toBeUndefined();
  });

  test("a first-tier widening waits for settings apply, then for confirm at the box, which applies it", async () => {
    const b = box({ v2: BASE });
    await readHead(b.d);
    b.commit(2, { ...BASE, accounts: { ...CFG.accounts, people: ["person1"] }, away: { githubFailures: 9 } });
    await readHead(b.d);
    expect(b.inForce().held.sort()).toEqual(["accounts.people", "away"]);
    const r = await applySigned(b.d, sha(2), "owner (signed, key 3f9a)");
    expect(r).toMatchObject({ ok: false, code: "needs-confirm", said: expect.stringMatching(/^Applied away\. accounts\.people waits for confirm at the box/) });
    expect(b.inForce()).toMatchObject({ held: ["accounts.people"] });
    expect(b.inForce().doc).toMatchObject({ away: { githubFailures: 9 }, accounts: { people: [] } });
    const [item] = await b.pending();
    expect(item).toMatchObject({ kind: "settings", actor: "owner (signed, key 3f9a)", shows: [`Settings commit ${sha(2).slice(0, 12)} from example-org/box-settings:`, 'accounts.people: [] to ["person1"] (who reaches the box)'] });
    // A second apply while it waits for confirm says so.
    expect(await applySigned(b.d, sha(2), "owner")).toMatchObject({ ok: false, code: "needs-confirm" });
    expect(await b.confirmYes()).toEqual([`settings: commit ${sha(2).slice(0, 12)} confirmed and applied`]);
    expect(b.inForce()).toMatchObject({ held: [] });
    expect(b.inForce().doc).toMatchObject({ accounts: { people: ["person1"] } });
    expect(b.st()).toMatchObject({ inUse: sha(2) });
    expect(b.st().waiting).toBeUndefined();
  });

  test("confirm's answer through the admin spool: the guard leaves it for the settings pass, and names the admin in root's record", async () => {
    const b = box({ v2: BASE });
    await readHead(b.d);
    b.commit(2, { ...BASE, accounts: { ...CFG.accounts, people: ["person1"] } });
    await readHead(b.d);
    await applySigned(b.d, sha(2), "owner (signed, key 3f9a)");
    const [item] = await b.pending();
    const sys = new FakeSys();
    sys.clock = b.t.now;
    sys.monoOffset = b.t.mono - b.t.now;
    const seen: { id?: string; type: string; actor: string }[] = [];
    const events = { write: (e: { id?: string; type: string; actor: string }) => (seen.push(e), { ...e, id: e.id ?? "ev", at: "", writer: "guard" }) } as never;
    const p = { installId: join(b.dir, "install-id") } as never;
    expect(await applyConfirm({ sys, p, rootUid: me, events }, { id: item!.id, yes: true, admin: "admin1" })).toMatchObject({ ok: true, said: expect.stringContaining("next tick") });
    expect(await b.pending()).toEqual([]);
    expect(b.st().confirmed).toEqual([{ pending: item!.id, sha: sha(2), by: "an admin", at: b.t.now, yes: true }]);
    expect(seen.map((e) => [e.type, e.actor])).toEqual([["confirm.confirmed", "an admin"]]);
    expect(JSON.parse(readFileSync(b.state.admins, "utf8").trim())).toEqual({ id: seen[0]!.id, name: "admin1" });
    expect(await takeConfirmed(b.d)).toEqual([`settings: commit ${sha(2).slice(0, 12)} confirmed and applied`]);
    expect(b.inForce().doc).toMatchObject({ accounts: { people: ["person1"] } });
    // The same answer twice changes nothing.
    expect(await applyConfirm({ sys, p, rootUid: me, events }, { id: item!.id, yes: true, admin: "admin1" })).toMatchObject({ ok: false });
  });

  test("a refusal at the box passes the commit over: what applied stays, the held change stays held", async () => {
    const b = box({ v2: BASE });
    await readHead(b.d);
    b.commit(2, { ...BASE, tailnetTag: "tag:taskbox-studio", timings: { floorMinutes: 20 } });
    await readHead(b.d);
    await applySigned(b.d, sha(2), "owner");
    await b.confirmYes(false);
    expect(b.st()).toMatchObject({ passed: sha(2) });
    expect(b.inForce().doc.tailnetTag).toBeUndefined();
    expect(b.inForce().doc).toMatchObject({ timings: { floorMinutes: 20 } });
    b.t.now += 3600_000;
    expect(await readHead(b.d)).toBe("");
  });

  test("narrowing applies at once, with no signature: a person taken away", async () => {
    const two = { ...BASE, accounts: { ...CFG.accounts, people: ["person1", "person2"], ssh: ["person1"] } };
    const b = box({ v2: two });
    b.commit(1, two);
    await readHead(b.d);
    expect(b.inForce().held).toEqual([]);
    b.commit(2, { ...two, accounts: { ...CFG.accounts, people: ["person1"] } });
    expect(await readHead(b.d)).toMatch(/applied$/);
    expect(b.inForce().doc).toMatchObject({ accounts: { people: ["person1"] } });
    expect(b.st().waiting).toBeUndefined();
  });

  test("the first commit that differs from v2.6.1's file goes straight to confirm: no controller is paired yet", async () => {
    const b = box({ v2: BASE });
    b.commit(1, { ...BASE, accounts: { ...CFG.accounts, ssh: [], people: ["person1"] }, update: { channel: "beta" } });
    expect(await readHead(b.d)).toMatch(/waits for confirm$/);
    expect(b.st().waiting).toMatchObject({ phase: "needs-confirm", first: true });
    expect((await b.pending())[0]).toMatchObject({ actor: "taskbox" });
    expect(await applySigned(b.d, sha(1), "owner")).toMatchObject({ code: "needs-confirm" });
    await b.confirmYes();
    expect(b.inForce().doc).toMatchObject({ update: { channel: "beta" }, accounts: { people: ["person1"] } });
  });

  test("a fresh box's first commit, with nothing before it, waits for confirm whole", async () => {
    const b = box();
    expect(await readHead(b.d)).toMatch(/waits for confirm$/);
    // Nothing can stand with every guarded key held back, so nothing is in force until the yes.
    expect(readInForce(b.files, me).kind).toBe("missing");
    await b.confirmYes();
    expect(b.inForce()).toMatchObject({ sha: sha(1), held: [] });
  });

  test("an invalid commit is never applied: the commit in use stays, and the row's problem names it", async () => {
    const b = box({ v2: BASE });
    await readHead(b.d);
    b.commit(2, { ...BASE, slots: 3 });
    expect(await readHead(b.d)).toMatch(/isn't valid: taskbox\.json: slots stays 1/);
    expect(b.inForce().sha).toBe(sha(1));
    expect(b.st().problem).toMatchObject({ sha: sha(2) });
    expect(b.written.some((e) => e.type === "settings.invalid")).toBe(true);
  });

  test("a newer commit passes over one that waits, and its confirm goes", async () => {
    const b = box({ v2: BASE });
    await readHead(b.d);
    b.commit(2, { ...BASE, tailnetTag: "tag:taskbox-studio" });
    await readHead(b.d);
    await applySigned(b.d, sha(2), "owner");
    const old = b.st().waiting!.op;
    expect((await b.pending()).length).toBe(1);
    b.commit(3, { ...BASE, timings: { floorMinutes: 20 } });
    await readHead(b.d);
    expect(b.op(old)).toMatchObject({ state: "cancelled", why: expect.stringMatching(/newer settings commit/) });
    expect(await b.pending()).toEqual([]);
    expect(b.inForce()).toMatchObject({ sha: sha(3), held: [] });
  });

  test("settings apply names only the commit that waits", async () => {
    const b = box({ v2: BASE });
    await readHead(b.d);
    expect(await applySigned(b.d, sha(9), "owner")).toMatchObject({ ok: false, code: "not-found" });
  });

  test("the settings repo is found from the runner App's repos when box.json names none", async () => {
    const b = box({ v2: { ...BASE, releaseRepo: "taskbox" } });
    b.commit(1, { ...BASE, releaseRepo: "taskbox" });
    b.d.boxKeys = () => undefined;
    let set: Record<string, unknown> | undefined;
    b.d.setBoxKeys = (s) => void (set = s);
    expect(await readHead(b.d)).toMatch(/applied$/);
    expect(set).toEqual({ settingsRepo: "example-org/box-settings" });
    expect(b.asks[0]).toEqual({ ask: "runner-repos", org: "example-org" });
  });
});

describe("who reads the settings in force", () => {
  test("loadConfig takes them over the install's own file, with box.json over them", () => {
    const root = mkdtempSync(join(tmpdir(), "taskbox-inforce-"));
    const app = join(root, "opt/taskbox/app");
    mkdirSync(app, { recursive: true });
    mkdirSync(join(root, "opt/taskbox-state"), { recursive: true });
    writeFileSync(join(app, "taskbox.json"), text(BASE));
    const files = settingsFilesForApp(app);
    writeInForce(files, { v: 1, sha: sha(7), at: 1, held: ["tools.entries"], doc: { ...BASE, vmMaxHours: 6 }, overlayKeys: ["vmMaxHours"], overlayIgnored: [], unknown: [] }, { rootUid: me });
    const c = loadConfig(app, join(root, "opt/taskbox-state/box.json"), me);
    expect(c.vmMaxHours).toBe(6);
    expect(c.settingsIn).toEqual({ sha: sha(7), held: ["tools.entries"], overlayKeys: ["vmMaxHours"], unknown: [] });
    // A file another account wrote is never read as root's: the install's own is used.
    expect(loadConfig(app, join(root, "opt/taskbox-state/box.json"), me + 1).vmMaxHours).toBe(24);
  });
});

describe("the signed handlers", () => {
  const [apply, repo, withdraw] = handlers.signed;
  test("each checks its words before the signature, so a bad one uses no nonce", () => {
    expect(apply!.check!({ words: [sha(1)] })).toBeUndefined();
    expect(apply!.check!({ words: ["abc"] })).toMatch(/40-character/);
    expect(apply!.check!({ words: [sha(1)], force: true })).toMatch(/40-character/);
    expect(repo!.check!({ words: ["example-org/box-settings"] })).toBeUndefined();
    expect(repo!.check!({ words: ["nothing"] })).toMatch(/ORG\/REPO/);
    expect(withdraw!.check!({ words: ["pc_01JD8Q4ZZZZZZZZZZZZZZZZZZZ"] })).toBeUndefined();
    expect([apply, repo, withdraw].map((h) => h!.subject({}))).toEqual(["box", "box", "box"]);
  });
});

describe("temporary admin SSH", () => {
  const until = (ms: number) => new Date(ms).toISOString();
  const NOW = 1_800_000_000_000;
  const open = { login: "person1@example.com", user: "pat-admin", until: until(NOW + 4 * 3600_000) };

  test("while open, the policy accepts that login to that admin user, with its sshTests line, and no deny for it", async () => {
    const { policyFor } = await import("../src/policy.ts");
    const { openWindow } = await import("../src/settings/adminssh.ts");
    const p = policyFor(CFG.accounts, { owner: "owner@example.com", admins: ["pat-admin", "other"], adminSsh: openWindow(open, NOW)! });
    expect(p.ssh).toContainEqual({ action: "accept", src: ["person1@example.com"], dst: ["tag:taskbox"], users: ["pat-admin"] });
    expect(p.sshTests).toContainEqual({ src: "person1@example.com", dst: ["tag:taskbox"], accept: ["pat-admin"] });
    expect(JSON.stringify(p.sshTests)).not.toMatch(/"deny":\[[^\]]*"pat-admin"/);
    expect(p.grants).toContainEqual({ src: ["person1@example.com"], dst: ["tag:taskbox"], ip: ["tcp:22"] });
  });

  test("once it expires, the next policy drops it, and the admin is denied again", async () => {
    const { policyFor } = await import("../src/policy.ts");
    const { openWindow } = await import("../src/settings/adminssh.ts");
    const temp = openWindow(open, NOW + 5 * 3600_000);
    expect(temp).toBeUndefined();
    const p = policyFor(CFG.accounts, { owner: "owner@example.com", admins: ["pat-admin"], ...(temp ? { adminSsh: temp } : {}) });
    expect(JSON.stringify(p)).not.toContain("person1@example.com");
    expect(p.sshTests[0]!.deny).toContain("pat-admin");
  });

  test("an agent identity is refused: the agent's account, a tag, or any role's account", async () => {
    const { adminSshProblem } = await import("../src/settings/adminssh.ts");
    const { policyFor } = await import("../src/policy.ts");
    expect(adminSshProblem({ ...open, user: "taskbox-agent" }, CFG.accounts)).toMatch(/never an account taskbox gives a role/);
    expect(adminSshProblem({ ...open, user: "taskbox" }, CFG.accounts)).toMatch(/never an account taskbox gives a role/);
    expect(adminSshProblem({ ...open, login: "tag:taskbox-agents" }, CFG.accounts)).toMatch(/never a tag/);
    expect(adminSshProblem({ ...open, login: "autogroup:member" }, CFG.accounts)).toMatch(/never a tag/);
    expect(adminSshProblem({ ...open, user: "root" }, CFG.accounts)).toMatch(/admin user/);
    expect(adminSshProblem(open, CFG.accounts)).toBeUndefined();
    expect(() => policyFor(CFG.accounts, { adminSsh: { login: "a@example.com", user: "taskbox-agent" } })).toThrow(/taskbox role/);
  });

  test("it is a first-tier guarded key: a past expiry is refused, a new window waits for apply and confirm, ending it applies at once", async () => {
    expect(RULES.find((r) => r.path === "adminSsh")?.tier).toBe(1);
    const b = box({ v2: BASE });
    await readHead(b.d);
    b.commit(2, BASE, { adminSsh: { ...open, until: until(b.t.now - 60_000) } });
    expect(await readHead(b.d)).toMatch(/isn't valid: adminSsh\.until, .*, is past/);
    b.commit(3, BASE, { adminSsh: { ...open, until: until(b.t.now + 3600_000) } });
    expect(await readHead(b.d)).toMatch(/waits for settings apply$/);
    expect(b.inForce().doc.adminSsh).toBeUndefined();
    expect(await applySigned(b.d, sha(3), "owner")).toMatchObject({ code: "needs-confirm" });
    await b.confirmYes();
    expect(b.inForce().doc.adminSsh).toMatchObject({ user: "pat-admin" });
    b.commit(4, BASE);
    expect(await readHead(b.d)).toMatch(/applied$/);
    expect(b.inForce().doc.adminSsh).toBeUndefined();
  });

  test("check warns while it is open, and says the access has gone once the pasted policy dropped it", async () => {
    const { adminSshRow } = await import("../src/rows/settings.ts");
    const { FakeSys } = await import("./fake.ts");
    const sys = new FakeSys();
    sys.clock = NOW;
    const ctx = (adminSsh: unknown, netmap?: unknown) => {
      sys.run = async () => ({ code: netmap ? 0 : 1, stdout: JSON.stringify(netmap ?? {}), stderr: "" });
      return { sys, cfg: { ...CFG, adminSsh }, paths: { tailscale: "/t", tailscaleSocket: "/s" }, uid: 0, serviceUid: 501 } as never;
    };
    expect(await adminSshRow(ctx(open))).toMatchObject({ status: "WARN", detail: expect.stringMatching(/pat-admin by Tailscale SSH until /) });
    const ended = { ...open, until: until(NOW - 1) };
    const still = { SSHPolicy: { rules: [{ action: { accept: true }, sshUsers: { "pat-admin": "pat-admin" } }] } };
    expect(await adminSshRow(ctx(ended, still))).toMatchObject({ status: "FAIL", detail: expect.stringMatching(/still lets it in/) });
    expect(await adminSshRow(ctx(ended, { SSHPolicy: { rules: [] } }))).toMatchObject({ status: "OK", detail: expect.stringMatching(/no longer let it in/) });
  });
});

describe("update --check's settings read", () => {
  test("it asks the guard to read now, and says what the read found", async () => {
    const { settingsReadNow } = await import("../src/settings/check.ts");
    const b = box({ v2: BASE });
    await readHead(b.d);
    b.commit(2, { ...BASE, tools: { entries: [PIN] } });
    const sys = { now: () => b.t.now, sleep: async () => void (readState(b.files, me).kind === "ok" && readState(b.files, me).kind === "ok" && (await readHead(b.d))) };
    const r = await settingsReadNow(sys, b.files, { rootUid: me });
    expect(r).toEqual({ read: true, lines: [`Settings: commit ${sha(2).slice(0, 12)} waits for taskbox settings apply ${sha(2)} from the controller.`] });
  });

  test("with the guard down it says so, and a box with no settings repo says how to name one", async () => {
    const { settingsReadNow } = await import("../src/settings/check.ts");
    const b = box({ v2: BASE });
    expect((await settingsReadNow({ now: () => 1, sleep: async () => {} }, b.files, { rootUid: me })).lines[0]).toMatch(/reads no settings repo yet/);
    await readHead(b.d);
    expect(await settingsReadNow({ now: () => 1, sleep: async () => {} }, b.files, { rootUid: me })).toMatchObject({ read: false, lines: [expect.stringMatching(/hasn't read/)] });
    expect(b.st().readNow).toBe(true);
  });

  test("status --json carries the admin SSH window's user and end, never the login", async () => {
    const { windowJson } = await import("../src/settings/adminssh.ts");
    const v = { login: "person1@example.com", user: "pat-admin", until: new Date(2_000_000_000_000).toISOString() };
    expect(windowJson(v, 1_900_000_000_000)).toEqual({ user: "pat-admin", until: v.until });
    expect(windowJson(v, 2_000_000_000_000)).toBeNull();
    expect(windowJson(undefined, 1)).toBeNull();
  });
});

describe("the update window and the drain", () => {
  test("a commit that changes a job VM waits for the window, then a drain, then applies and resumes; the rest apply at once", async () => {
    const { takeDeferred } = await import("../src/settings/op.ts");
    const { settingsGate } = await import("../src/update/gate.ts");
    const { DEFAULT_UPDATE } = await import("../src/settings/update.ts");
    const b = box({ v2: BASE });
    let open = false;
    let drained = false;
    const did: string[] = [];
    b.d.hold = {
      gate: (keys, dr) => settingsGate({ keys, u: DEFAULT_UPDATE, now: open ? Date.UTC(2026, 10, 27, 3) : Date.UTC(2026, 10, 27, 12), offsetMin: 0, drained: dr }),
      drained: () => drained,
      drain: async (op) => void did.push(`drain ${op}`),
      resume: async (op) => void did.push(`resume ${op}`),
    };
    await readHead(b.d);
    const first = b.inForce().sha;
    b.commit(2, { ...BASE, timings: { pollSeconds: 30 } });
    b.t.now += 2 * 3600_000;
    await readHead(b.d);
    expect(b.inForce().sha).toBe(sha(2));
    b.commit(3, { ...BASE, timings: { pollSeconds: 30 }, vmMemoryMB: 4096 });
    b.t.now += 2 * 3600_000;
    await readHead(b.d);
    const df = b.st().deferred!;
    expect(df.sha).toBe(sha(3));
    expect(b.op(df.op).phase).toBe("waiting");
    expect(b.inForce().sha).toBe(sha(2));
    open = true;
    await takeDeferred(b.d);
    expect(b.op(df.op).phase).toBe("draining");
    expect(did).toEqual([`drain ${df.op}`]);
    await takeDeferred(b.d);
    expect(b.inForce().sha).toBe(sha(2));
    drained = true;
    await takeDeferred(b.d);
    expect(b.inForce().sha).toBe(sha(3));
    expect(b.op(df.op).state).toBe("succeeded");
    expect(did).toEqual([`drain ${df.op}`, `resume ${df.op}`]);
    expect(b.st().deferred).toBeUndefined();
    expect(first).toBe(sha(1));
  });
});
