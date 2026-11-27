// The v3 load test: the owner's signed session on the box, its local stop, the test VMs it
// stops at its end, the controller's dispatch and cancel through a fake owner GitHub session, the
// merge pattern's workflow and the test repo's set-up, and a day session as a saved day for the
// simulator.
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Config, loadConfig, paths } from "../src/config.ts";
import { writeConfig } from "../src/controller/home.ts";
import { cancelSession, CHECK, repoChanges, RULESET } from "../src/controller/load.ts";
import { rootStateOf } from "../src/core/paths.ts";
import type { HandlerCtx } from "../src/core/dispatch.ts";
import { applyStart, applyStop, startProblem } from "../src/handlers/load.ts";
import type { Gh } from "../src/hold.ts";
import type { JobRecord } from "../src/jobs.ts";
import { currentSession, loadNow, readLoad, rootLoadFile } from "../src/load.ts";
import { checkLoadValues, loadValues, loadWorkflowYaml, loadYamlFrom } from "../src/loadcmd.ts";
import { loadReport, replayDay } from "../src/loadreport.ts";
import { LOAD_ENDED, stopFor } from "../src/loop.ts";
import { listOps } from "../src/core/ops.ts";
import { reconcileLoadOps } from "../src/loadop.ts";
import { ADDRESS, controllerConfig, deps, INSTALL_ID, pairing, runLine, StandIn, World } from "./controller-fake.ts";
import { FakeSys } from "./fake.ts";
import { CFG, tempRoot, testBox } from "./helpers.ts";
import { LABELS, replayFromJobs } from "./sim.ts";

const M = 60_000;
const NOW = Date.parse("2026-11-18T10:00:00Z");
const ME = process.getuid!();
const TEST = { name: "example-org/load", role: "load" as const, runnerGroup: "taskbox-load" };
const LINUX = { label: "taskbox-linux", image: "ghcr.io/cirruslabs/ubuntu-runner-arm64@sha256:" + "1".repeat(64), vmCpus: 4, vmMemoryMB: 8192 };
const LOADCFG: Config = { ...CFG, vmsAtOnce: 2, linux: LINUX, sources: [{ type: "github-actions", appId: 4242, repos: [CFG.jobsFrom, TEST] }] };

// The guard's context for a signed handler, on a fake box whose root is the tester.
function ctx(cfg: Config = LOADCFG, at = NOW) {
  const p = paths(tempRoot(), testBox());
  mkdirSync(p.shared, { recursive: true });
  const events: { type: string; text: string; actor: string }[] = [];
  const c = { sys: new FakeSys(), cfg, p, state: rootStateOf(p), rootUid: ME, events: { write: (e: { type: string; text: string; actor: string }) => (events.push(e), e) }, log: () => {}, now: at } as unknown as HandlerCtx;
  return { c, p, events };
}
const OWNER = "owner (signed, key SHA256:" + "a".repeat(43) + ")";

