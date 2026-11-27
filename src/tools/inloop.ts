// Where the loop meets the tool cache: the pass between VMs, the VM each job clones, and the lines
// its runner's .env gets. loop.ts calls these three; everything else is the tool cache's own.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { allOk, freeGB, runChecks } from "../checks.ts";
import { forKind, type Kind, KIND_WORD, kindsOf, MACOS_MAX, smallestSize } from "../config.ts";
import { eventLog } from "../core/events.ts";
import { loopState } from "../core/paths.ts";
import { guestOf, GUEST_USER } from "../guest.ts";
import { beatFor } from "../beat.ts";
import { engineOf, kindDeps, type LoopDeps, type Slots, writeLoopState } from "../loop.ts";
import { rows } from "../rows/index.ts";
import { type CloneSource, cloneSourceOf, readBases } from "./base.ts";
import { type FetchDeps, realResolve, type Resolve } from "./fetch.ts";
import { newRun, toolsDue as toolsDueNow, type ToolsLoop, toolsPass, type ToolsRun } from "./pass.ts";
import { readRefresh, refreshCancelled, refreshSteps } from "./refresh.ts";
import { toolsOf } from "./settings.ts";
import { blobBytes, shortGen, type Store, storeOf } from "./store.ts";

// The slot's word while it bakes, and its beat: the gate (46 min), the clone (15), the guest (5),
// the bake step (30), the shutdown (3) and the disk's hash, with room.
export const BAKING = "baking tools";
export const BAKE_BEAT_MS = 2 * 3600_000;

// Tests replace the network.
export interface ToolsDeps {
  fetch?: FetchDeps["fetch"];
  resolve?: Resolve;
}

export const storeFor = (d: Pick<LoopDeps, "paths">): Store => storeOf(join(d.paths.state, "tools"));

const runs = new WeakMap<Slots, ToolsRun>();
const runOf = (box: Slots) => {
  let r = runs.get(box);
  if (!r) runs.set(box, (r = newRun()));
  return r;
};

// Whether the tool cache has anything to do: on, with a pin (for this kind's os, when given). Read
// with no await, so a box with no pins runs as it did before the cache.
export function toolsOn(cfg: LoopDeps["cfg"], kind?: Kind): boolean {
  const v = toolsOf(cfg);
  return v.enabled && v.entries.some((e) => kind === undefined || e.os === kind);
}

