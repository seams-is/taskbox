// The VM engine: everything taskbox asks of the program that runs its VMs (v2.1.0). Tart is the one
// engine (src/tart.ts). Another, such as Lume, would implement the same interface, and must give
// the same security boundary first. Nothing but this file imports an engine.
import type { Paths, Versions } from "./config.ts";
import type { UsageProbe } from "./guest.ts";
import type { Proc, RunResult, Sys } from "./sys.ts";
import type { UsageSample } from "./usage.ts";
import { TART_KIT } from "./tart.ts";

// IMAGE_GONE lives in imagegone.ts, so tart.ts can use it without importing this file's values.
export { IMAGE_GONE } from "./imagegone.ts";

// A VM or a cached image the engine holds.
export interface VmInfo {
  name: string;
  image: boolean; // a cached image, as pulled; false for a VM made from one
  sizeGB?: number; // whole gigabytes on disk, rounded down
}

// What a VM may reach, said once for every engine. Each engine turns it into its own rules, and must
// enforce all of it.
export interface NetPolicy {
  // Addresses no VM may reach: the box's public address and the tailnet's range.
  block: string[];
  // The box itself is blocked both ways: the VM reaches nothing on it, and nothing on the box can open
  // a connection into the VM. DNS to the box is the one thing let through.
  isolatedFromBox: true;
  boxDns: boolean;
}

export interface VmEngine {
  list(): Promise<VmInfo[]>; // throws when the engine can't list them
  clone(image: string, vm: string): Promise<RunResult>;
  size(vm: string, cpus: number, memoryMB: number): Promise<RunResult>; // on the clone, never the image
  start(vm: string, net: NetPolicy): Proc; // runs until stopped
  exec(vm: string, cmd: string[], stdin?: string | Uint8Array, timeoutMs?: number): Promise<RunResult>; // never over SSH
  execStream(vm: string, cmd: string[], stdin: string, onLine: (l: string) => void): Proc;
  ip(vm: string): Promise<string>;
  stop(vm: string, timeoutS: number): Promise<RunResult>;
  delete(vm: string): Promise<RunResult>;
  // A download, its progress as lines: "pulling disk (N GB compressed)", then "N%" (progress.ts).
  pull(image: string, onLine: (l: string) => void): Proc;
  // Why the cached image isn't the pinned one, read before each clone, or undefined.
  imageProblem(image: string): string | undefined;
  // Why the engine's network isn't as it must be once a VM is up, such as Softnet running as root.
  // halt: the box stops until someone looks; otherwise only this VM fails.
  runtimeProblem(): Promise<{ why: string; halt: boolean } | undefined>;
  // The policy as the engine applied it, for the status file a job reads (box-check reads these).
  netRecord(net: NetPolicy): Record<string, unknown>;
  // v2.5.0: one sample of what the guest uses, by the guest's own probe, within timeoutMs. Never
  // throws: a sample that fails or can't be read is undefined.
  usage(vm: string, probe: UsageProbe, timeoutMs: number): Promise<UsageSample | undefined>;
}

// A check row of the engine's own, for taskbox check and the pre-start checks.
export type EngineCheck = (c: { paths: Paths }) => Promise<{ status: "OK" | "FAIL" | "SKIP"; detail: string }>;

// What the install and undo need from an engine, beside the VM calls.
export interface PlaceContext {
  files: Record<string, string>; // each pin's download, by versions.json name, checked against its pin
  work: string; // a folder of root's for unpacking
  next: string; // the new install folder
  run(cmd: string, args: string[]): Promise<void>; // throws on a non-zero exit
  setuid(path: string): Promise<void>; // root's, mode 4755, read back
}

export interface EngineKit {
  name: EngineName;
  pins: (keyof Versions)[]; // the tools the install fetches for it, in order
  place(c: PlaceContext): Promise<void>; // puts its tools in the new install
  inert(sys: Sys, prev: string): Promise<void>; // makes a kept install's tools unusable
  // After the new install folder is root's and read-only, such as Softnet's setuid bit. Undo runs the
  // same on the kept install, so it is usable again. service: the one account besides root that may
  // enter Softnet's folder (accounts.service).
  finish(dir: string, service: string, setuid: (path: string) => Promise<void>, run: (cmd: string, args: string[]) => Promise<void>): Promise<void>;
  // An install an older release's updater laid out, brought to this layout by the guard (root, on
  // this release's code). true when it changed something.
  settle(dir: string, service: string, run: (cmd: string, args: string[]) => Promise<void>): Promise<boolean>;
  checks: [string, EngineCheck][];
  open(sys: Sys, paths: Paths): VmEngine;
}

export const ENGINES = ["tart"] as const;
export type EngineName = (typeof ENGINES)[number];
export const DEFAULT_ENGINE: EngineName = "tart";

const KITS: Record<EngineName, EngineKit> = { tart: TART_KIT };

// The one factory. cfg.engine is checked by loadConfig.
export function kitFor(name: EngineName | undefined): EngineKit {
  return KITS[name ?? DEFAULT_ENGINE];
}

export function engineFor(name: EngineName | undefined, sys: Sys, paths: Paths): VmEngine {
  return kitFor(name).open(sys, paths);
}
