// v2.1.0: choosing the kind by GitHub's queued jobs, read as a second App, Actions read only.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Config, loadConfig } from "../src/config.ts";
import { Log } from "../src/log.ts";
import { oneJob } from "../src/loop.ts";
import { choiceLine } from "../src/ops.ts";
import { MAX_RUNS, QueueError, QueueReader, queueReaderFor, queueWhy, TOKEN_KEEP_MS } from "../src/queue.ts";
import { FakeSys, githubRoutes, json } from "./fake.ts";
import { CFG, loopDeps, PEM, settingsDir, settingsText, tempRoot } from "./helpers.ts";

const repo = join(import.meta.dir, "..");
const LINUX_IMAGE = "ghcr.io/cirruslabs/ubuntu-runner-arm64@sha256:" + "1".repeat(64);
const LCFG: Config = { ...CFG, linux: { label: "taskbox-linux", image: LINUX_IMAGE, vmCpus: 4, vmMemoryMB: 8192 } };
const BOTH = ["macos", "linux"] as const;
const T0 = Date.parse("2026-11-17T10:00:00Z");

// GitHub's Actions API for the jobs repo, as the second App sees it.
function actionsApi(sys: FakeSys, o: { runs?: Record<string, number[]>; jobs?: Record<number, { id?: number; status: string; labels: string[]; created_at: string }[]>; status?: number; events?: Record<number, unknown> } = {}) {
  const seen = { tokens: 0, tokenBodies: [] as unknown[], gets: [] as { path: string; etag?: string }[] };
  const real = sys.fetch.bind(sys);
  sys.fetch = async (url, init) => {
    const u = new URL(url);
    const p = u.pathname + u.search;
    const etag = (init?.headers as Record<string, string> | undefined)?.["If-None-Match"];
    if (u.pathname === "/repos/example-org/app/installation") return o.status ? new Response("{}", { status: o.status }) : json({ id: 77 });
    if (u.pathname === "/app/installations/77/access_tokens") {
      seen.tokens++;
      seen.tokenBodies.push(JSON.parse(String(init?.body)));
      return json({ token: "ghs_" + "Q".repeat(36) });
    }
    if (u.pathname.startsWith("/repos/example-org/app/actions/")) {
      seen.gets.push({ path: p, etag });
      const m = /^\/repos\/example-org\/app\/actions\/runs\/(\d+)\/jobs$/.exec(u.pathname);
      const body = JSON.stringify(m ? { jobs: o.jobs?.[Number(m[1])] ?? [] } : { workflow_runs: (o.runs?.[u.searchParams.get("status")!] ?? []).map((id) => ({ id, ...(o.events?.[id] !== undefined ? { event: o.events[id] } : {}) })) });
      // The ETag follows the answer, as GitHub's does.
      const tag = `"e-${p}#${body.length}-${[...body].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7)}"`;
      if (etag === tag) return new Response(null, { status: 304 });
      return new Response(body, { status: 200, headers: { "Content-Type": "application/json", ETag: tag } });
    }
    return real(url, init);
  };
  return seen;
}

const reader = (sys: FakeSys) => new QueueReader(sys, 999, PEM, "example-org/app", new Log());
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

