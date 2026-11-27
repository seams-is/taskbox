// The update's pure parts: which release to take, what proves one, when an auto-update begins, the
// update settings and their window, the signer changes, and the install records and marks.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { begin } from "../src/core/ops.ts";
import { opType } from "../src/optypes/index.ts";
import { signerFingerprint, statementText } from "../src/release.ts";
import { listProblem, takeList } from "../src/release/revokes.ts";
import { ADD_WAIT_MS, changeOf, confirm, meet, parseRevoke, parseSignerState, parseTransition, refuse, revoke, settle, shaOf, type SignerState, waitingOf } from "../src/release/signers.ts";
import { checkUpdate, DEFAULT_UPDATE, inWindow, updateOf } from "../src/settings/update.ts";
import { autoStep } from "../src/update/auto.ts";
import { listedReleases, pick } from "../src/update/pick.ts";
import { judge, type ProveInput } from "../src/update/prove.ts";
import { frozenLine, holdAfterRollback, keptInstalls, markBad, noMarks, parseInstallRecord, readInstallRecord, writeInstallRecord, type InstallRecord } from "../src/update/records.ts";
import { updateArgsProblem } from "../src/update/start.ts";
import { statementFor } from "./release-fixture.ts";
import { keyPair } from "./sshsig.ts";

const H = 3_600_000;
const T = Date.UTC(2026, 10, 27, 3, 0);
const L = (version: string, hoursAgo = 48) => ({ version, publishedAt: T - hoursAgo * H });

describe("which release an update takes", () => {
  const listed = [L("3.1.0-rc.1"), L("3.0.2"), L("3.0.1"), L("3.0.0")];
  test("stable takes the newest stable release; beta the newest of all, by semver", () => {
    expect(pick({ listed, installed: "3.0.0", channel: "stable", marks: noMarks() })).toEqual({ kind: "take", version: "3.0.2" });
    expect(pick({ listed, installed: "3.0.0", channel: "beta", marks: noMarks() })).toEqual({ kind: "take", version: "3.1.0-rc.1" });
    // A beta box on an rc moves to the release by rule 11.
    expect(pick({ listed: [L("3.0.0"), L("3.0.0-rc.3")], installed: "3.0.0-rc.3", channel: "beta", marks: noMarks() })).toEqual({ kind: "take", version: "3.0.0" });
    // Leaving beta never downgrades: it holds the rc until a stable release overtakes it.
    expect(pick({ listed: [L("3.1.0-rc.1"), L("3.0.2")], installed: "3.1.0-rc.1", channel: "stable", marks: noMarks() })).toMatchObject({ kind: "none" });
  });
  test("bad marks and the hold after a rollback are passed over; --to takes them by hand", () => {
    const m = markBad(noMarks(), "3.0.2", "the selftest failed", T);
    expect(pick({ listed, installed: "3.0.0", channel: "stable", marks: m })).toEqual({ kind: "take", version: "3.0.1" });
    const held = holdAfterRollback(noMarks(), "3.0.2");
    expect(pick({ listed, installed: "3.0.1", channel: "stable", marks: held })).toEqual({ kind: "none", why: "3.0.1 is held after the rollback from 3.0.2, until a newer release" });
    expect(pick({ listed: [L("3.0.3"), ...listed], installed: "3.0.1", channel: "stable", marks: held })).toEqual({ kind: "take", version: "3.0.3" });
    expect(pick({ listed, installed: "3.0.1", channel: "stable", marks: { ...m, ...held }, to: "3.0.2" })).toEqual({ kind: "take", version: "3.0.2" });
  });
  test("--to must be listed, on the channel and newer; --repair takes the one in place", () => {
    expect(pick({ listed, installed: "3.0.0", channel: "stable", marks: noMarks(), to: "3.0.9" })).toMatchObject({ kind: "refuse", why: "the public repo has no published release 3.0.9" });
    expect(pick({ listed, installed: "3.0.0", channel: "stable", marks: noMarks(), to: "3.1.0-rc.1" })).toMatchObject({ kind: "refuse", why: "3.1.0-rc.1 is a beta release, and this box is on stable" });
    expect(pick({ listed, installed: "3.0.2", channel: "stable", marks: noMarks(), to: "v3.0.1" })).toMatchObject({ kind: "refuse" });
    expect(pick({ listed, installed: "3.0.2", channel: "stable", marks: noMarks(), to: "3.0.2" })).toMatchObject({ kind: "refuse", why: "3.0.2 is installed already. taskbox update --repair installs it again" });
    expect(pick({ listed, installed: "3.0.2", channel: "stable", marks: noMarks(), repair: true })).toEqual({ kind: "take", version: "3.0.2" });
  });
  test("auto waits delayHours after publishing", () => {
    expect(pick({ listed: [L("3.0.2", 2), L("3.0.1")], installed: "3.0.0", channel: "stable", marks: noMarks(), auto: { now: T, delayHours: 24 } })).toEqual({ kind: "take", version: "3.0.1" });
  });
  test("GitHub's list is read as far as it can be: drafts, odd tags and a prerelease flag that disagrees are passed over", () => {
    const at = "2026-11-20T10:00:00Z";
    const got = listedReleases([
      { tag_name: "v3.0.1", draft: false, prerelease: false, published_at: at },
      { tag_name: "v3.0.2", draft: true, prerelease: false, published_at: at },
      { tag_name: "v3.1.0-rc.1", draft: false, prerelease: false, published_at: at },
      { tag_name: "v3.1.0-rc.2", draft: false, prerelease: true, published_at: at },
      { tag_name: "tailscale-v1.104.5-run1", draft: false, prerelease: false, published_at: at },
      { tag_name: "v3.0.3", draft: false, prerelease: false },
      "junk",
    ]);
    expect(got.map((l) => l.version)).toEqual(["3.1.0-rc.2", "3.0.1"]);
    expect(listedReleases({ message: "rate limited" })).toEqual([]);
  });
});