describe("the owner's signed session", () => {
  test("load start signs --pattern, and --for and --only when given, and nothing else", () => {
    expect(startProblem({ pattern: "burst" })).toBeUndefined();
    expect(startProblem({ pattern: "merge", for: "2h", only: true })).toBeUndefined();
    expect(startProblem({})).toContain("--pattern burst, day, merge");
    expect(startProblem({ pattern: "push" })).toContain("--pattern");
    expect(startProblem({ pattern: "day", for: "5m" })).toContain("at least 10m");
    expect(startProblem({ pattern: "day", for: "5h" })).toContain("at most 4h");
    expect(startProblem({ pattern: "day", only: "yes" })).toBe("--only takes no value");
    expect(startProblem({ pattern: "day", words: ["x"] })).toContain("only");
  });

  test("opens a numbered session in root's file, with its pattern and who signed it; a second is busy; stop ends it", async () => {
    const { c, p, events } = ctx();
    const a = await applyStart(c, { pattern: "day", for: "2h" }, OWNER);
    expect(a).toMatchObject({ ok: true, said: expect.stringMatching(/^Load test session 1 \(day\) is on until 12:00 UTC, beside the real repo, never taking its last slot\. Its op is op_\w+: taskbox op show op_\w+ -w follows it\.$/), op: expect.stringMatching(/^op_/) });
    const s = currentSession(readLoad(p, false, ME), NOW + M)!;
    expect(s).toMatchObject({ n: 1, pattern: "day", only: false, by: OWNER, until: NOW + 120 * M });
    // Root's file, 0644: the loop and every user read it, and only the guard writes it.
    expect(JSON.parse(readFileSync(rootLoadFile(p), "utf8")).sessions[0]).toMatchObject({ n: 1, pattern: "day" });
    expect(await applyStart({ ...c, now: NOW + M }, { pattern: "burst" }, OWNER)).toMatchObject({ ok: false, code: "busy" });
    expect(await applyStop({ ...c, now: NOW + 5 * M }, OWNER)).toEqual({ ok: true, said: "Load test session 1 is off. Its running test VMs stop now, and no new one starts." });
    expect(loadNow(p, NOW + 6 * M, ME)).toBeUndefined();
    expect(readLoad(p, false, ME).sessions[0]).toMatchObject({ endedAt: NOW + 5 * M, stoppedBy: OWNER });
    expect(await applyStop({ ...c, now: NOW + 7 * M }, OWNER)).toEqual({ ok: true, said: "No load test session is on." });
    // The next one is numbered on.
    expect((await applyStart({ ...c, now: NOW + 8 * M }, { pattern: "merge", only: true }, OWNER)).said).toContain("session 2 (merge)");
    expect(events.map((e) => e.type)).toEqual(["load.started", "op.started", "load.stopped", "op.cancelled", "load.started", "op.started"]);
  });

  test("refuses with no test repo, and beside the real repo with one VM at a time", async () => {
    expect(await applyStart(ctx(CFG).c, { pattern: "burst" }, OWNER)).toMatchObject({ ok: false, said: expect.stringContaining("name no test repo") });
    const one = ctx({ ...LOADCFG, vmsAtOnce: 1 });
    expect(await applyStart(one.c, { pattern: "burst" }, OWNER)).toMatchObject({ ok: false, said: expect.stringContaining("Add --only") });
    expect(await applyStart(one.c, { pattern: "burst", only: true }, OWNER)).toMatchObject({ ok: true });
  });

  test("a v2 session the service account opened still reads, numbers on, and a stop at the box wins over root's file", async () => {
    const { c, p } = ctx();
    mkdirSync(p.projectState, { recursive: true });
    const v2 = { v: 1, sessions: [{ n: 4, startedAt: NOW - 600 * M, until: NOW - 500 * M, only: false, checklist: ["Power"] }] };
    writeFileSync(join(p.projectState, "load.json"), JSON.stringify(v2));
    writeFileSync(join(p.shared, "load.json"), JSON.stringify(v2));
    expect((await applyStart(c, { pattern: "burst" }, OWNER)).said).toContain("session 5");
    const { loadOff } = await import("../src/load.ts");
    expect(loadOff(p, NOW + M, ME)?.n).toBe(5);
    expect(readLoad(p, false, ME).sessions.map((s) => [s.n, s.endedAt ?? null, s.stoppedBy ?? null])).toEqual([
      [4, null, null],
      [5, NOW + M, "the service account, at the box"],
    ]);
  });

  test("a root file that isn't root's, or isn't the sessions, is no session", async () => {
    const { c, p } = ctx();
    await applyStart(c, { pattern: "burst" }, OWNER);
    expect(loadNow(p, NOW + M, ME)).toEqual({ on: true, only: false });
    // Read as another owner: refused, so no load.
    expect(loadNow(p, NOW + M, ME + 1)).toBeUndefined();
    writeFileSync(rootLoadFile(p), JSON.stringify({ v: 2, sessions: [] }), { mode: 0o644 });
    expect(loadNow(p, NOW + M, ME)).toBeUndefined();
  });
});

