// The tool cache's pass in the loop: between VMs, by one slot at a time. At the loop's start, daily and
// on a tool refresh it checks every blob's hash; it fetches what is missing, builds each os's
// generation, bakes each kind's base VM when its generation or image is new, and removes what no kind
// needs. A bake takes its slot and the start gate as any VM start does, so it counts against the VMs'
// budget and the macOS cap. Nothing here stops a job: a pin that isn't baked in is downloaded as before.
import { existsSync, lstatSync } from "node:fs";
import type { Kind } from "../settings/kinds.ts";
import type { Sys } from "../sys.ts";
import type { VmEngine } from "../vm.ts";
import { type BaseRecord, cloneSourceOf, pinKey, readBases } from "./base.ts";
import { bake } from "./bake.ts";
import { cleanup } from "./cleanup.ts";
import { clearStaging, FETCH_CEILING_MS, type FetchDeps, fetchBlob } from "./fetch.ts";
import { readRefresh, type RefreshSteps } from "./refresh.ts";
import { entriesFor, type ToolOs, type ToolsView } from "./settings.ts";
import type { PinView, ToolsState } from "./state.ts";
import { blobPath, buildGeneration, dropBadBlobs, ensureStore, type Generation, type Store, storeBytes } from "./store.ts";

export const VERIFY_EVERY_MS = 24 * 3600_000;
export const RETRY_MS = 30 * 60_000;
// A bake that fails again waits twice as long each time, up to this, and alarms from the third.
export const BAKE_BACKOFF_MAX_MS = 6 * 3600_000;
export const BAKE_ALARM_AFTER = 3;
// How long one pass may spend fetching, so a slow server never holds a slot for long.
export const FETCH_PHASE_MS = 20 * 60_000;

// What the loop gives the pass. Tests give their own.
export interface ToolsLoop {
  sys: Pick<Sys, "now" | "sleep">;
  engine: VmEngine;
  store: Store;
  view: ToolsView;
  fetch: FetchDeps;
  log(line: string): void;
  event(type: string, text: string, data?: Record<string, unknown>): void;
  // The kinds whose pinned image is on disk now, and each one's image ("" for a kind the box doesn't serve).
  kinds(): Kind[];
  imageOf(kind: Kind): string;
  // What the store may still take: maxGB less what it holds, and the disk's room over its floor.
  // undefined when the disk can't be read.
  roomBytes(): Promise<number | undefined>;
  // Why the disk has no room for this generation's bake, or undefined.
  bakeRoom(gen: Generation): Promise<string | undefined>;
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
  // Failed bakes of one generation in a row, and when the next may try.
  bakeFails: Partial<Record<Kind, { gen: string; n: number; next: number }>>;
  cleanupOwed: boolean; // a cleanup that waited for the gate
  cleanupFails: number; // passes in a row whose cleanup left something
  cleanupWhy?: string;
  why?: string;
}
export const newRun = (): ToolsRun => ({ busy: false, started: false, verifiedAt: 0, next: 0, gens: {}, pinWhy: new Map(), bakeWhy: {}, bakeFails: {}, cleanupOwed: false, cleanupFails: 0 });

const pinnedSet = (v: ToolsView) => new Set(v.entries.map(pinKey));
const currentBase = (bases: BaseRecord[], kind: Kind, image: string, gen?: Generation) => !!gen && bases.some((b) => b.kind === kind && b.image === image && b.gen === gen.id);
const backedOff = (run: ToolsRun, kind: Kind, gen: Generation, now: number) => {
  const f = run.bakeFails[kind];
  return !!f && f.gen === gen.id && now < f.next;
};