describe("what proves a release", () => {
  const base: ProveInput = { swappedAt: 0, now: 60_000, need: ["guard", "keeper", "loop"], before: { Guard: "OK", Disk: "WARN" }, proveMs: 60 * 60_000, testJob: false, s: { beats: { guard: true, keeper: true, loop: true }, rows: { Guard: "OK", Disk: "FAIL" }, selftest: "passed" } };
  test("the beats within 5 minutes, then check's rows that passed before, then the selftest", () => {
    expect(judge(base)).toMatchObject({ kind: "pass", text: "the jobs repo has no test job, so it passed on the selftest" });
    expect(judge({ ...base, s: { ...base.s, beats: { guard: true, loop: true } } })).toMatchObject({ kind: "wait" });
    expect(judge({ ...base, now: 5 * 60_000, s: { ...base.s, beats: { guard: true, loop: true } } })).toMatchObject({ kind: "fail", why: "the GitHub key keeper didn't beat within 5 minutes of the swap" });
    expect(judge({ ...base, s: { ...base.s, rows: { Guard: "FAIL" } } })).toMatchObject({ kind: "fail", why: "check's Guard row passed before the update and doesn't now" });
    expect(judge({ ...base, s: { ...base.s, rows: undefined } })).toMatchObject({ kind: "wait", text: "running check" });
    expect(judge({ ...base, s: { ...base.s, selftest: "failed" } })).toMatchObject({ kind: "fail", why: "the selftest failed" });
  });
  test("the test job when one comes in time; else the selftest alone, and never past the watch's deadline less 10 minutes", () => {
    const t = { ...base, testJob: true };
    expect(judge(t)).toMatchObject({ kind: "wait", text: "waiting for the test job's next run" });
    expect(judge({ ...t, s: { ...t.s, testJob: { conclusion: "success" } } })).toMatchObject({ kind: "pass" });
    expect(judge({ ...t, s: { ...t.s, testJob: { conclusion: "failure" } } })).toMatchObject({ kind: "fail", why: "the test job ended failure" });
    expect(judge({ ...t, now: 60 * 60_000 })).toMatchObject({ kind: "pass", text: "no test job ran in time, so it passed on the selftest" });
    expect(judge({ ...t, now: 21 * 60_000, watchDeadline: 30 * 60_000 })).toMatchObject({ kind: "pass" });
  });
  test("a real job's failure is evidence only: it never fails a proof, and a job-caused vm failure doesn't either", () => {
    const p = judge({ ...base, s: { ...base.s, jobs: [{ name: "app/test", outcome: "failed" }, { name: "app/build", outcome: "vm" }, { name: "app/lint", outcome: "succeeded" }] } });
    expect(p).toMatchObject({ kind: "pass", evidence: ["app/test: failed", "app/build: vm"] });
  });
});