describe("a session is an op", () => {
  const ops = (c: HandlerCtx) => listOps({ dir: c.state.ops, owner: ME }).ops;
  test("load start begins it with the session's number and end; load stop cancels it as its named opposite", async () => {
    const { c } = ctx();
    const a = await applyStart(c, { pattern: "burst", for: "1h" }, OWNER);
    const op = ops(c)[0]!;
    expect(op).toMatchObject({ id: a.op, type: "load", subject: "load", state: "running", phase: "running", params: { session: 1, pattern: "burst", only: false }, deadline: NOW + 60 * M, actor: OWNER });
    await applyStop({ ...c, now: NOW + 5 * M }, OWNER);
    expect(ops(c)[0]).toMatchObject({ state: "cancelled", why: `ended by taskbox load stop (${OWNER})` });
  });
  test("op cancel ends the session as load stop does, from the controller or the service account", async () => {
    const { cancelOp } = await import("../src/opcancel.ts");
    for (const role of ["owner", "service"] as const) {
      const { c, p } = ctx();
      const a = await applyStart(c, { pattern: "day" }, OWNER);
      const r = await cancelOp({ ...c, now: NOW + M }, a.op!, role, role === "owner" ? OWNER : "service");
      expect(r).toMatchObject({ ok: true, said: expect.stringContaining("Load test session 1 is off") });
      expect(loadNow(p, NOW + 2 * M, ME)).toBeUndefined();
      expect(ops(c)[0]!.state).toBe("cancelled");
    }
    // An admin doesn't start one, so doesn't cancel one.
    const { c } = ctx();
    const a = await applyStart(c, { pattern: "day" }, OWNER);
    expect(await cancelOp(c, a.op!, "admin", "an admin")).toMatchObject({ ok: false, code: "denied" });
  });
  test("the guard's pass ends it when the session ends another way: its --for, a stop at the box, the box", async () => {
    const run = (c: HandlerCtx, now: number) => reconcileLoadOps(c, now);
    const t = ctx();
    await applyStart(t.c, { pattern: "burst", for: "10m" }, OWNER);
    expect(run(t.c, NOW + 5 * M)).toEqual([]);
    expect(run(t.c, NOW + 11 * M)).toHaveLength(1);
    expect(ops(t.c)[0]).toMatchObject({ state: "succeeded", why: "its --for ran out" });
    const s = ctx();
    await applyStart(s.c, { pattern: "burst" }, OWNER);
    const { loadOff, loadFailed } = await import("../src/load.ts");
    // The service's copies are what root reads.
    loadOff(s.p, NOW + M, ME);
    run(s.c, NOW + 2 * M);
    expect(ops(s.c)[0]).toMatchObject({ state: "cancelled", why: "ended by taskbox load stop (the service account, at the box)" });
    const f = ctx();
    await applyStart(f.c, { pattern: "burst" }, OWNER);
    loadFailed(f.p, NOW + M, "no runner group named taskbox-load", ME);
    run(f.c, NOW + 2 * M);
    expect(ops(f.c)[0]).toMatchObject({ state: "failed", why: "the box ended it: no runner group named taskbox-load" });
  });
  test("the pass is in the guard's list, and the type is declared once", async () => {
    const { passMakers } = await import("../src/passes/index.ts");
    expect(passMakers().map((m) => m.name)).toContain("load");
    const { declOf } = await import("../src/optypes/index.ts");
    expect(declOf("load")).toMatchObject({ who: ["owner", "service"], wayBack: "taskbox load stop ends it." });
  });
});

describe("test VMs at the session's end", () => {
  test("a running test job's VM stops once its session ends; a real job's never does, and a forced stop still wins", () => {
    expect(stopFor(undefined, "load", () => false)).toBe(LOAD_ENDED);
    expect(stopFor(undefined, "load", () => true)).toBeUndefined();
    expect(stopFor(undefined, "jobs", () => false)).toBeUndefined();
    expect(stopFor(undefined, undefined, () => false)).toBeUndefined();
    expect(stopFor("a forced stop", "load", () => true)).toBe("a forced stop");
  });
});

