// check --away's v3 rows (src/awaychecks.ts): the guard's beat and the broker's, lasting changes
// waiting at the box, the tailnet name, the power-loss history and the IP-KVM, each from fakes.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { brokerBeatRow, confirmRow, guardBeatRow, kvmRow, powerHistoryRow, powerLosses, tailnetRow } from "../src/awaychecks.ts";
import { type Config, paths } from "../src/config.ts";
import { rootStateOf } from "../src/core/paths.ts";
import { raise, updatePending } from "../src/core/pending.ts";
import { beatPaths, brokerPlist, guardwatchPlist, STALE_MS, writeBeat } from "../src/guardwatch.ts";
import { FakeSys } from "./fake.ts";
import { CFG, testBox } from "./helpers.ts";

const me = process.getuid!();

function box(o: { uid?: number; cfg?: Partial<Config> } = {}) {
  const root = mkdtempSync(join(tmpdir(), "away3-"));
  const p = paths(root, testBox());
  const sys = new FakeSys();
  mkdirSync(dirname(p.guardState), { recursive: true });
  mkdirSync(rootStateOf(p).dir, { recursive: true });
  const ts = { out: "" };
  sys.responders.push((cmd, args) => {
    if (cmd === p.tailscale && args[1] === "status") return { code: 0, stdout: ts.out, stderr: "" };
    if (cmd === "/usr/bin/id" && args[1] === "_taskboxgh") return { code: 0, stdout: `${me}\n`, stderr: "" };
    return undefined;
  });
  const c = { sys, cfg: { ...CFG, ...(o.cfg ?? {}) } as Config, paths: p, uid: o.uid ?? me, serviceUid: me, rootUid: me };
  const mono = () => sys.clock + sys.monoOffset;
  return { c, root, p, sys, ts, mono };
}

