// The tool cache's pass in the loop: between VMs, by one slot at a time. At the loop's start, daily and
// on a tool refresh it checks every blob's hash; it fetches what is missing, builds each os's
// generation, bakes each kind's base VM when its generation or image is new, and removes what no kind
// needs. A bake takes its slot and the start gate as any VM start does, so it counts against the VMs'
// budget and the macOS cap. Nothing here stops a job: a pin that isn't baked in is downloaded as before.
import type { Kind } from "../settings/kinds.ts";
import type { Sys } from "../sys.ts";
import type { VmEngine } from "../vm.ts";
import { type BaseRecord, cloneSourceOf, readBases } from "./base.ts";
import { bake } from "./bake.ts";
import { cleanup } from "./cleanup.ts";
import { clearStaging, type FetchDeps, fetchBlob } from "./fetch.ts";
import { readRefresh, type RefreshSteps } from "./refresh.ts";
import { entriesFor, type ToolOs, type ToolsView } from "./settings.ts";
import { blobBytes, blobPath, buildGeneration, dropBadBlobs, ensureStore, type Generation, type Store } from "./store.ts";
import type { PinView, ToolsState } from "./state.ts";
import { existsSync, lstatSync } from "node:fs";

export const VERIFY_EVERY_MS = 24 * 3600_000;
export const RETRY_MS = 30 * 60_000;

// What the loop gives the pass. Tests give their own.
export interface ToolsLoop {
  sys: Pick<Sys, "now" | "sleep">;
  engine: VmEngine;
  store: Store;
  view: ToolsView;
  fetch: FetchDeps;
  log(line: string): void;
  event(type: string, text: string, data?: Record<string, unknown>): void;
  // The kinds whose pinned image is on disk now, and each one's image.
  kinds(): Kind[];
  imageOf(kind: Kind): string;
  // What the store may still take: maxGB less what it holds, and the disk's room over its floor.
  roomBytes(): Promise<number>;
  // This slot taken for a bake of kind, if the box has room for one more VM now: the macOS cap and
  // the pre-start checks. The way out, or why not.
  claim(kind: Kind): Promise<{ release(): void; size: { cpus: number; memoryMB: number } } | string>;
  gate(): Promise<(() => void) | undefined>;
  gateFree(): boolean;
  guestOf(kind: Kind): { user: string; loginShell: string[] };
  stopIf(): string | false;
  write(state: ToolsState): void;
  refresh?: RefreshSteps; // the op a tool refresh started, when one is running
}

// What one loop run keeps between passes.
export interface ToolsRun {
  busy: boolean;
  started: boolean;
  verifiedAt: number;
  next: number; // the next pass for something outstanding, after a failure
  gens: Partial<Record<ToolOs, Generation>>;
  pinWhy: Map<string, string>; // os/name: why its fetch failed
  bakeWhy: Partial<Record<Kind, string>>;
  why?: string;
}
export const newRun = (): ToolsRun => ({ busy: false, started: false, verifiedAt: 0, next: 0, gens: {}, pinWhy: new Map(), bakeWhy: {} });

const pinnedSet = (v: ToolsView) => new Set(v.entries.map((e) => `${e.name}@${e.sha256}`));
const currentBase = (bases: BaseRecord[], kind: Kind, image: string, gen?: Generation) => !!gen && bases.some((b) => b.kind === kind && b.image === image && b.gen === gen.id);

// Whether the pass has work now, read cheaply each time a slot is free: no engine call.
export function toolsDue(t: Pick<ToolsLoop, "sys" | "view" | "store" | "kinds" | "imageOf">, run: ToolsRun): boolean {
  if (run.busy || !t.view.enabled) return false;
  const now = t.sys.now();
  if (!run.started || now - run.verifiedAt >= VERIFY_EVERY_MS || existsSync(t.store.refresh)) return true;
  if (now < run.next) return false;
  const missing = t.view.entries.some((e) => !existsSync(blobPath(t.store, e.sha256)));
  const bases = readBases(t.store);
  return missing || t.kinds().some((k) => !!run.gens[k] && !currentBase(bases, k, t.imageOf(k), run.gens[k]));
}

