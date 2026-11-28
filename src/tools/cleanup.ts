// What the tool cache no longer needs: a base VM that no kind clones now goes, then each generation
// no base and no current pin set holds, then each blob nothing pins. Run only while no VM start holds
// the gate, so no clone of a base is in progress as it goes. A clone already made is its own copy.
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { VmEngine } from "../vm.ts";
import { type BaseRecord, dropBase, isBaseVm, readBases } from "./base.ts";
import { listGenerations, removeTree, type Store } from "./store.ts";

export async function cleanup(d: { engine: VmEngine; log(line: string): void }, s: Store, keep: { bases: Set<string>; gens: Set<string>; blobs: Set<string> }): Promise<{ removed: string[]; failed: string[] }> {
  const removed: string[] = [];
  const failed: string[] = [];
  const records = readBases(s);
  const kept: BaseRecord[] = [];
  for (const r of records) {
    if (keep.bases.has(r.name)) {
      kept.push(r);
      continue;
    }
    await d.engine.stop(r.name, 10).catch(() => undefined);
    const del = await d.engine.delete(r.name).catch(() => ({ code: 1, stdout: "", stderr: "" }));
    // Gone already counts as gone.
    const listed = await d.engine.list().catch(() => undefined);
    if (del.code === 0 || (listed && !listed.some((v) => v.name === r.name))) {
      dropBase(s, r.name);
      removed.push(r.name);
    } else {
      failed.push(r.name);
      kept.push(r);
    }
  }
  // A base VM with no record is a bake that never finished.
  const vms = await d.engine.list().catch(() => []);
  for (const vm of vms) {
    if (!isBaseVm(vm) || keep.bases.has(vm.name) || records.some((r) => r.name === vm.name)) continue;
    await d.engine.stop(vm.name, 10).catch(() => undefined);
    if ((await d.engine.delete(vm.name).catch(() => ({ code: 1 }))).code === 0) removed.push(vm.name);
    else failed.push(vm.name);
  }
  const gens = new Set([...keep.gens, ...kept.map((r) => r.gen)]);
  const { ids, leftovers } = listGenerations(s);
  for (const id of [...ids.filter((i) => !gens.has(i)), ...leftovers]) {
    removeTree(join(s.gen, id));
    removed.push(`generation ${id.slice(0, 7)}`);
  }
  for (const name of readdirSync(s.blobs)) {
    if (keep.blobs.has(name)) continue;
    rmSync(join(s.blobs, name), { force: true, recursive: true });
    removed.push(`blob ${name.slice(0, 12)}`);
  }
  for (const r of removed) d.log(`tool cache: removed ${r}`);
  return { removed, failed };
}
