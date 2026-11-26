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
import { rootPaths, STALE_MS, writeBeat } from "../src/guardwatch.ts";
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
  test("each reason has its own words and who acts", async () => {
    const b = box();
    const w = rootPaths(b.root);
    expect(await guardBeatRow(b.c)).toMatchObject({ status: "FAIL", detail: expect.stringMatching(/^the guard: it has written no beat, so nothing shows it moves\. Waits by itself: guardwatch restarts a process that doesn't beat/) });
    writeBeat(w.guardBeat, { boot: b.sys.bootUuid, mono: b.mono() - 5_000, pid: 9, at: b.sys.now() }, me);
    expect(await guardBeatRow(b.c)).toMatchObject({ status: "FAIL", detail: expect.stringMatching(/guardwatch, which restarts it when stuck, isn't installed/) });
    mkdirSync(dirname(w.plist), { recursive: true });
    writeFileSync(w.plist, "<plist/>");
    expect(await guardBeatRow(b.c)).toEqual({ status: "OK", detail: "the guard beat 5 s ago" });
    writeBeat(w.guardBeat, { boot: b.sys.bootUuid, mono: b.mono() - STALE_MS - 1_000, pid: 9, at: Date.parse("2031-03-04T14:02:00") }, me);
    expect(await guardBeatRow(b.c)).toMatchObject({ status: "FAIL", detail: expect.stringMatching(/^the guard hasn't moved since 14:02\. Waits by itself/) });
    writeFileSync(w.record, JSON.stringify({ boot: b.sys.bootUuid, seen: {}, restarts: {}, gaveUp: { "local.taskbox.guard": true } }));
    expect(await guardBeatRow(b.c)).toMatchObject({ status: "FAIL", detail: expect.stringMatching(/guardwatch has restarted it 3 times this hour, so it has stopped\. At the box: as your admin user, type taskbox update$/) });
  });

  test("the broker: SKIP until its LaunchDaemon is installed, then its own account's beat", async () => {
    const b = box();
    const w = rootPaths(b.root);
    expect((await brokerBeatRow(b.c)).status).toBe("SKIP");
    mkdirSync(dirname(w.brokerPlist), { recursive: true });
    writeFileSync(w.brokerPlist, "<plist/>");
    expect((await brokerBeatRow(b.c)).status).toBe("FAIL");
    mkdirSync(dirname(w.brokerBeat), { recursive: true });
    writeBeat(w.brokerBeat, { boot: b.sys.bootUuid, mono: b.mono() - 1_000, pid: 9, at: b.sys.now() }, me);
    expect(await brokerBeatRow(b.c)).toEqual({ status: "OK", detail: "the key broker beat 1 s ago" });
    b.sys.responders.unshift((cmd, args) => (cmd === "/usr/bin/id" && args[1] === "_taskboxgh" ? { code: 1, stdout: "", stderr: "no such user" } : undefined));
    expect(await brokerBeatRow(b.c)).toMatchObject({ status: "FAIL", detail: expect.stringMatching(/the key broker's account isn't on the box/) });
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
  test("the box's name in its tailnet, the one its settings give it, for root and the service account only", async () => {
    const b = box();
    b.ts.out = status();
    expect(await tailnetRow(b.c)).toEqual({ status: "OK", detail: "the box is taskbox-1.example-tailnet.ts.example, in the tailnet example-tailnet" });
    b.ts.out = status().replace("taskbox-1.", "mac-mini.");
    expect(await tailnetRow(b.c)).toMatchObject({ status: "FAIL", detail: expect.stringMatching(/^the box is mac-mini in its tailnet, but its settings name it taskbox-1/) });
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
  const now = Date.parse("2031-03-26T12:00:00Z");
  const log = [
    "2031-03-20 03:12:44 +0000 Shutdown Cause        \tShutdown Cause: 0",
    "2031-03-21 09:00:00 +0000 Shutdown Cause        \tShutdown Cause: 5",
    "2031-03-22 10:00:00 +0100 Shutdown Cause        \tShutdown Cause: -128",
    "2031-01-01 10:00:00 +0000 Shutdown Cause        \tShutdown Cause: 0",
    "2031-03-24 10:00:00 +0000 Sleep  \tEntering Sleep state",
  ].join("\n");
  test("the last 30 days' unexpected shutdowns, never one asked for", () => {
    expect(powerLosses(log, now)).toEqual([Date.parse("2031-03-20T03:12:44Z"), Date.parse("2031-03-22T09:00:00Z")]);
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
  test("each failed read once, however many slots ask; at sourceFailures in a row the row fails, status says so, and one event; a good read clears it", async () => {
    const { sourceStep, sourceWords } = await import("../src/sourcefail.ts");
    const { sourceRow } = await import("../src/awaychecks.ts");
    const { writeLoopState } = await import("../src/loop.ts");
    const { readLoop } = await import("../src/watch.ts");
    const b = box();
    mkdirSync(b.p.projectState, { recursive: true });
    const c = { ...b.c, cfg: { ...b.c.cfg, jobsFrom: "example-org/app", actionsAppId: 4242 } as Config };
    let events = 0;
    const read = (snap: Parameters<typeof sourceStep>[1]) => {
      const s = sourceStep(readLoop(b.p.loopState), snap, 3);
      if (!s) return;
      writeLoopState(b.p, { ...s.patch });
      if (s.failing) events++;
    };
    const down = (at: number) => read({ known: false, at, why: "GitHub answered 502" });
    down(1);
    down(1);
    down(2);
    expect(await sourceRow(c)).toMatchObject({ status: "OK", detail: expect.stringMatching(/last read failed \(GitHub answered 502\)/) });
    expect(sourceWords(readLoop(b.p.loopState))).toBeUndefined();
    down(Date.parse("2031-03-04T14:02:00"));
    down(Date.parse("2031-03-04T14:03:00"));
    expect(await sourceRow(c)).toMatchObject({ status: "FAIL", detail: expect.stringMatching(/^the job source couldn't be read 4 times in a row \(GitHub answered 502\).*Waits by itself/) });
    expect(sourceWords(readLoop(b.p.loopState))).toBe("choosing without the job source since 14:02 (GitHub answered 502)");
    expect(events).toBe(1);
    read({ known: true, at: 9, items: [] });
    expect(await sourceRow(c)).toEqual({ status: "OK", detail: "the job source's last read saw the queue" });
    expect(sourceWords(readLoop(b.p.loopState))).toBeUndefined();
  });

  test("status adds the line to the box's state", async () => {
    const { computeState } = await import("../src/state.ts");
    const s = computeState({ now: 0, loop: { slot: "waiting", waitingFor: "a job" }, sourceLine: "choosing without the job source since 14:02 (x)" });
    expect(s.detail).toBe("a job; choosing without the job source since 14:02 (x)");
  });
});

describe("source failures classed", () => {
  test("each failed read is classed as the runner chain is; a time limit or the network otherwise", async () => {
    const { failureOf } = await import("../src/source.ts");
    const { QueueError } = await import("../src/queue.ts");
    const { classify } = await import("../src/ghfail.ts");
    const res = (status: number, headers: Record<string, string> = {}) => new Response("{}", { status, headers });
    const q = (status: number, headers?: Record<string, string>) => new QueueError("x", status, classify(res(status, headers), 0, "the queue"));
    expect(failureOf(q(401))).toEqual({ kind: "key" });
    expect(failureOf(q(404))).toEqual({ kind: "gone" });
    expect(failureOf(q(502))).toEqual({ kind: "server" });
    expect(failureOf(q(403))).toEqual({ kind: "refused" });
    expect(failureOf(q(429, { "retry-after": "600" }))).toEqual({ kind: "rate", waitMs: 600_000 });
    expect(failureOf(new DOMException("t", "TimeoutError"))).toEqual({ kind: "timeout" });
    expect(failureOf(new TypeError("fetch failed"))).toEqual({ kind: "network" });
  });

  test("a rate limit waits for GitHub's reset before the source is read again", async () => {
    const { GitHubActionsSource } = await import("../src/source.ts");
    const { QueueError } = await import("../src/queue.ts");
    const { classify } = await import("../src/ghfail.ts");
    let reads = 0;
    let limited = true;
    const src = new GitHubActionsSource(
      {
        items: async () => {
          reads++;
          if (limited) throw new QueueError("x", 429, classify(new Response("{}", { status: 429, headers: { "retry-after": "600" } }), 0, "the queue"));
          return [];
        },
      },
      30_000,
    );
    const first = await src.read(0);
    expect(first).toMatchObject({ known: false, kind: "rate", waitMs: 600_000 });
    limited = false;
    for (const t of [60_000, 300_000, 599_000]) await src.read(t);
    expect(reads).toBe(1);
    expect((await src.read(600_000)).known).toBe(true);
    expect(reads).toBe(2);
  });

  test("who acts, by class", async () => {
    const { sourceNext } = await import("../src/sourcefail.ts");
    expect(sourceNext({ sourceKind: "rate", sourceRetryAt: Date.parse("2031-03-04T14:30:00") })).toBe("Waits by itself: GitHub's rate limit lets it read again at 14:30");
    expect(sourceNext({ sourceKind: "key" })).toMatch(/^From away: type taskbox connect status/);
    expect(sourceNext({ sourceKind: "network" })).toMatch(/^Waits by itself: the loop reads it again each minute/);
  });
});