describe("the load workflow", () => {
  const y = loadWorkflowYaml(LOADCFG);
  test("the merge pattern opens throwaway pull requests on a hosted runner with the repo's own token, and the box takes the merge queue's jobs", () => {
    expect(y).toContain("options: [burst, day, merge]");
    expect(y).toContain("  merge_group:");
    expect(y).toMatch(/open-prs:\n\s+if: github.event_name == 'workflow_dispatch' && inputs.pattern == 'merge'\n\s+runs-on: ubuntu-latest/);
    expect(y).toContain("GH_TOKEN: ${{ github.token }}");
    expect(y).toContain("enqueuePullRequest");
    expect(y).toContain(`context=${CHECK}`);
    // The required check's job, on this box's own label.
    expect(y).toMatch(/\n {2}taskbox-load:\n\s+if: github.event_name == 'merge_group'\n\s+needs: \[merge-jobs\]\n\s+runs-on: \[taskbox-1-linux\]/);
    // Only the hosted job holds a token; the box's jobs get none.
    expect(y.match(/github\.token/g)).toHaveLength(1);
    expect(y).toContain("permissions: {}");
  });
  test("no input or variable reaches a run step through ${{ }}: the session goes through env and is checked as a number", () => {
    const runs = [...y.matchAll(/^(\s*)(?:- )?run: \|?\n?([\s\S]*?)(?=^\1(?:- |\S)|^\s{0,4}\S|$(?![\s\S]))/gm)].map((m) => m[0]);
    for (const r of runs) expect(r).not.toContain("${{");
    expect(y).toContain("SESSION: ${{ inputs.session }}");
    expect(y).toContain(`case "$SESSION" in ''|*[!0-9]*)`);
  });
  test("the controller takes values only, checked strictly, and makes the same YAML", () => {
    const v = loadValues(LOADCFG);
    expect(v).toEqual({ v: 2, macos: "taskbox-1-macos", linux: "taskbox-1-linux", merge: "taskbox-1-linux", prs: 6 });
    expect(checkLoadValues(JSON.parse(JSON.stringify(v)))).toEqual(v);
    expect(loadYamlFrom(checkLoadValues(v) as typeof v)).toBe(y);
    for (const bad of [null, [], { ...v, extra: 1 }, { ...v, v: 1 }, { ...v, macos: "a b" }, { ...v, merge: "x]\n  evil: 1" }, { ...v, prs: 99 }]) expect(typeof checkLoadValues(bad)).toBe("string");
  });
});