// One pass. Returns true when it held the slot for a bake, so the slot looks again from the top.
export async function toolsPass(t: ToolsLoop, run: ToolsRun): Promise<boolean> {
  if (!toolsDue(t, run)) return false;
  run.busy = true;
  const now = () => t.sys.now();
  const asked = readRefresh(t.store);
  const steps = t.refresh;
  let held = false;
  const show = (doing?: string) => t.write(stateOf(t, run, readBases(t.store), doing));
  try {
    if (!run.started) clearStaging(t.store);
    ensureStore(t.store);
    const verify = !run.started || !!asked || now() - run.verifiedAt >= VERIFY_EVERY_MS;
    run.started = true;
    if (verify) {
      steps?.phase("verifying");
      const bad = await dropBadBlobs(t.store);
      for (const b of bad) t.event("tool.failed", `A stored tool, ${b.slice(0, 12)}, didn't match its hash, so it is fetched again.`, { sha256: b });
      run.verifiedAt = now();
    }
    // Fetching: each pin not in the store, from its own URL, within the room left.
    steps?.phase("fetching");
    for (const e of t.view.entries) {
      if (existsSync(blobPath(t.store, e.sha256))) {
        run.pinWhy.delete(`${e.os}/${e.name}`);
        continue;
      }
      const stop = t.stopIf();
      if (stop) throw new Error(`stopped: ${stop}`);
      const room = await t.roomBytes();
      if (room <= 0) {
        run.pinWhy.set(`${e.os}/${e.name}`, "has no room: the cache is at maxGB or the disk at its floor");
        continue;
      }
      show(`fetching ${e.name}`);
      steps?.progress(`fetching ${e.name}`);
      let shown = 0;
      const r = await fetchBlob(t.fetch, t.store, e, room, (bytes) => {
        if (bytes - shown < 50e6) return;
        shown = bytes;
        steps?.progress(`fetching ${e.name}, ${Math.round(bytes / 1e6)} MB`);
      });
      if (r.ok) {
        run.pinWhy.delete(`${e.os}/${e.name}`);
        t.log(`fetched ${e.name} (${r.bytes} bytes)`);
        t.event("tool.fetched", `Fetched ${e.name}, ${Math.round(r.bytes / 1e6)} MB, and its hash matched.`, { name: e.name, os: e.os, sha256: e.sha256, bytes: r.bytes });
      } else {
        run.pinWhy.set(`${e.os}/${e.name}`, r.why);
        t.log(`could not fetch ${e.name}: ${r.why}`);
        t.event("tool.failed", `${e.name} wasn't fetched: ${r.why}. Its jobs download it as before.`, { name: e.name, os: e.os, sha256: e.sha256 });
      }
    }
    // Building: one generation per os, of the pins the store holds.
    steps?.phase("building");
    for (const os of ["macos", "linux"] as ToolOs[]) {
      const was = run.gens[os]?.id;
      const { gen } = await buildGeneration(t.store, os, entriesFor(t.view, os));
      if (gen) run.gens[os] = gen;
      else delete run.gens[os];
      if (gen && gen.id !== was) t.event("tool.generation", `Generation ${gen.id.slice(0, 7)} holds ${gen.manifest.entries.length} ${os} tools.`, { os, gen: gen.id, tools: gen.manifest.entries.length });
    }
    // Baking: each kind whose image is on disk and whose current generation has no base yet.
    steps?.phase("baking");
    for (const kind of t.kinds()) {
      const gen = run.gens[kind];
      const image = t.imageOf(kind);
      if (!gen || currentBase(readBases(t.store), kind, image, gen)) {
        delete run.bakeWhy[kind];
        continue;
      }
      const stop = t.stopIf();
      if (stop) throw new Error(`stopped: ${stop}`);
      const got = await t.claim(kind);
      if (typeof got === "string") {
        run.bakeWhy[kind] = `waits: ${got}`;
        continue;
      }
      held = true;
      try {
        show(`baking ${kind}`);
        steps?.progress(`baking ${kind}`);
        const r = await bake({ engine: t.engine, sys: t.sys, log: t.log, size: got.size, guest: t.guestOf(kind), gate: t.gate, stopIf: t.stopIf, step: (x) => steps?.progress(x) }, t.store, kind, image, gen);
        if (r.ok) {
          delete run.bakeWhy[kind];
          t.event("tool.baked", `Baked ${r.base.name}: ${gen.manifest.entries.length} tools, gen ${gen.id.slice(0, 7)}.`, { kind, base: r.base.name, gen: gen.id, image });
        } else {
          run.bakeWhy[kind] = r.why;
          t.event("tool.failed", `The ${kind} bake ${r.stopped ? "stopped" : "failed"}: ${r.why}. Its jobs clone the last good base, or the image.`, { kind, gen: gen.id });
          if (r.stopped) throw new Error(`stopped: ${r.why}`);
        }
      } finally {
        got.release();
      }
    }
    // Cleaning: only with no VM start in the gate, so no clone of a base is being made as it goes.
    steps?.phase("cleaning");
    if (t.gateFree()) {
      const bases = readBases(t.store);
      const keepBases = new Set<string>();
      for (const kind of ["macos", "linux"] as Kind[]) {
        const image = t.imageOf(kind);
        if (!image) continue;
        for (const b of bases) if (b.kind === kind && b.image === image && b.gen === run.gens[kind]?.id) keepBases.add(b.name);
        const src = cloneSourceOf({ enabled: true, kind, image, current: run.gens[kind]?.id, pinned: pinnedSet(t.view), bases, vms: (await t.engine.list().catch(() => [])) });
        if (src.base) keepBases.add(src.base.name);
      }
      const gens = new Set(Object.values(run.gens).map((g) => g!.id));
      await cleanup({ engine: t.engine, log: t.log }, t.store, { bases: keepBases, gens, blobs: new Set(t.view.entries.map((e) => e.sha256)) });
    }
    run.why = undefined;
    const outstanding = run.pinWhy.size > 0 || Object.keys(run.bakeWhy).length > 0;
    run.next = outstanding ? now() + RETRY_MS : 0;
    steps?.done(outstanding ? `done, with ${[...run.pinWhy.keys(), ...Object.keys(run.bakeWhy)].join(", ")} still waiting` : "done");
  } catch (e) {
    run.why = (e as Error).message;
    run.next = now() + RETRY_MS;
    t.log(`the tool cache: ${run.why}`);
    steps?.fail(run.why);
  } finally {
    run.busy = false;
    show();
  }
  return held;
}

