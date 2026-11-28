// key rotate tailscale (tsrotate.ts, tsbox.ts): the job VMs drained and gone, tailscaled's socket
// locked against the service account and tailscaled restarted, its state copied aside, all before
// the re-auth; Tailscale SSH off until the pinned tailnet is proved; a slow or failed rotation puts
// the old sign-in back; and the guard settles one whose op ended mid-way. Against fakes.
import { describe, expect, test } from "bun:test";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "../src/config.ts";
import type { HandlerCtx } from "../src/core/dispatch.ts";
import { eventLog } from "../src/core/events.ts";
import { begin, readOp, writeOp } from "../src/core/ops.ts";
import { rootStateOf } from "../src/core/paths.ts";
import { Verified } from "../src/core/statement.ts";
import { linkPath, readLink, startTsRotation, writeLink } from "../src/keyops.ts";
import { blankLinks } from "../src/logins.ts";
import { opType } from "../src/optypes/index.ts";
import { ROTATE } from "../src/optypes/keys.ts";
import { settleTsRotation, tsBox } from "../src/tsbox.ts";
import { BACKUP_FILE, openSealed, pinTailnet, readTailnetPin, rotateTailscale, sealPair, type TsBox, type TsDeps, upArgs } from "../src/tsrotate.ts";
import { DIR_ENTRY, keepSocket, lockPath, newSocketMemory, readLock, SOCKET_ENTRY } from "../src/tssocket.ts";
import { FakeSys } from "./fake.ts";
import { CFG, tempRoot, testBox } from "./helpers.ts";

const me = process.getuid!();
const OLD = `nodekey:${"1".repeat(64)}`;
const NEW = `nodekey:${"2".repeat(64)}`;
const URL_ = "https://login.tailscale.com/a/1a2b3c4d5e6f";

// tailscaled as the rotation sees it. Its state file holds which sign-in it has: the old one, or the
// re-auth's. A start reads it back, as tailscaled does.
function tailscaled(sys: FakeSys, stateFile: string) {
  const t = { state: "Running", url: "", tailnet: "example.ts.net", node: OLD, online: true, log: [] as string[], approve: "" as "" | "own" | "other", given: false };
  writeFileSync(stateFile, "old sign-in");
  sys.responders.push((cmd, args) => {
    if (cmd === "/opt/taskbox/bin/tailscale") {
      const verb = args[1]!;
      t.log.push(args.slice(1).join(" "));
      if (verb === "status") {
        // The owner (or a thief) approves at some look after the link exists.
        if (t.url && t.approve && t.given) Object.assign(t, { state: "Running", url: "", node: NEW, tailnet: t.approve === "own" ? "example.ts.net" : "thief.example.ts.net" });
        return { code: 0, stdout: JSON.stringify({ BackendState: t.state, AuthURL: t.url, CurrentTailnet: { Name: t.tailnet }, Self: { PublicKey: t.node, Online: t.online } }), stderr: "" };
      }
      if (verb === "up") {
        Object.assign(t, { state: "NeedsLogin", url: URL_ });
        writeFileSync(stateFile, "re-auth");
        return { code: 1, stdout: "", stderr: `To authenticate, visit:\n\n\t${URL_}\n` };
      }
      if (verb === "logout") return (Object.assign(t, { state: "NeedsLogin" }), { code: 0, stdout: "", stderr: "" });
      if (verb === "set") return { code: 0, stdout: "", stderr: "" };
    }
    if (cmd === "/bin/launchctl") {
      t.log.push(`launchctl ${args[0]}`);
      if (args[0] === "bootout") Object.assign(t, { state: "Stopped" });
      if (args[0] === "bootstrap" || args[0] === "kickstart") {
        const old = readFileSync(stateFile, "utf8") === "old sign-in";
        Object.assign(t, old ? { state: "Running", url: "", node: OLD, tailnet: "example.ts.net", online: true } : { state: "NeedsLogin" });
      }
      return { code: 0, stdout: "", stderr: "" };
    }
    return undefined;
  });
  return t;
}