// Whether the pass has work now, read cheaply each time a slot is free: no engine call.
export function toolsDue(t: Pick<ToolsLoop, "sys" | "view" | "store" | "kinds" | "imageOf" | "gateFree">, run: ToolsRun): boolean {
  if (run.busy || !t.view.enabled) return false;
  const now = t.sys.now();
  if (!run.started || now - run.verifiedAt >= VERIFY_EVERY_MS || existsSync(t.store.refresh)) return true;
  // A cleanup that waited for the gate goes as soon as it is free; one that failed waits for run.next.
  if (run.cleanupOwed && !run.cleanupWhy && t.gateFree()) return true;
  if (now < run.next) return false;
  if (run.cleanupOwed && t.gateFree()) return true;
  if (t.view.entries.some((e) => !existsSync(blobPath(t.store, e.sha256)))) return true;
  const bases = readBases(t.store);
  return t.kinds().some((k) => !!run.gens[k] && !currentBase(bases, k, t.imageOf(k), run.gens[k]) && !backedOff(run, k, run.gens[k]!, now));
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
    // Fetching: each pin not in the store, from its own URL, within the room left and this pass's time.
    steps?.phase("fetching");
    const pinned = new Set(t.view.entries.map((e) => `${e.os}/${e.name}`));
    for (const k of [...run.pinWhy.keys()]) if (!pinned.has(k)) run.pinWhy.delete(k);
    const fetchUntil = now() + FETCH_PHASE_MS;
    for (const e of t.view.entries) {
      const key = `${e.os}/${e.name}`;
      if (existsSync(blobPath(t.store, e.sha256))) {
        run.pinWhy.delete(key);
        continue;
      }
      const stop = t.stopIf();
      if (stop) throw new Error(`stopped: ${stop}`);
      const left = fetchUntil - now();
      if (left <= 0) {
        run.pinWhy.set(key, "waits for the next pass: this pass's time for downloads ran out");
        continue;
      }
      const room = await t.roomBytes();
      if (room === undefined || room <= 0) {
        run.pinWhy.set(key, room === undefined ? "waits: the free disk can't be read" : "has no room: the cache is at maxGB or the disk at its floor");
        continue;
      }
      show(`fetching ${e.name}`);
      steps?.progress(`fetching ${e.name}`);
      let shown = 0;
      const r = await fetchBlob(
        t.fetch,
        t.store,
        e,
        room,
        (bytes) => {
          if (bytes - shown < 50e6) return;
          shown = bytes;
          steps?.progress(`fetching ${e.name}, ${Math.round(bytes / 1e6)} MB`);
        },
        Math.min(FETCH_CEILING_MS, left),
      );
      if (r.ok) {
        run.pinWhy.delete(key);
        t.log(`fetched ${e.name} (${r.bytes} bytes)`);
        t.event("tool.fetched", `Fetched ${e.name}, ${Math.round(r.bytes / 1e6)} MB, and its hash matched.`, { name: e.name, os: e.os, sha256: e.sha256, bytes: r.bytes });
      } else {
        run.pinWhy.set(key, r.why);
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
      // A new generation, or none, may leave an old base, generation and blobs behind.
      if (gen?.id !== was) run.cleanupOwed = true;
    }
    // Baking: each kind whose image is on disk and whose current generation has no base yet.
    steps?.phase("baking");
    for (const kind of t.kinds()) {
      const gen = run.gens[kind];
      const image = t.imageOf(kind);
      if (!gen || currentBase(readBases(t.store), kind, image, gen)) {
        delete run.bakeWhy[kind];
        delete run.bakeFails[kind];
        continue;
      }
      if (!asked && backedOff(run, kind, gen, now())) continue;
      const stop = t.stopIf();
      if (stop) throw new Error(`stopped: ${stop}`);
      const noRoom = await t.bakeRoom(gen);
      if (noRoom) {
        const why = `waits: no room for the bake: ${noRoom}`;
        if (run.bakeWhy[kind] !== why) t.event("tool.failed", `The ${kind} bake waits: there is no room for it on the disk (${noRoom}). Its jobs clone the last good base, or the image.`, { kind, gen: gen.id });
        run.bakeWhy[kind] = why;
        continue;
      }
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
          delete run.bakeFails[kind];
          run.cleanupOwed = true;
          t.event("tool.baked", `Baked ${r.base.name}: ${gen.manifest.entries.length} tools, gen ${gen.id.slice(0, 7)}.`, { kind, base: r.base.name, gen: gen.id, image });
        } else if (r.stopped) {
          run.bakeWhy[kind] = r.why;
          t.event("tool.failed", `The ${kind} bake stopped: ${r.why}. Its jobs clone the last good base, or the image.`, { kind, gen: gen.id });
          throw new Error(`stopped: ${r.why}`);
        } else {
          const was = run.bakeFails[kind];
          const n = was && was.gen === gen.id ? was.n + 1 : 1;
          const wait = Math.min(RETRY_MS * 2 ** (n - 1), BAKE_BACKOFF_MAX_MS);
          run.bakeFails[kind] = { gen: gen.id, n, next: now() + wait };
          run.bakeWhy[kind] = `failed ${n === 1 ? "once" : `${n} times`}: ${r.why}; it tries again in ${Math.round(wait / 60_000)} min`;
          t.event("tool.failed", `The ${kind} bake failed${n > 1 ? ` ${n} times in a row` : ""}: ${r.why}. Its jobs clone the last good base, or the image.`, { kind, gen: gen.id, failures: n });
        }
      } finally {
        got.release();
      }
    }
    // Cleaning: inside the start gate, so no clone of a base is being made as it goes. A gate held by
    // a start leaves the cleanup owed, and the pass comes back for it once the gate is free.
    steps?.phase("cleaning");
    if (run.cleanupOwed || verify) {
      run.cleanupOwed = true;
      const leave = t.gateFree() ? await t.gate() : undefined;
      if (leave) {
        try {
          const vms = await t.engine.list().catch(() => undefined);
          if (vms) {
            const bases = readBases(t.store);
            const keepBases = new Set<string>();
            for (const kind of ["macos", "linux"] as Kind[]) {
              const image = t.imageOf(kind);
              if (!image) continue;
              for (const b of bases) if (b.kind === kind && b.image === image && b.gen === run.gens[kind]?.id) keepBases.add(b.name);
              const src = cloneSourceOf({ enabled: true, kind, image, current: run.gens[kind]?.id, pinned: pinnedSet(t.view), bases, vms });
              if (src.base) keepBases.add(src.base.name);
            }
            const gens = new Set(Object.values(run.gens).map((g) => g!.id));
            const r = await cleanup({ engine: t.engine, log: t.log }, t.store, { bases: keepBases, gens, blobs: new Set(t.view.entries.map((e) => e.sha256)) });
            // Still owed until it leaves nothing behind: the pass tries again after RETRY_MS.
            if (r.failed.length) {
              run.cleanupFails++;
              run.cleanupWhy = `couldn't remove ${r.failed.join(", ")}`;
              t.event("tool.failed", `The tool cache couldn't remove ${r.failed.join(", ")}, which still take disk.`, { failed: r.failed });
            } else {
              run.cleanupOwed = false;
              run.cleanupFails = 0;
              delete run.cleanupWhy;
            }
          }
        } finally {
          leave();
        }
      }
    }
    run.why = undefined;
    const retry = run.pinWhy.size > 0 || Object.keys(run.bakeWhy).some((k) => !run.bakeFails[k as Kind]) || !!run.cleanupWhy;
    const waits = [...(retry ? [now() + RETRY_MS] : []), ...Object.values(run.bakeFails).map((f) => f!.next)];
    run.next = waits.length ? Math.min(...waits) : 0;
    const left = [...run.pinWhy.keys(), ...Object.keys(run.bakeWhy)];
    steps?.done(left.length ? `done, with ${left.join(", ")} still waiting` : "done");
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
    bytes = storeBytes(t.store);
  } catch {}
  const fails = Object.fromEntries(Object.entries(run.bakeFails).map(([k, f]) => [k, f!.n]));
  return {
    enabled: t.view.enabled,
    at: t.sys.now(),
    maxGB: t.view.maxGB,
    bytes,
    pins,
    gens: Object.fromEntries(Object.entries(run.gens).map(([k, g]) => [k, g!.id])),
    bases: bases.map((b) => ({ kind: b.kind, name: b.name, gen: b.gen, image: b.image, bakedAt: b.bakedAt, diskSha256: b.diskSha256, ...(b.diskBytes !== undefined ? { diskBytes: b.diskBytes } : {}) })),
    sources,
    ...(run.why ? { why: run.why } : {}),
    ...(Object.keys(run.bakeWhy).length ? { bakeWhy: { ...run.bakeWhy } } : {}),
    ...(Object.keys(fails).length ? { bakeFails: fails } : {}),
    ...(run.cleanupWhy ? { cleanupWhy: run.cleanupWhy, cleanupFails: run.cleanupFails } : {}),
    ...(doing ? { doing } : {}),
  };
}