describe("reading the queue", () => {
  test("queued jobs in queued and in-progress runs, counted per label, oldest kept", async () => {
    const sys = new FakeSys();
    actionsApi(sys, {
      runs: { queued: [1], in_progress: [2, 1] },
      jobs: {
        1: [{ status: "queued", labels: ["taskbox-macos"], created_at: at(5) }, { status: "completed", labels: ["taskbox-linux"], created_at: at(0) }],
        2: [{ status: "queued", labels: ["taskbox-linux"], created_at: at(3) }, { status: "in_progress", labels: ["taskbox-macos"], created_at: at(1) }, { status: "queued", labels: ["ubuntu-latest"], created_at: at(0) }],
      },
    });
    const w = await reader(sys).waiting(["taskbox-macos", "taskbox-linux"]);
    expect([...w.entries()].sort()).toEqual([["taskbox-linux", T0 + 3 * 60_000], ["taskbox-macos", T0 + 5 * 60_000]]);
  });

  test("v2.4.0 items: every label as GitHub lists it, the run's event as GitHub set it, the job's own key, and odd when a label is out of shape", async () => {
    const sys = new FakeSys();
    actionsApi(sys, {
      runs: { queued: [1, 2, 3] },
      events: { 1: "merge_group", 2: "pull_request", 3: "Not An Event!" },
      jobs: {
        1: [{ id: 501, status: "queued", labels: ["self-hosted", "Linux", "ARM64", "taskbox-linux-merge"], created_at: at(1) }],
        2: [{ id: 502, status: "queued", labels: ["taskbox-linux-merge", "bad label;"], created_at: at(2) }],
        3: [{ id: 503, status: "queued", labels: ["taskbox-macos"], created_at: at(3) }, { id: 504, status: "in_progress", labels: ["taskbox-macos"], created_at: at(3) }],
      },
    });
    const items = await reader(sys).items();
    expect(items).toEqual([
      { key: "gh-501", labels: ["self-hosted", "Linux", "ARM64", "taskbox-linux-merge"], queuedAt: T0 + 60_000, origin: { event: "merge_group", trusted: true } },
      { key: "gh-502", labels: ["taskbox-linux-merge"], queuedAt: T0 + 2 * 60_000, origin: { event: "pull_request", trusted: true }, odd: true },
      { key: "gh-503", labels: ["taskbox-macos"], queuedAt: T0 + 3 * 60_000, origin: { trusted: false } },
    ]);
  });

  test("the runs of the classes' events are read first, and a run's jobs are read again only when the run changed", async () => {
    const sys = new FakeSys();
    const seen = actionsApi(sys, { runs: { queued: [1] }, events: { 1: "merge_group" }, jobs: { 1: [{ id: 9, status: "queued", labels: ["taskbox-linux-merge"], created_at: at(1) }] } });
    const r = new QueueReader(sys, 999, PEM, "example-org/app", new Log(), ["merge_group"]);
    await r.items();
    expect(seen.gets.slice(0, 2).map((g) => g.path)).toEqual(["/repos/example-org/app/actions/runs?status=queued&event=merge_group&per_page=50", "/repos/example-org/app/actions/runs?status=in_progress&event=merge_group&per_page=50"]);
  });

  test("one token, Actions read on the jobs repo only, kept for 55 minutes; ETags sent, and a 304 uses the last answer", async () => {
    const sys = new FakeSys();
    const seen = actionsApi(sys, { runs: { queued: [1] }, jobs: { 1: [{ status: "queued", labels: ["taskbox-linux"], created_at: at(0) }] } });
    const r = reader(sys);
    expect((await r.waiting(["taskbox-linux"])).has("taskbox-linux")).toBe(true);
    expect(seen.gets.every((g) => g.etag === undefined)).toBe(true);
    seen.gets.length = 0;
    expect((await r.waiting(["taskbox-linux"])).has("taskbox-linux")).toBe(true);
    expect(seen.gets.length).toBe(3);
    expect(seen.gets.every((g) => g.etag?.startsWith(`"e-${g.path}#`))).toBe(true);
    expect(seen.tokens).toBe(1);
    expect(seen.tokenBodies[0]).toEqual({ repositories: ["app"], permissions: { actions: "read" } });
    sys.clock += TOKEN_KEEP_MS - 1000;
    await r.waiting(["taskbox-linux"]);
    expect(seen.tokens).toBe(1);
    sys.clock += 2000;
    await r.waiting(["taskbox-linux"]);
    expect(seen.tokens).toBe(2);
  });

  test("ETags are kept only for the lists the last look read", async () => {
    const sys = new FakeSys();
    const runs = { queued: [1] as number[] };
    const seen = actionsApi(sys, { runs });
    const r = reader(sys);
    await r.waiting(["taskbox-linux"]);
    runs.queued = [2];
    await r.waiting(["taskbox-linux"]);
    runs.queued = [1];
    seen.gets.length = 0;
    await r.waiting(["taskbox-linux"]);
    // Run 1's jobs were dropped from the cache when the look before didn't read them.
    expect(seen.gets.find((g) => g.path.includes("/runs/1/jobs"))!.etag).toBeUndefined();
    expect(seen.gets.find((g) => g.path.includes("status=queued"))!.etag).toMatch(/^"e-\/repos\/example-org\/app\/actions\/runs\?status=queued&per_page=50#/);
  });

  test("at most MAX_RUNS runs are read for their jobs", async () => {
    const sys = new FakeSys();
    const seen = actionsApi(sys, { runs: { queued: Array.from({ length: 50 }, (_, i) => i + 1) } });
    await reader(sys).waiting(["taskbox-linux"]);
    expect(seen.gets.filter((g) => g.path.includes("/jobs")).length).toBe(MAX_RUNS);
  });

  test("no permission is a 403 with its own words", async () => {
    const sys = new FakeSys();
    actionsApi(sys, { status: 403 });
    const e = await reader(sys).waiting(["taskbox-linux"]).catch((x) => x);
    expect(e).toBeInstanceOf(QueueError);
    expect((e as QueueError).status).toBe(403);
    expect(queueWhy(e)).toBe("the second App can't read the jobs repo's Actions (no permission, or not installed there)");
    expect(queueWhy(new Error("offline"))).toBe("GitHub's queued jobs couldn't be read");
  });

  test("with no second App the box takes turns (the key's own rules are in test/actionskey.test.ts)", () => {
    const sys = new FakeSys();
    expect(queueReaderFor(sys, LCFG, "/nowhere", "/nowhere/k.pem", 501, new Log())).toBe("there is no job source App yet");
    expect(queueReaderFor(sys, { ...LCFG, sources: [{ type: "none" }] }, "/nowhere", "/nowhere/k.pem", 501, new Log())).toBe("the job source is none");
    expect(queueReaderFor(sys, { ...LCFG, actionsAppId: 999 }, "/nowhere", "/nowhere/k.pem", 501, new Log())).toBe("the second App's key isn't on the box");
  });

  test("actionsAppId is a second App's ID", () => {
    const dir = mkdtempSync(join(tmpdir(), "taskbox-cfg-"));
    // Without the box's own job source, so actionsAppId is the only source here.
    const { sources: _, ...base } = JSON.parse(settingsText());
    const load = (v: Record<string, unknown>) => (writeFileSync(join(dir, "taskbox.json"), JSON.stringify({ ...base, ...v })), () => loadConfig(dir));
    expect(load({ actionsAppId: 4242 })().actionsAppId).toBe(4242);
    for (const bad of [0, -1, "4242", base.appId]) expect(load({ actionsAppId: bad })).toThrow("actionsAppId");
    expect("actionsAppId" in base).toBe(false);
  });
});


describe("status and check", () => {
  test("say how the box chooses", () => {
    expect(choiceLine({ kindChoice: "source" }, 2)).toBe("by the job source's waiting jobs: the best class first, then the oldest");
    expect(choiceLine({ kindChoice: "follow: no job source is set" }, 2)).toBe("following the jobs the VMs take, since no job source is set");
    expect(choiceLine({ kindChoice: "turns: there is no second App for the queued jobs yet" }, 2)).toBe("taking turns, since there is no second App for the queued jobs yet");
    expect(choiceLine({}, 2)).toBe("not read yet: the loop says once it starts a VM");
    expect(choiceLine({ kindChoice: "queue" }, 1)).toBeUndefined();
  });
});