describe("the update settings", () => {
  test("defaults, and each key checked", () => {
    expect(updateOf({})).toEqual(DEFAULT_UPDATE);
    expect(updateOf({ update: { channel: "beta" } }).channel).toBe("beta");
    for (const bad of [{ auto: "yes" }, { window: "2-5" }, { window: "02:00-02:00" }, { channel: "nightly" }, { delayHours: -1 }, { proveMinutes: 500 }, { other: 1 }, { constructor: 1 }, { toString: 1 }, { hasOwnProperty: 1 }]) expect(() => checkUpdate({ update: bad as never })).toThrow();
    expect(() => checkUpdate({ update: { window: "22:00-04:00", delayHours: 24 } })).not.toThrow();
  });
  test("the window is the box's own time, and may cross midnight", () => {
    const at = (h: number, m = 0) => Date.UTC(2026, 10, 27, h, m);
    expect(inWindow("02:00-05:00", at(3), 0)).toEqual({ open: true, endsAt: at(5) });
    expect(inWindow("02:00-05:00", at(5), 0)).toEqual({ open: false });
    // One hour east of UTC: 01:30 UTC is 02:30 there.
    expect(inWindow("02:00-05:00", at(1, 30), 60)).toEqual({ open: true, endsAt: at(4) });
    expect(inWindow("22:00-04:00", at(23), 0)).toEqual({ open: true, endsAt: Date.UTC(2026, 10, 28, 4) });
    expect(inWindow("22:00-04:00", at(12), 0).open).toBe(false);
  });
});

describe("updating by itself", () => {
  const listed = [L("3.0.1")];
  const o = { now: T, offsetMin: 0, u: DEFAULT_UPDATE, channel: "stable" as const, installed: "3.0.0", marks: noMarks(), running: [], listed, tried: new Set<string>() };
  test("in the window, with a newer release, it begins an update whose drain gives up by drainMinutes", () => {
    expect(autoStep({ ...o, listed: undefined })).toEqual({ kind: "list" });
    expect(autoStep(o)).toEqual({ kind: "start", version: "3.0.1", timeout: "60m", key: `3.0.1@${Date.UTC(2026, 10, 27, 5)}` });
    // Near the window's end, the drain gets what is left.
    expect(autoStep({ ...o, now: Date.UTC(2026, 10, 27, 4, 50) })).toMatchObject({ kind: "start", timeout: "10m" });
  });
  test("outside the window, with auto off, beside a box-wide op, once a window, and while a workspace holds the box, it waits", () => {
    expect(autoStep({ ...o, now: Date.UTC(2026, 10, 27, 12) })).toMatchObject({ kind: "idle", why: "outside its window, 02:00-05:00" });
    expect(autoStep({ ...o, u: { ...DEFAULT_UPDATE, auto: false } })).toMatchObject({ kind: "idle" });
    const rm = begin([], opType("remove"), { subject: "box", params: {}, actor: "an admin" }, T);
    expect(autoStep({ ...o, running: rm.kind === "start" ? [rm.op] : [] })).toMatchObject({ kind: "idle", why: "a remove is running" });
    expect(autoStep({ ...o, tried: new Set([`3.0.1@${Date.UTC(2026, 10, 27, 5)}`]) })).toMatchObject({ kind: "idle" });
    expect(autoStep({ ...o, hold: "workspace agent-a-3" })).toEqual({ kind: "held", line: "update 3.0.1 held by workspace agent-a-3" });
    expect(autoStep({ ...o, marks: markBad(noMarks(), "3.0.1", "x", T) })).toMatchObject({ kind: "idle" });
  });
});

describe("an update's and a rollback's args", () => {
  test("each is checked before anything is written", () => {
    expect(updateArgsProblem("update", {})).toBeUndefined();
    expect(updateArgsProblem("update", { to: "3.0.1", force: true, timeout: "30m" })).toBeUndefined();
    expect(updateArgsProblem("update", { channel: "beta" })).toBe("update takes --to, --repair, --force, --timeout only");
    expect(updateArgsProblem("update", { to: "main" })).toBe("--to takes a release version, such as 3.0.1");
    expect(updateArgsProblem("update", { force: true })).toBe("--force needs --timeout: it stops what is left when that runs out");
    expect(updateArgsProblem("update", { auto: true })).toBe("auto is the box's own");
    expect(updateArgsProblem("update", { auto: true, to: "3.0.1" }, { auto: true })).toBeUndefined();
    expect(updateArgsProblem("update", { repair: true, to: "3.0.1" })).toBeDefined();
    expect(updateArgsProblem("rollback", { repair: true })).toBe("rollback takes --to, --force, --timeout only");
  });
});