describe("the guard's beat and the broker's", () => {
  test("a fresh beat with guardwatch installed is OK; a stale one, none, or no guardwatch fail with who acts", async () => {
    const b = box();
    expect(await guardBeatRow(b.c)).toMatchObject({ status: "FAIL", detail: expect.stringMatching(/written no beat.*Waits by itself: guardwatch restarts it/) });
    writeBeat(beatPaths(b.root).guard, { boot: b.sys.bootUuid, mono: b.mono() - 5_000, pid: 9, at: b.sys.now() });
    expect(await guardBeatRow(b.c)).toMatchObject({ status: "FAIL", detail: expect.stringMatching(/guardwatch, which restarts a stuck guard, isn't installed/) });
    mkdirSync(dirname(guardwatchPlist(b.root)), { recursive: true });
    writeFileSync(guardwatchPlist(b.root), "<plist/>");
    expect(await guardBeatRow(b.c)).toEqual({ status: "OK", detail: "the guard beat 5 s ago, and guardwatch watches it" });
    writeBeat(beatPaths(b.root).guard, { boot: b.sys.bootUuid, mono: b.mono() - STALE_MS - 1_000, pid: 9, at: Date.parse("2026-11-23T14:02:00") });
    expect(await guardBeatRow(b.c)).toMatchObject({ status: "FAIL", detail: expect.stringMatching(/^the guard hasn't moved since 14:02\. Waits by itself/) });
  });

  test("the broker: SKIP until its LaunchDaemon is installed, then its own account's beat", async () => {
    const b = box();
    expect((await brokerBeatRow(b.c)).status).toBe("SKIP");
    mkdirSync(dirname(brokerPlist(b.root)), { recursive: true });
    writeFileSync(brokerPlist(b.root), "<plist/>");
    expect((await brokerBeatRow(b.c)).status).toBe("FAIL");
    mkdirSync(dirname(beatPaths(b.root).broker), { recursive: true });
    writeBeat(beatPaths(b.root).broker, { boot: b.sys.bootUuid, mono: b.mono() - 1_000, pid: 9, at: b.sys.now() });
    expect(await brokerBeatRow(b.c)).toEqual({ status: "OK", detail: "the key broker beat 1 s ago" });
  });
});

describe("lasting changes waiting for confirm", () => {
  test("none is OK; one live is a FAIL to do at the box; one past its 24 hours doesn't count", async () => {
    const b = box();
    expect((await confirmRow(b.c)).status).toBe("OK");
    const at = { wall: b.sys.now(), mono: b.mono(), boot: b.sys.bootUuid };
    await updatePending(rootStateOf(b.p).pending, { rootUid: me }, (s) => {
      const r = raise(s, { kind: "approver-add", subject: "approvers", shows: ["the key SHA256:abc"], actor: "owner (signed, key 3f9a)", payload: { k: 1 } }, at);
      if (!r.ok) throw new Error(r.why);
      return { state: r.state, out: undefined };
    });
    expect(await confirmRow(b.c)).toMatchObject({ status: "FAIL", detail: expect.stringMatching(/^1 lasting change waits for confirm.*At the box: as your admin user, type taskbox confirm$/) });
    b.sys.clock += 25 * 3_600_000;
    expect((await confirmRow(b.c)).status).toBe("OK");
  });
});

describe("the tailnet name and the KVM", () => {
  const status = (peers: Record<string, unknown> = {}) => JSON.stringify({ BackendState: "Running", Self: { DNSName: "taskbox-1.example-tailnet.ts.example." }, CurrentTailnet: { Name: "example-tailnet" }, Peer: peers });
  test("the box's name in its tailnet, for root and the service account only", async () => {
    const b = box();
    b.ts.out = status();
    expect(await tailnetRow(b.c)).toEqual({ status: "OK", detail: "the box is taskbox-1.example-tailnet.ts.example, in the tailnet example-tailnet" });
    expect((await tailnetRow(box({ uid: me + 1 }).c)).status).toBe("SKIP");
  });

  test("the KVM: online, with its tag; each way it isn't names what to do", async () => {
    const kvm = { restartPlan: "kvm", kvm: { tailnetName: "box-kvm", tag: "tag:kvm" } };
    expect((await kvmRow(box().c)).status).toBe("SKIP");
    expect(await kvmRow(box({ cfg: { away: { restartPlan: "kvm" } } as never }).c)).toMatchObject({ status: "FAIL", detail: expect.stringMatching(/no KVM is named/) });
    const b = box({ cfg: { away: kvm } as never });
    b.ts.out = status();
    expect((await kvmRow(b.c)).detail).toMatch(/isn't in the box's tailnet/);
    b.ts.out = status({ a: { HostName: "box-kvm", Online: true, Tags: [] } });
    expect((await kvmRow(b.c)).detail).toMatch(/doesn't carry tag:kvm/);
    b.ts.out = status({ a: { HostName: "box-kvm", Online: false, Tags: ["tag:kvm"] } });
    expect((await kvmRow(b.c)).detail).toMatch(/is offline/);
    b.ts.out = status({ a: { HostName: "box-kvm", Online: true, Tags: ["tag:kvm"] } });
    expect((await kvmRow(b.c)).status).toBe("OK");
  });
});

describe("the power-loss history", () => {
  const now = Date.parse("2026-11-26T12:00:00Z");
  const log = [
    "2026-11-20 03:12:44 +0000 Shutdown Cause        \tShutdown Cause: 0",
    "2026-11-21 09:00:00 +0000 Shutdown Cause        \tShutdown Cause: 5",
    "2026-11-22 10:00:00 +0100 Shutdown Cause        \tShutdown Cause: -128",
    "2026-09-01 10:00:00 +0000 Shutdown Cause        \tShutdown Cause: 0",
    "2026-11-24 10:00:00 +0000 Sleep  \tEntering Sleep state",
  ].join("\n");
  test("the last 30 days' unexpected shutdowns, never one asked for", () => {
    expect(powerLosses(log, now)).toEqual([Date.parse("2026-11-20T03:12:44Z"), Date.parse("2026-11-22T09:00:00Z")]);
  });
  test("a WARN, never a FAIL; an unreadable log is SKIP", async () => {
    const b = box();
    b.sys.clock = now;
    let out = { code: 0, stdout: log, stderr: "" };
    b.sys.responders.unshift((cmd, args) => (cmd === "/usr/bin/pmset" && args[1] === "log" ? out : undefined));
    expect(await powerHistoryRow(b.c)).toMatchObject({ status: "WARN", detail: expect.stringMatching(/^2 unexpected shutdowns in the last 30 days/) });
    out = { code: 0, stdout: "", stderr: "" };
    expect((await powerHistoryRow(b.c)).status).toBe("OK");
    out = { code: 1, stdout: "", stderr: "" };
    expect((await powerHistoryRow(b.c)).status).toBe("SKIP");
  });
});

describe("source failures counted", () => {
  test("each failed read once, however many slots ask; a read that sees the queue starts again; 3 in a row fail", async () => {
    const { noteSeen } = await import("../src/load.ts");
    const { sourceRow } = await import("../src/awaychecks.ts");
    const b = box({ cfg: { sources: { github: { type: "github-actions" } } } as never });
    mkdirSync(b.p.projectState, { recursive: true });
    const down = (at: number) => noteSeen(b.p, { known: false, at, why: "GitHub answered 502" }, b.sys.now());
    const c = { ...b.c, cfg: { ...b.c.cfg, jobsFrom: "example-org/app", actionsAppId: 4242 } as Config };
    down(1);
    down(1);
    down(2);
    expect(await sourceRow(c)).toMatchObject({ status: "OK", detail: expect.stringMatching(/last read failed \(GitHub answered 502\)/) });
    down(3);
    expect(await sourceRow(c)).toMatchObject({ status: "FAIL", detail: expect.stringMatching(/^the job source couldn't be read 3 times in a row \(GitHub answered 502\).*Waits by itself/) });
    noteSeen(b.p, { known: true, at: 4, items: [] }, b.sys.now());
    expect(await sourceRow(c)).toEqual({ status: "OK", detail: "the job source's last read saw the queue" });
  });
});