// A fake of the owner's gh: answers by route, and records every call.
function fakeGh(o: { workflow?: string; perms?: boolean; rulesets?: string[]; runs?: unknown[]; prs?: unknown[] } = {}) {
  const calls: { args: string[]; body?: unknown }[] = [];
  const gh: Gh = async (args, stdin) => {
    calls.push({ args, ...(stdin ? { body: JSON.parse(stdin) } : {}) });
    const a = args.filter((x) => x !== "api" && x !== "--input" && x !== "-");
    const method = a[0] === "-X" ? a[1] : "GET";
    const path = a[0] === "-X" ? a[2]! : a[0]!;
    const out = (v: unknown) => ({ code: 0, stdout: JSON.stringify(v), stderr: "" });
    if (method === "GET" && path === `repos/${TEST.name}`) return out({ default_branch: "main" });
    if (method === "GET" && path.startsWith(`repos/${TEST.name}/contents/`)) return o.workflow === undefined ? { code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" } : out({ content: Buffer.from(o.workflow).toString("base64"), sha: "abc" });
    if (method === "GET" && path.endsWith("/actions/permissions/workflow")) return out({ default_workflow_permissions: "read", can_approve_pull_request_reviews: o.perms ?? false });
    if (method === "GET" && path.includes("/rulesets")) return out((o.rulesets ?? []).map((name) => ({ name })));
    if (method === "GET" && path.includes("/actions/workflows/load.yml/runs")) return out({ workflow_runs: o.runs ?? [] });
    if (method === "GET" && path.includes("/pulls?")) return out(o.prs ?? []);
    return out({});
  };
  return { gh, calls };
}

describe("the test repo, through the owner's GitHub session", () => {
  const v = loadValues(LOADCFG);
  test("load start writes the workflow when it differs; nothing when it matches", async () => {
    const f = fakeGh();
    const c = await repoChanges(f.gh, TEST.name, "main", v, false);
    if (!Array.isArray(c)) throw new Error(c.stop);
    expect(c.map((x) => x.what)).toEqual([`write .github/workflows/load.yml in ${TEST.name}, made from this box's settings`]);
    expect(await c[0]!.apply()).toBeUndefined();
    const put = f.calls.at(-1)!;
    expect(put.args).toContain(`repos/${TEST.name}/contents/.github/workflows/load.yml`);
    expect(Buffer.from((put.body as { content: string }).content, "base64").toString()).toBe(loadYamlFrom(v));
    expect(await repoChanges(fakeGh({ workflow: loadYamlFrom(v) }).gh, TEST.name, "main", v, false)).toEqual([]);
  });
  test("the merge pattern lets the repo's own token open pull requests, and turns on a merge queue that asks for taskbox-load, once", async () => {
    const f = fakeGh({ workflow: loadYamlFrom(v) });
    const c = await repoChanges(f.gh, TEST.name, "main", v, true);
    if (!Array.isArray(c)) throw new Error(c.stop);
    expect(c).toHaveLength(2);
    for (const x of c) expect(await x.apply()).toBeUndefined();
    const perm = f.calls.find((x) => x.args.includes("PUT") && x.args.some((a) => a.endsWith("/actions/permissions/workflow")))!;
    expect(perm.body).toEqual({ default_workflow_permissions: "read", can_approve_pull_request_reviews: true });
    const rs = f.calls.find((x) => x.args.includes("POST") && x.args.some((a) => a.endsWith("/rulesets")))!.body as { name: string; rules: { type: string; parameters: Record<string, unknown> }[]; bypass_actors: unknown[] };
    expect(rs.name).toBe(RULESET);
    expect(rs.rules.map((r) => r.type)).toEqual(["merge_queue", "required_status_checks"]);
    expect(rs.rules[1]!.parameters.required_status_checks).toEqual([{ context: CHECK }]);
    expect(rs.bypass_actors).toHaveLength(1);
    expect(await repoChanges(fakeGh({ workflow: loadYamlFrom(v), perms: true, rulesets: [RULESET] }).gh, TEST.name, "main", v, true)).toEqual([]);
  });
  test("cancel takes the session's own runs and the merge queue's, waiting or running, and closes its throwaway pull requests", async () => {
    const runs = [
      { id: 11, status: "queued", event: "workflow_dispatch", display_title: "taskbox load burst session 3 abc" },
      { id: 12, status: "in_progress", event: "merge_group", display_title: "taskbox load merge queue session none abc" },
      { id: 13, status: "completed", event: "workflow_dispatch", display_title: "taskbox load burst session 3 abc" },
      { id: 14, status: "queued", event: "workflow_dispatch", display_title: "taskbox load burst session 31 abc" },
      { id: 15, status: "queued", event: "push", display_title: "someone's own run" },
    ];
    const prs = [{ number: 7, head: { ref: "taskbox-load/s3-99-1" } }, { number: 8, head: { ref: "taskbox-load/s31-99-1" } }, { number: 9, head: { ref: "feature" } }];
    const f = fakeGh({ runs, prs });
    const r = await cancelSession(f.gh, TEST.name, { n: 3, pattern: "merge", startedAt: NOW, until: NOW + 60 * M, endedAt: null });
    expect(r).toEqual({ runs: 2, prs: 1, failed: [] });
    const writes = f.calls.filter((c) => c.args.includes("-X")).map((c) => c.args.slice(c.args.indexOf("-X") + 1, c.args.indexOf("-X") + 3).join(" "));
    expect(writes).toEqual([`POST repos/${TEST.name}/actions/runs/11/cancel`, `POST repos/${TEST.name}/actions/runs/12/cancel`, `PATCH repos/${TEST.name}/pulls/7`, `DELETE repos/${TEST.name}/git/refs/heads/taskbox-load/s3-99-1`]);
  });
});

// A controller paired with a box that runs the box's own code, with a test repo in its settings. The
// box's guard is played here: a signed load start or stop the controller sends is applied by the
// handler itself, as the guard would once the signature checked.
function paired() {
  const w = new World();
  const box = new StandIn(INSTALL_ID);
  box.rootUid = ME;
  const p = paths(box.root, testBox());
  const app = JSON.parse(readFileSync(join(p.app, "taskbox.json"), "utf8"));
  writeFileSync(join(p.app, "taskbox.json"), JSON.stringify({ ...app, sources: [{ type: "github-actions", appId: 4242, repos: [app.jobsFrom, TEST] }] }));
  mkdirSync(p.shared, { recursive: true });
  const answer = box.answer.bind(box);
  const signed: string[] = [];
  box.answer = async (line: string) => {
    const m = /^load (start|stop)\b/.exec(line);
    if (m) {
      signed.push(line);
      const cfg = loadConfig(p.app, p.boxSettings);
      const c = { sys: box.sys, cfg, p, state: rootStateOf(p), rootUid: ME, events: { write: (e: unknown) => e }, log: () => {}, now: box.sys.now() } as unknown as HandlerCtx;
      const words = line.split(" ");
      const opt = (k: string) => (words.includes(k) ? words[words.indexOf(k) + 1] : undefined);
      if (m[1] === "start") await applyStart(c, { pattern: opt("--pattern")!, ...(opt("--for") ? { for: opt("--for")! } : {}), ...(words.includes("--only") ? { only: true } : {}) }, OWNER);
      else await applyStop(c, OWNER);
      return answer("load status --json --answers 4");
    }
    return answer(line);
  };
  w.standIns[ADDRESS] = box;
  const d = deps(w, ["yes"]);
  writeConfig(d.home, controllerConfig([pairing()]));
  box.sys.clock = NOW;
  d.now = () => box.sys.now();
  return { w, box, d, p, signed };
}

describe("taskbox load start and stop on the controller", () => {
  test("start writes the workflow, opens the signed session, then dispatches the pattern for it through the owner's session", async () => {
    const t = paired();
    const f = fakeGh();
    Object.assign(t.d, { gh: f.gh, tty: true });
    const r = await runLine(t.d, ["load", "start", "--pattern", "burst", "--for", "1h", "--detach"]);
    expect(r.code).toBe(0);
    expect(t.signed).toEqual(["load start --pattern burst --for 1h --detach --json --answers 4"]);
    expect(r.lines.join("\n")).toContain(`write .github/workflows/load.yml in ${TEST.name}`);
    expect(r.lines.join("\n")).toContain(`Started the load workflow in ${TEST.name}: burst, for session 1.`);
    const dispatch = f.calls.find((c) => c.args.some((a) => a.endsWith("/dispatches")))!;
    expect(dispatch.body).toEqual({ ref: "main", inputs: { pattern: "burst", session: "1" } });
    expect(currentSession(readLoad(t.p, false, ME), NOW + M)?.until).toBe(NOW + 60 * M);
  });
  test("without the owner's gh, nothing is signed; with a session on, a second start is refused", async () => {
    const t = paired();
    const r = await runLine(t.d, ["load", "start", "--pattern", "day"]);
    expect(r.code).toBe(1);
    expect(r.lines[0]).toContain("gh isn't on this Mac");
    expect(t.signed).toEqual([]);
    const f = fakeGh({ workflow: loadYamlFrom(loadValues(loadConfig(t.p.app, t.p.boxSettings))) });
    Object.assign(t.d, { gh: f.gh });
    expect((await runLine(t.d, ["load", "start", "--pattern", "day", "--detach"])).code).toBe(0);
    const again = await runLine(t.d, ["load", "start", "--pattern", "day", "--detach"]);
    expect(again.code).toBe(1);
    expect(again.lines[0]).toBe("Load test session 1 is on already.");
    expect(t.signed).toHaveLength(1);
  });
  test("--only asks a typed yes when the box can't say whether real jobs wait; no yes, nothing is signed", async () => {
    const t = paired();
    const f = fakeGh();
    const asked: string[] = [];
    Object.assign(t.d, { gh: f.gh, tty: true, ask: async (q: string) => (asked.push(q), "no") });
    const r = await runLine(t.d, ["load", "start", "--pattern", "burst", "--only", "--detach"]);
    expect(r.code).toBe(1);
    expect(asked.join("\n")).toContain("The box can't say whether real jobs wait now.");
    expect(r.lines.at(-1)).toBe("Not started. The real repo carries on.");
    expect(t.signed).toEqual([]);
  });
  test("watched to its end, what the session left queued is cancelled", async () => {
    const t = paired();
    const f = fakeGh({ runs: [{ id: 21, status: "queued", event: "workflow_dispatch", display_title: "taskbox load day session 1 abc" }] });
    Object.assign(t.d, { gh: f.gh, tty: true });
    // The session runs out while the controller waits.
    t.d.sleep = async (ms: number) => void (t.box.sys.clock += Math.max(ms, 61 * M));
    const r = await runLine(t.d, ["load", "start", "--pattern", "day", "--for", "1h"], 3);
    expect(r.code).toBe(0);
    expect(r.lines.join("\n")).toContain("Session 1 ended.");
    expect(r.lines.join("\n")).toContain(`Cancelled 1 test run still queued or running in ${TEST.name}.`);
  });
  test("stop signs the end, then cancels the session's queued runs", async () => {
    const t = paired();
    const f = fakeGh({ runs: [{ id: 31, status: "queued", event: "workflow_dispatch", display_title: "taskbox load burst session 1 abc" }] });
    Object.assign(t.d, { gh: f.gh, tty: true });
    expect((await runLine(t.d, ["load", "start", "--pattern", "burst", "--detach"])).code).toBe(0);
    const r = await runLine(t.d, ["load", "stop"]);
    expect(r.code).toBe(0);
    expect(t.signed.at(-1)).toBe("load stop --json --answers 4");
    expect(loadNow(t.p, t.box.sys.now() + M, ME)).toBeUndefined();
    expect(r.lines.join("\n")).toContain(`Cancelled 1 test run still queued or running in ${TEST.name}.`);
  });
});

describe("a day session, as a saved day for the simulator", () => {
  test("replayDay keeps each job's kind, class, times, phases and peak, names nothing, and replays", async () => {
    const { c, p } = ctx();
    await applyStart(c, { pattern: "day" }, OWNER);
    const job = (repo: string, kind: "macos" | "linux", t: number, m: number, extra: Partial<JobRecord> = {}): JobRecord => ({ v: 1, startedAt: NOW + (t - 2) * M, jobAt: NOW + t * M, endedAt: NOW + (t + m) * M, repo, vmKind: kind, result: "passed", vmDeleted: true, guard: "ok", job: "build the secret thing", phases: { queued: -M, guestUp: M, runnerStarted: 1.5 * M, jobStarted: 2 * M, jobDone: (2 + m) * M }, ...extra });
    const jobs = [job(TEST.name, "linux", 1, 3, { usage: { samples: 4, memPeakMB: 1900, memP90MB: 1800, memTotalMB: 8000, cpuPeak: 1.5, cpuP90: 1, cpus: 4, netInMB: 10.4, netOutMB: 2 }, cpus: 4, memoryMB: 8192, tools: "gen1" }), job(TEST.name, "macos", 2, 6), job(CFG.jobsFrom, "linux", 3, 2, { className: "merge" })];
    const r = loadReport(LOADCFG, jobs, readLoad(p, false, ME), [], NOW + 30 * M, true);
    if (typeof r === "string") throw new Error(r);
    // The report's v3 summaries, each side apart.
    expect(r.network).toEqual({ load: { jobs: 1, inMB: 10, outMB: 2 } });
    expect(r.sizes.load).toEqual([{ kind: "linux", cpus: 4, memoryMB: 8192, jobs: 1 }, { kind: "macos", jobs: 1 }]);
    expect(r.tools).toEqual({ withCache: 1, without: 2, generations: ["gen1"] });
    const day = replayDay(r, jobs);
    expect(day.pattern).toBe("day");
    expect(day.jobs).toHaveLength(3);
    expect(JSON.stringify(day)).not.toMatch(/secret|example-org/);
    expect(day.jobs[0]!.usage).toEqual({ memPeakMB: 1900, cpuPeak: 1.5 });
    const replay = replayFromJobs(JSON.parse(JSON.stringify(day)), LABELS);
    expect(replay.jobs.map((j) => [j.kind, j.event ?? null])).toEqual([["linux", null], ["macos", null], ["linux", "merge_group"]]);
  });
});