describe("release signer changes", () => {
  const a = keyPair();
  const b = keyPair();
  const thief = keyPair();
  const fp = (k: ReturnType<typeof keyPair>) => signerFingerprint(k.line.trim())!;
  const transition = (old: ReturnType<typeof keyPair>[], next: ReturnType<typeof keyPair>[], from = "3.0.4") => `${JSON.stringify({ v: 1, type: "signers", old: old.map(fp).sort(), new: next.map((k) => k.line.trim()), fromVersion: from })}\n`;
  const pinned = (...ks: ReturnType<typeof keyPair>[]) => ks.map((k) => k.line).join("");
  const s0: SignerState = { v: 1, pinned: pinned(a) };
  // A read of the revoke list at `at` that found no revoke of the change.
  const readAt = (st: SignerState, at: number): SignerState => takeList(st, { v: 1, type: "revokes", transitions: [] }, fp(a), at).state;
  const BOOT = "11111111-2222-3333-4444-555555555555";
  // Both clocks moving together, in one boot.
  const at = (ms: number, boot = BOOT, mono = ms - T + 1_000) => ({ wall: ms, mono, boot });
  const prints = (st: SignerState) => st.pinned.trim().split("\n").map((l) => signerFingerprint(l));
  // Settled each hour up to `to`, as the guard's pass does, with a good read of the revoke list at `to`.
  const settleTo = (st: SignerState, from: number, to: number, step = 3_600_000) => {
    let cur = st;
    for (let t = from; t <= to; t += step) cur = settle(cur, at(t)).state;
    return settle(readAt(cur, to), at(to)).state;
  };

  test("an add waits 7 days on both clocks, then the pin moves", () => {
    const t = transition([a], [a, b]);
    const m = meet(s0, t, "3.0.4", at(T));
    if ("why" in m) throw new Error(m.why);
    expect(m.said).toBe(`release signers change: adds ${fp(b)} (waits 7 days, then for a read of the revoke list)`);
    expect(settleTo(m.state, T, T + ADD_WAIT_MS - 1).pinned).toBe(s0.pinned);
    // Past the 7 days, the add waits for a read of the revoke list after them, and for no failed read since.
    expect(settle(readAt(m.state, T + ADD_WAIT_MS - 1), at(T + ADD_WAIT_MS)).state.pinned).toBe(s0.pinned);
    expect(settle(listProblem(readAt(m.state, T + ADD_WAIT_MS), "v3.0.4's revoke list can't be read"), at(T + ADD_WAIT_MS)).state.pinned).toBe(s0.pinned);
    const done = settleTo(m.state, T, T + ADD_WAIT_MS);
    expect(waitingOf(done)).toEqual([]);
    expect(prints(done)).toEqual([fp(a), fp(b)]);
    // The same transition met again changes nothing.
    expect(meet(m.state, t, "3.0.5", at(T + 1))).toEqual({ state: m.state, said: "" });
  });

  test("a wall clock stepped forward doesn't end an add's wait: the monotonic count must reach 7 days too", () => {
    const m = meet(s0, transition([a], [a, thief]), "3.0.4", at(T));
    if ("why" in m) throw new Error(m.why);
    // A month on the wall clock, a minute on the monotonic one.
    const stepped = settle(m.state, { wall: T + 30 * ADD_WAIT_MS, mono: 61_000, boot: BOOT });
    expect(stepped.state.pinned).toBe(s0.pinned);
    // A restart carries what was counted; time the box is off doesn't count.
    let cur = settle(m.state, { wall: T + 3 * 86_400_000, mono: 1_000 + 3 * 86_400_000, boot: BOOT }).state;
    cur = settle(cur, { wall: T + 6 * 86_400_000, mono: 5_000, boot: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE" }).state;
    cur = settle(cur, { wall: T + 7 * 86_400_000, mono: 5_000 + 3 * 86_400_000, boot: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE" }).state;
    expect(cur.pinned).toBe(s0.pinned);
    cur = settle(readAt(cur, T + 8 * 86_400_000), { wall: T + 8 * 86_400_000, mono: 5_000 + 4 * 86_400_000 + 1, boot: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE" }).state;
    expect(prints(cur)).toEqual([fp(a), fp(thief)]);
    // No monotonic clock: nothing is counted, so nothing applies.
    expect(settle(readAt(m.state, T + 30 * ADD_WAIT_MS), { wall: T + 30 * ADD_WAIT_MS }).state.pinned).toBe(s0.pinned);
  });

  test("a revoke signed by a key the change keeps cancels a thief's add; the thief's own revoke counts for nothing", () => {
    const t = transition([a], [a, thief]);
    const m = meet(s0, t, "3.0.4", at(T));
    if ("why" in m) throw new Error(m.why);
    const r = parseRevoke(`${JSON.stringify({ v: 1, type: "revoke", transition: shaOf(t) })}\n`)!;
    expect(revoke(m.state, r, fp(thief))).toEqual({ why: "the revoke isn't signed by a key the change keeps" });
    const ok = revoke(m.state, r, fp(a));
    if ("why" in ok) throw new Error(ok.why);
    expect(waitingOf(ok.state)).toEqual([]);
    expect(settleTo(ok.state, T, T + ADD_WAIT_MS).pinned).toBe(s0.pinned);
    // A revoke list names it: by a kept key it is dropped; by the thief's, it isn't, and it isn't a good read.
    const listed = { v: 1 as const, type: "revokes" as const, transitions: [shaOf(t)] };
    expect(waitingOf(takeList(m.state, listed, fp(a), T).state)).toEqual([]);
    expect(waitingOf(takeList(m.state, listed, fp(thief), T + ADD_WAIT_MS).state)[0]?.revokeReadAt).toBeUndefined();
    // A revoked transition is never taken again.
    expect(meet(ok.state, t, "3.0.5", at(T))).toEqual({ why: "it carries a signer transition that was revoked" });
  });

  test("a removal waits for confirm at the box, never for time; a replacement's add still waits its 7 days", () => {
    const two: SignerState = { v: 1, pinned: pinned(a, b) };
    const t = transition([a, b], [a, thief]);
    const m = meet(two, t, "3.0.4", at(T));
    if ("why" in m) throw new Error(m.why);
    expect(settleTo(m.state, T, T + 30 * ADD_WAIT_MS, 86_400_000).pinned.includes(b.line.trim())).toBe(true);
    const c = confirm(m.state, shaOf(t), T + 1);
    if (typeof c === "string") throw new Error(c);
    const early = settle(c, at(T + 2));
    expect(prints(early.state)).toEqual([fp(a)]);
    const late = settleTo(early.state, T + 2, T + ADD_WAIT_MS + 2);
    expect(waitingOf(late)).toEqual([]);
    expect(prints(late)).toEqual([fp(a), fp(thief)]);
  });

  test("a thief's removal and the owner's recovery both wait; the admin refuses one, which goes and blocks nothing, and confirms the other", () => {
    const two: SignerState = { v: 1, pinned: pinned(a, thief) };
    // The thief drops the owner's key; the owner drops the thief's and adds a replacement.
    const bad = transition([a, thief], [thief]);
    const good = transition([a, thief], [a, b], "3.0.5");
    const m1 = meet(two, bad, "3.0.4", at(T));
    if ("why" in m1) throw new Error(m1.why);
    const m2 = meet(m1.state, good, "3.0.5", at(T + 1));
    if ("why" in m2) throw new Error(m2.why);
    expect(waitingOf(m2.state).map((p) => p.sha)).toEqual([shaOf(bad), shaOf(good)]);
    // Refused: dropped at once, and never taken again.
    const r = refuse(m2.state, shaOf(bad));
    if (typeof r === "string") throw new Error(r);
    expect(waitingOf(r).map((p) => p.sha)).toEqual([shaOf(good)]);
    expect(meet(r, bad, "3.0.6", at(T + 2))).toEqual({ why: "it carries a signer transition an admin refused at the box" });
    const c = confirm(r, shaOf(good), T + 3);
    if (typeof c === "string") throw new Error(c);
    const out = settle(c, at(T + 4));
    expect(prints(out.state)).toEqual([fp(a)]);
    expect(prints(settleTo(out.state, T + 4, T + ADD_WAIT_MS + 4))).toEqual([fp(a), fp(b)]);
    // Confirmed without the refuse, the one that moves the pin drops the other.
    const c2 = confirm(m2.state, shaOf(good), T + 3);
    if (typeof c2 === "string") throw new Error(c2);
    const s2 = settle(c2, at(T + 4));
    expect(s2.said).toContain("dropped 1 other signer change made against the pin before");
    expect(waitingOf(s2.state).map((p) => p.sha)).toEqual([shaOf(good)]);
  });

  test("no change may leave no key; its old keys must be the pin's; an older file's one waiting change still reads", () => {
    expect(changeOf(s0.pinned, parseTransition(transition([a], [b]))!, "3.0.4")).toMatchObject({ adds: [fp(b)], removes: [fp(a)] });
    expect(parseTransition(`${JSON.stringify({ v: 1, type: "signers", old: [fp(a)], new: [], fromVersion: "3.0.4" })}\n`)).toBeUndefined();
    expect(changeOf(s0.pinned, parseTransition(transition([b], [a, b]))!, "3.0.4")).toBe("its old keys aren't the ones this box pins");
    expect(changeOf(s0.pinned, parseTransition(transition([a], [a, b]))!, "3.0.3")).toBe("it applies from 3.0.4, after this release");
    // Replacing the only key: the removal, once confirmed, waits for the add, so a key is always pinned.
    const m = meet(s0, transition([a], [b]), "3.0.4", at(T));
    if ("why" in m) throw new Error(m.why);
    const c = confirm(m.state, waitingOf(m.state)[0]!.sha, T);
    if (typeof c === "string") throw new Error(c);
    expect(settle(c, at(T + 1)).state.pinned).toBe(s0.pinned);
    expect(settleTo(c, T, T + ADD_WAIT_MS).pinned.trim()).toBe(b.line.trim());
    const old = parseSignerState({ v: 1, pinned: s0.pinned, pending: waitingOf(m.state)[0] })!;
    expect(waitingOf(old).map((p) => p.sha)).toEqual([waitingOf(m.state)[0]!.sha]);
  });
});

describe("install records and marks", () => {
  const rec = (version: string, at = T): InstallRecord => ({ v: 1, version, statement: statementText(statementFor(version)), signature: "sig", sha256: statementFor(version).sha256, settingsCommit: null, at, by: "an admin", from: null, ended: "installed" });
  test("a record reads strictly: its statement must be its release's", () => {
    expect(parseInstallRecord(rec("3.0.1"))).toEqual(rec("3.0.1"));
    expect(parseInstallRecord({ ...rec("3.0.1"), version: "3.0.2" })).toBe("its statement isn't its release's");
    expect(parseInstallRecord({ ...rec("3.0.1"), ended: "maybe" })).toBe("its ending isn't one taskbox reads");
  });
  test("the kept installs beside /opt/taskbox, newest first; a folder whose record isn't its own is passed over", () => {
    const dir = mkdtempSync(join(tmpdir(), "taskbox-kept-"));
    const me = process.getuid!();
    for (const [name, v] of [["taskbox-3.0.0-aaaaaa", "3.0.0"], ["taskbox-3.0.2-bbbbbb", "3.0.2"], ["taskbox-3.0.1-cccccc", "3.0.1"], ["taskbox-3.0.3-dddddd", "3.0.1"]] as const) {
      mkdirSync(join(dir, name));
      writeInstallRecord(join(dir, name), rec(v), { rootUid: me });
    }
    expect(keptInstalls(dir, me).map((k) => k.record.version)).toEqual(["3.0.2", "3.0.1", "3.0.0"]);
    expect(readInstallRecord(join(dir, "taskbox-3.0.1-cccccc"), me)).toMatchObject({ kind: "ok" });
  });
  test("the 7-day line about the release check", () => {
    expect(frozenLine({ ...noMarks(), checkedAt: T }, T + 6 * 24 * H)).toBeUndefined();
    expect(frozenLine({ ...noMarks(), checkedAt: T }, T + 7 * 24 * H)).toBe("couldn't read the releases for 7 days");
  });
});

describe("when a settings commit may apply", () => {
  const { settingsGate } = require("../src/update/gate.ts") as typeof import("../src/update/gate.ts");
  const at = (h: number) => Date.UTC(2026, 10, 27, h);
  test("keys that change a job VM wait for the window, then a drain; the rest apply at once", () => {
    expect(settingsGate({ keys: ["timings.x", "classes"], u: DEFAULT_UPDATE, now: at(12), offsetMin: 0, drained: false })).toEqual({ phase: "applying" });
    expect(settingsGate({ keys: ["sizes"], u: DEFAULT_UPDATE, now: at(12), offsetMin: 0, drained: false })).toEqual({ phase: "waiting", until: "the update window, 02:00-05:00" });
    expect(settingsGate({ keys: ["sizes"], u: DEFAULT_UPDATE, now: at(3), offsetMin: 0, drained: false })).toEqual({ phase: "draining" });
    expect(settingsGate({ keys: ["image"], u: { ...DEFAULT_UPDATE, auto: false }, now: at(12), offsetMin: 0, drained: true })).toEqual({ phase: "applying" });
  });
});
