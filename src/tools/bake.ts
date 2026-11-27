// The bake: one trusted boot of the pinned image, with no job, its network blocked but for DNS to the
// box, and one generation shared read-only into it. A root step copies the tools in, checks each
// hash, unpacks the toolcache entries, and the guest shuts down. The stopped VM is the kind's base,
// and job VMs clone it. The bake runs no job's code.
import type { Kind } from "../settings/kinds.ts";
import type { Sys } from "../sys.ts";
import type { NetPolicy, VmEngine } from "../vm.ts";
import { type BaseRecord, baseNameFor, writeBase } from "./base.ts";
import { bakeScript, SHARE_TAG, SHUTDOWN, TOOL_CACHE_PROBE, toolCacheOf } from "./guest.ts";
import { type Generation, hashFile, type Store } from "./store.ts";

// The bake's network: everything blocked, the box too, and DNS to the box let through, as a job
// VM's rules let it (tart.ts). Softnet takes a rule with a port over one without.
export const BAKE_NET: NetPolicy = { block: ["0.0.0.0/0"], isolatedFromBox: true, boxDns: true };

export const GUEST_TRIES = 60;
export const GUEST_WAIT_MS = 5_000;
export const SCRIPT_MS = 30 * 60_000;
export const SHUTDOWN_MS = 3 * 60_000;

export interface BakeDeps {
  engine: VmEngine;
  sys: Pick<Sys, "now" | "sleep">;
  log(line: string): void;
  size: { cpus: number; memoryMB: number };
  guest: { user: string; loginShell: string[] };
  // The start gate: one VM start at a time, until the guest answers. Absent: none.
  gate?: () => Promise<(() => void) | undefined>;
  // A drain, a hold or an update: the bake stops, and its half-made VM goes.
  stopIf?: () => string | false;
  // Each step, for the op and the status line.
  step?: (text: string) => void;
}

export type Baked = { ok: true; base: BaseRecord } | { ok: false; why: string; stopped?: boolean };

class Stop extends Error {}

export async function bake(d: BakeDeps, s: Store, kind: Kind, image: string, gen: Generation): Promise<Baked> {
  const name = baseNameFor(kind, gen.id, image);
  const e = d.engine;
  const check = () => {
    const why = d.stopIf?.();
    if (why) throw new Stop(why);
  };
  let proc: { exited: Promise<number>; kill(): void } | undefined;
  let leave: (() => void) | undefined;
  let exited = false;
  try {
    check();
    // A half-made base from a bake an update or a restart cut short goes first.
    await e.stop(name, 10).catch(() => undefined);
    await e.delete(name).catch(() => undefined);
    if (d.gate) {
      leave = await d.gate();
      if (!leave) throw new Stop("another VM's start held the gate too long");
    }
    check();
    d.step?.(`cloning the ${kind} image`);
    if ((await e.clone(image, name)).code !== 0) throw new Error("tart clone failed");
    if ((await e.size(name, d.size.cpus, d.size.memoryMB)).code !== 0) throw new Error("tart set failed");
    d.step?.(`starting the ${kind} VM`);
    proc = e.startBake(name, BAKE_NET, { path: gen.dir, tag: SHARE_TAG });
    void proc.exited.then(() => (exited = true));
    let up = false;
    for (let i = 0; i < GUEST_TRIES && !exited; i++) {
      const r = await e.exec(name, ["/usr/bin/true"], undefined, 20_000).catch(() => ({ code: -1 }));
      if (r.code === 0) {
        up = true;
        break;
      }
      await d.sys.sleep(GUEST_WAIT_MS);
    }
    leave?.();
    leave = undefined;
    if (!up) throw new Error(`the ${kind} guest never answered`);
    check();
    const said = await e.exec(name, [...d.guest.loginShell, TOOL_CACHE_PROBE], undefined, 30_000).catch(() => ({ code: -1, stdout: "" }));
    const toolCache = toolCacheOf(said.code === 0 ? said.stdout : "");
    d.step?.(`baking ${kind}`);
    const r = await e.exec(name, ["/usr/bin/sudo", "-n", "/bin/sh", "-s"], bakeScript(kind, gen.id, gen.manifest, toolCache, d.guest.user), SCRIPT_MS);
    if (r.code !== 0 || !/(^|\n)baked\s*$/.test(r.stdout)) throw new Error(`the bake step failed: ${(r.stderr || r.stdout).trim().split("\n").pop()?.slice(0, 160) ?? `exit ${r.code}`}`);
    // The guest shuts itself down, so its disk is whole. Its exec may end with the connection.
    await e.exec(name, SHUTDOWN[kind], undefined, 30_000).catch(() => undefined);
    const until = d.sys.now() + SHUTDOWN_MS;
    while (!exited && d.sys.now() < until) await Promise.race([proc.exited, d.sys.sleep(2_000)]);
    if (!exited) throw new Error(`the ${kind} guest didn't shut down`);
    proc = undefined;
    const disk = await hashFile(e.diskPath(name));
    if (!disk) throw new Error("the base VM's disk can't be read");
    const base: BaseRecord = { v: 1, name, kind, image, gen: gen.id, entries: gen.manifest.entries.map((x) => `${x.name}@${x.sha256}`), diskSha256: disk.hex, bakedAt: d.sys.now() };
    writeBase(s, base);
    d.log(`baked ${name} with ${gen.manifest.entries.length} tools`);
    return { ok: true, base };
  } catch (err) {
    leave?.();
    if (proc) {
      await e.stop(name, 10).catch(() => undefined);
      proc.kill();
    }
    await e.delete(name).catch(() => undefined);
    const why = (err as Error).message;
    d.log(`the ${kind} bake ${err instanceof Stop ? "stopped" : "failed"}: ${why}`);
    return { ok: false, why, ...(err instanceof Stop ? { stopped: true } : {}) };
  }
}