// A fake box around it, its steps in order.
function rotation(o: { pin?: string | null; vms?: number } = {}) {
  const sys = new FakeSys();
  const dir = mkdtempSync(join(tmpdir(), "taskbox-ts-"));
  const stateFile = join(dir, "tailscaled.state");
  const t = tailscaled(sys, stateFile);
  const pinFile = join(dir, "tailnet.json");
  if (o.pin !== null) writeFileSync(pinFile, JSON.stringify({ v: 1, tailnet: o.pin ?? "example.ts.net" }));
  const steps: string[] = [];
  let vms = o.vms ?? 1;
  const box: TsBox = {
    stateFile,
    drain: async () => (steps.push("drain"), undefined),
    vmsGone: async () => (steps.push(`vms ${vms}`), vms-- <= 0),
    resume: async () => void steps.push("resume"),
    lock: async () => (steps.push("lock"), undefined),
    unlock: async () => void steps.push("unlock"),
    restart: async () => (steps.push("restart"), sys.run("/bin/launchctl", ["kickstart", "-k", "system/x"]).then(() => undefined)),
    stop: async () => (steps.push("stop"), sys.run("/bin/launchctl", ["bootout", "system/x"]).then(() => undefined)),
    start: async () => (steps.push("start"), sys.run("/bin/launchctl", ["bootstrap", "system", "x.plist"]).then(() => undefined)),
  };
  const said: string[] = [];
  const events: string[] = [];
  const d: TsDeps & TsBox = { sys, tailscale: "/opt/taskbox/bin/tailscale", socket: "/s", tag: "tag:taskbox", hostname: "box-a", pinFile, rootUid: me, say: (l) => said.push(l), phase: (p) => steps.push(`phase ${p}`), event: (ty, text) => events.push(`${ty} ${text}`), ...box };
  const given: string[] = [];
  const give = (url: string) => {
    steps.push("give");
    // When the link is given, the copy of the old sign-in exists, and the box is locked.
    expect(existsSync(join(dir, BACKUP_FILE))).toBe(true);
    given.push(url);
    t.given = true;
  };
  return { sys, t, dir, stateFile, d, steps, said, events, give, given };
}