// The tool cache's record for the loop's state.
export function stateOf(t: Pick<ToolsLoop, "sys" | "view" | "store" | "kinds" | "imageOf">, run: ToolsRun, bases: BaseRecord[], doing?: string, vms?: { name: string; image: boolean }[]): ToolsState {
  const pins: PinView[] = t.view.entries.map((e) => {
    const why = run.pinWhy.get(`${e.os}/${e.name}`);
    let bytes: number | undefined;
    try {
      bytes = lstatSync(blobPath(t.store, e.sha256)).size;
    } catch {}
    return { name: e.name, os: e.os, sha256: e.sha256, ...(bytes !== undefined ? { bytes } : {}), state: bytes !== undefined ? "held" : why ? "failed" : "missing", ...(why ? { why } : {}) };
  });
  const listed = vms ?? bases.map((b) => ({ name: b.name, image: false }));
  const sources: ToolsState["sources"] = {};
  for (const kind of t.kinds()) sources[kind] = cloneSourceOf({ enabled: t.view.enabled, kind, image: t.imageOf(kind), current: run.gens[kind]?.id, pinned: pinnedSet(t.view), bases, vms: listed }).source;
  let bytes = 0;
  try {
    bytes = blobBytes(t.store);
  } catch {}
  return {
    enabled: t.view.enabled,
    at: t.sys.now(),
    maxGB: t.view.maxGB,
    bytes,
    pins,
    gens: Object.fromEntries(Object.entries(run.gens).map(([k, g]) => [k, g!.id])),
    bases: bases.map((b) => ({ kind: b.kind, name: b.name, gen: b.gen, image: b.image, bakedAt: b.bakedAt })),
    sources,
    ...(run.why ? { why: run.why } : {}),
    ...(Object.keys(run.bakeWhy).length ? { bakeWhy: { ...run.bakeWhy } } : {}),
    ...(doing ? { doing } : {}),
  };
}