// The loop's own pass: true when this slot held a VM for a bake, so it looks again from the top.
export async function toolsStep(d: LoopDeps & { tools?: ToolsDeps }, c: { box: Slots; held: Set<Kind>; updated: () => boolean }): Promise<boolean> {
  const view = toolsOf(d.cfg);
  const store = storeFor(d);
  const run = runOf(c.box);
  const ops = { dir: loopState(d.paths.state).ops, owner: process.getuid?.() ?? 0 };
  const events = eventLog("loop", { dir: loopState(d.paths.state).events, owner: process.getuid?.() ?? 0 }, d.sys);
  const asked = readRefresh(store);
  const t: ToolsLoop = {
    sys: d.sys,
    engine: engineOf(d),
    store,
    view,
    fetch: { fetch: d.tools?.fetch ?? ((u, i) => d.sys.fetch(u, i)), resolve: d.tools?.resolve ?? realResolve, timeout: (ms) => d.sys.timeout(ms) },
    log: (l) => d.log.write(l),
    event: (type, text, data) => {
      try {
        events.write({ type, actor: "taskbox", text, ...(data ? { data } : {}) } as Parameters<typeof events.write>[0]);
      } catch {}
    },
    kinds: () => kindsOf(d.cfg).filter((k) => c.held.has(k)),
    // A kind the box doesn't serve has no image, so cleanup keeps none of its bases.
    imageOf: (k) => (kindsOf(d.cfg).includes(k) ? forKind(d.cfg, k).image : ""),
    roomBytes: async () => {
      const free = await freeGB(d.sys);
      if (free === undefined) return 0;
      const running = c.box.othersUp(d.slot).length;
      const disk = (free - d.cfg.minFreeDiskGB * (1 + running)) * 1e9;
      let held = 0;
      try {
        held = blobBytes(store);
      } catch {}
      return Math.floor(Math.min(disk, view.maxGB * 1e9 - held));
    },
    claim: async (kind) => {
      const others = c.box.others(d.slot);
      if (kind === "macos" && others.filter((o) => o.kind === "macos").length >= MACOS_MAX) return `${MACOS_MAX} macOS VMs run already`;
      const small = smallestSize(d.cfg, kind);
      c.box.held.set(d.slot, { slot: d.slot, kind, labels: [], job: true, up: true, size: small.name, memoryMB: small.vmMemoryMB, cpus: small.vmCpus });
      const release = () => c.box.release(d.slot, d.sys.now());
      const dl = kindDeps(d, kind, small.name);
      const ctx = { ...dl.checks, vmsRunning: others.length };
      const pre = await (dl.prestart ? dl.prestart(ctx) : runChecks(rows("prestart", ctx), ctx)).catch(() => [{ name: "Pre-start check", status: "FAIL" as const, detail: "errored" }]);
      if (!allOk(pre)) {
        release();
        return `a check failed (${pre.filter((x) => x.status === "FAIL").map((x) => x.name).join(", ")})`;
      }
      writeLoopState(d.paths, {}, { slot: d.slot, patch: { slot: BAKING, slotAt: d.sys.now(), vmKind: kind, beat: beatFor(BAKING, d.sys.now(), BAKE_BEAT_MS) } });
      return {
        size: { cpus: small.vmCpus, memoryMB: small.vmMemoryMB },
        release: () => {
          release();
          writeLoopState(d.paths, {}, { slot: d.slot, patch: { slot: "idle", slotAt: d.sys.now(), vmKind: undefined, beat: beatFor("idle", d.sys.now()) } });
        },
      };
    },
    gate: () => c.box.enter(d.slot, d.sys, () => c.box.halt !== undefined),
    gateFree: () => !c.box.gateHeld(),
    guestOf: (k) => ({ user: GUEST_USER, loginShell: guestOf(k).loginShell }),
    stopIf: () => (c.updated() ? "an update was installed" : c.box.halt !== undefined ? "the loop is stopping" : (asked && refreshCancelled(ops, asked.op) && "the refresh was cancelled") || (existsSync(d.paths.drain) && "a drain began") || false),
    write: (s) => writeLoopState(d.paths, { tools: s }),
  };
  if (asked && toolsDueNow(t, run)) {
    const steps = refreshSteps(ops, store, asked.op, () => d.sys.now());
    if (steps) t.refresh = steps;
  }
  return toolsPass(t, run);
}

// The VM a job of this kind clones now (base.ts cloneSourceOf), read before each clone. With the
// cache off, or anything unreadable, the pinned image: jobs run either way.
export async function cloneSource(d: LoopDeps, kind: Kind): Promise<CloneSource & { gen?: string }> {
  const image = forKind(d.cfg, kind).image;
  const view = toolsOf(d.cfg);
  if (!view.enabled || !view.entries.some((e) => e.os === kind)) return { source: image };
  try {
    const store = storeFor(d);
    const bases = readBases(store);
    const run = d.box ? runs.get(d.box) : undefined;
    // Before this loop run's first pass the current generation isn't known: then only a base whose
    // every pin is still pinned is taken.
    const current = run?.gens[kind]?.id ?? "unknown";
    const src = cloneSourceOf({ enabled: true, kind, image, current, pinned: new Set(view.entries.map((e) => `${e.name}@${e.sha256}`)), bases, vms: await engineOf(d).list() });
    return src.base ? { ...src, gen: shortGen(src.base.gen) } : src;
  } catch (e) {
    d.log.write(`the ${KIND_WORD[kind]} base VM couldn't be read, so the VM clones the image: ${(e as Error).message}`);
    return { source: image };
  }
}

export { runnerEnvScript } from "./guest.ts";