describe("key rotate tailscale", () => {
  test("VMs drained and gone, the socket locked and tailscaled restarted, its state copied aside, then up with SSH off; SSH on only on the pinned tailnet", async () => {
    const r = rotation({ vms: 2 });
    r.t.approve = "own";
    expect(await rotateTailscale(r.d, r.give)).toBe(0);
    expect(r.steps).toEqual(["phase drafting", "drain", "phase drafting", "vms 2", "vms 1", "vms 0", "lock", "restart", "give", "phase authorising", "phase reconnecting", "phase checking", "unlock", "resume"]);
    // The re-auth comes after the lock and the restart, with SSH off and shields up.
    const order = r.t.log.filter((l) => !l.startsWith("status"));
    expect(order[0]).toBe("launchctl kickstart");
    expect(order[1]).toBe(upArgs("tag:taskbox", "box-a").join(" "));
    expect(upArgs("tag:taskbox", "box-a")).toContain("--ssh=false");
    expect(upArgs("tag:taskbox", "box-a")).toContain("--shields-up");
    expect(order.at(-1)).toBe("set --ssh --shields-up=false");
    expect(r.given).toEqual([URL_]);
    expect(r.events.join("\n")).toMatch(/key.rotated .*new node key/);
    // The copy of the old sign-in is gone once it is done.
    expect(existsSync(join(r.dir, BACKUP_FILE))).toBe(false);
  });

  test("not approved within 10 minutes: the old sign-in is put back, and the box is on its tailnet with its old key", async () => {
    const r = rotation({ vms: 0 });
    expect(await rotateTailscale(r.d, r.give)).toBe(1);
    expect(r.steps).toContain("stop");
    expect(r.steps.indexOf("start")).toBeGreaterThan(r.steps.indexOf("stop"));
    expect(r.steps.slice(-2)).toEqual(["unlock", "resume"]);
    expect(readFileSync(r.stateFile, "utf8")).toBe("old sign-in");
    expect(r.t).toMatchObject({ state: "Running", node: OLD, tailnet: "example.ts.net" });
    expect(r.said.at(-1)).toBe("The box is back on its tailnet with its old key. Type taskbox key rotate tailscale again when you're ready.");
    expect(r.events.some((e) => e.startsWith("key.kept"))).toBe(true);
    // SSH was never turned on again under the re-auth.
    expect(r.t.log).not.toContain("set --ssh --shields-up=false");
  });

  test("approved into another tailnet: logged out of it at once, with SSH never on there, then the old sign-in back", async () => {
    const r = rotation({ vms: 0 });
    r.t.approve = "other";
    expect(await rotateTailscale(r.d, r.give)).toBe(1);
    const after = r.t.log.slice(r.t.log.findIndex((l) => l.startsWith("up ")));
    expect(after).toContain("logout");
    expect(after).not.toContain("set --ssh --shields-up=false");
    expect(r.events.some((e) => e.startsWith("key.refused"))).toBe(true);
    expect(r.t).toMatchObject({ state: "Running", node: OLD, tailnet: "example.ts.net" });
  });

  test("an old sign-in that can't be put back says an admin at the box is needed, never from away", async () => {
    const r = rotation({ vms: 0 });
    r.d.start = async () => "launchd refused it";
    expect(await rotateTailscale(r.d, r.give)).toBe(1);
    expect(r.said.at(-1)).toMatch(/off the tailnet and can't be reached from away\. An admin at the box is needed: there, as your admin user, type taskbox update/);
    expect(r.steps.slice(-2)).toEqual(["unlock", "resume"]);
  });

  test("a tailnet not pinned, or another one, refuses before anything changes", async () => {
    for (const [pin, want] of [[null, /isn't pinned/], ["other.example.ts.net", /pinned to other\.example\.ts\.net/]] as const) {
      const r = rotation({ pin });
      expect(await rotateTailscale(r.d, r.give)).toBe(1);
      expect(r.said.at(-1)).toMatch(want);
      expect(r.steps).toEqual(["phase drafting"]);
      expect(r.t.log.some((l) => l.startsWith("up "))).toBe(false);
    }
  });

  test("the install pins the tailnet it signed in to, once; a rotation never does", async () => {
    const r = rotation({ pin: null });
    expect(await pinTailnet(r.d)).toBe("example.ts.net");
    expect(readTailnetPin(r.d.pinFile, me)).toBe("example.ts.net");
    r.t.tailnet = "other.example.ts.net";
    expect(await pinTailnet(r.d)).toBe("example.ts.net");
  });
});

// The real box parts, on a fake Mac: the lock as the guard keeps it.
function realBox() {
  const p = paths(tempRoot(), testBox());
  const sys = new FakeSys();
  const entries = new Map<string, string[]>();
  sys.responders.push((cmd, args) => {
    if (cmd === "/bin/ls") return { code: 0, stdout: `x 1 root wheel 0 ${args[1]}\n${(entries.get(args[1]!) ?? []).map((e, i) => ` ${i}: ${e}\n`).join("")}`, stderr: "" };
    if (cmd === "/bin/chmod" && args[0] === "-N") return entries.set(args[1]!, []), { code: 0, stdout: "", stderr: "" };
    if (cmd === "/bin/chmod" && args[0] === "+a") return entries.set(args[2]!, [...(entries.get(args[2]!) ?? []), args[1]!]), { code: 0, stdout: "", stderr: "" };
    if (cmd === "/bin/launchctl") return { code: 0, stdout: "", stderr: "" };
    // Signed out after a re-auth nobody approved.
    if (cmd.endsWith("/tailscale") && args[1] === "status") return { code: 0, stdout: JSON.stringify({ BackendState: "NeedsLogin", Self: {} }), stderr: "" };
    return undefined;
  });
  const state = rootStateOf(p);
  mkdirSync(state.ops, { recursive: true });
  mkdirSync(p.tailscaleState, { recursive: true });
  return { p, sys, entries, state };
}

describe("tailscaled's socket during a rotation", () => {
  test("locked: the service account's entries come off the folder and the socket, and the guard keeps them off until it ends", async () => {
    const b = realBox();
    expect(await keepSocket(b.sys, b.p, newSocketMemory(), me)).toBeUndefined();
    closeSync(openSync(b.p.tailscaleSocket, "w"));
    expect(await keepSocket(b.sys, b.p, newSocketMemory(), me)).toBeUndefined();
    expect(b.entries.get(b.p.tailscaleSocketDir)).toEqual([DIR_ENTRY(b.p.service)]);
    expect(b.entries.get(b.p.tailscaleSocket)).toEqual([SOCKET_ENTRY(b.p.service)]);
    const box = tsBox({ sys: b.sys, p: b.p, state: b.state, rootUid: me, op: "op_01JD8Q4ZZZZZZZZZZZZZZZZZZZ", event: () => {}, log: () => {} });
    expect(await box.lock()).toBeUndefined();
    expect(b.entries.get(b.p.tailscaleSocketDir)).toEqual([]);
    expect(b.entries.get(b.p.tailscaleSocket)).toEqual([]);
    // The guard's pass while the lock is live puts nothing back, even after something moved.
    const locked = readLock(lockPath(b.state.dir), me, b.sys.now()) !== undefined;
    expect(locked).toBe(true);
    b.entries.set(b.p.tailscaleSocketDir, [DIR_ENTRY(b.p.service)]);
    expect(await keepSocket(b.sys, b.p, newSocketMemory(), me, locked)).toBeUndefined();
    expect(b.entries.get(b.p.tailscaleSocketDir)).toEqual([]);
    // tailscaled is restarted, so a connection made before the lock doesn't outlive it.
    expect(await box.restart()).toBeUndefined();
    expect(b.sys.calls.some((c) => c.cmd === "/bin/launchctl" && c.args.join(" ") === "kickstart -k system/local.taskbox.tailscaled")).toBe(true);
    await box.unlock();
    expect(existsSync(lockPath(b.state.dir))).toBe(false);
    expect(b.entries.get(b.p.tailscaleSocketDir)).toEqual([DIR_ENTRY(b.p.service)]);
    expect(b.entries.get(b.p.tailscaleSocket)).toEqual([SOCKET_ENTRY(b.p.service)]);
  });

  test("a rotation whose op ended while it held the lock is settled by the guard: the old sign-in back, the lock gone, the box resumed", async () => {
    const b = realBox();
    const stateFile = join(b.p.tailscaleState, "tailscaled.state");
    writeFileSync(stateFile, "re-auth");
    writeFileSync(join(b.p.tailscaleState, BACKUP_FILE), "old sign-in");
    const op = begin([], opType(ROTATE.tailscale), { subject: "box", params: { from: "controller" }, actor: "owner" }, b.sys.now());
    if (op.kind !== "start") throw new Error();
    writeOp({ dir: b.state.ops, owner: me }, { ...op.op, state: "cancelled", endedAt: b.sys.now() } as never);
    const box = tsBox({ sys: b.sys, p: b.p, state: b.state, rootUid: me, op: op.op.id, event: () => {}, log: () => {} });
    await box.lock();
    writeLink(linkPath(b.state.dir), op.op.id, sealPair().pub, URL_, { rootUid: me });
    const events: string[] = [];
    const said = await settleTsRotation({ sys: b.sys, p: b.p, state: b.state, rootUid: me, events: { write: (e) => void events.push(`${e.type} ${e.text}`) }, log: () => {} });
    expect(said).toMatch(/^settled the Tailscale rotation/);
    expect(readFileSync(stateFile, "utf8")).toBe("old sign-in");
    expect(existsSync(join(b.p.tailscaleState, BACKUP_FILE))).toBe(false);
    expect(existsSync(lockPath(b.state.dir))).toBe(false);
    expect(existsSync(linkPath(b.state.dir))).toBe(false);
    expect(events[0]).toMatch(/^key.kept .*put back the box's old sign-in/);
    // A live rotation is left alone.
    const live = begin([], opType(ROTATE.tailscale), { subject: "box", params: { from: "controller" }, actor: "owner" }, b.sys.now());
    if (live.kind !== "start") throw new Error();
    writeOp({ dir: b.state.ops, owner: me }, live.op);
    await tsBox({ sys: b.sys, p: b.p, state: b.state, rootUid: me, op: live.op.id, event: () => {}, log: () => {} }).lock();
    expect(await settleTsRotation({ sys: b.sys, p: b.p, state: b.state, rootUid: me, events: { write: () => {} }, log: () => {} })).toBeUndefined();
    expect(existsSync(lockPath(b.state.dir))).toBe(true);
  });
});

describe("from the controller", () => {
  test("the handler answers at once with the op and starts the child; the link comes back sealed through op show's file, and is nowhere plain", async () => {
    const b = realBox();
    const events = eventLog("guard", { dir: b.state.events, owner: me }, b.sys);
    const c = { sys: b.sys, state: b.state, rootUid: me, events, now: b.sys.now(), cfg: CFG, p: b.p, log: () => {} } as unknown as HandlerCtx;
    const k = sealPair();
    let child = "";
    const run = (async (_d: unknown, op: { id: string }) => ((child = op.id), { ...op, state: "running" })) as never;
    const a = await startTsRotation(c, k.pub, Verified.signer(`SHA256:${"A".repeat(43)}`).actor, { run });
    expect(a).toMatchObject({ ok: true, op: child });
    // Nothing ran tailscale in the handler's time.
    expect(b.sys.calls.some((x) => x.cmd.endsWith("/tailscale"))).toBe(false);
    const rec = readOp({ dir: b.state.ops, owner: me }, a.op!);
    expect(rec.kind === "ok" && rec.value.params.seal).toBe(k.pub);
    // The child's give: sealed to the controller's key, bound to the op.
    writeLink(linkPath(b.state.dir), a.op!, k.pub, URL_, { rootUid: me });
    const sealed = readLink(linkPath(b.state.dir), a.op!, me)!;
    expect(openSealed(k.priv, a.op!, sealed)).toBe(URL_);
    expect(openSealed(sealPair().priv, a.op!, sealed)).toBeUndefined();
    expect(readLink(linkPath(b.state.dir), "op_01JD8Q4ZZZZZZZZZZZZZZZZZZZ", me)).toBeUndefined();
    const files = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(d, e.name)) : [readFileSync(join(d, e.name), "utf8")]));
    expect(files(b.state.dir).join("\n")).not.toContain("login.tailscale.com");
  });
});

describe("tailscaled's own log", () => {
  test("a sign-in link in it is blanked in place, byte for byte", () => {
    const f = join(mkdtempSync(join(tmpdir(), "tslog-")), "log");
    const text = `2026/11/27 10:00:00 control: AuthURL is ${URL_}\nnext line\n`;
    writeFileSync(f, text);
    const fd = openSync(f, "r+");
    expect(blankLinks(fd, text, 0)).toBe(1);
    closeSync(fd);
    expect(readFileSync(f, "utf8")).toBe(text.replace("1a2b3c4d5e6f", "xxxxxxxxxxxx"));
  });
});
