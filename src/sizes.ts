// Sizes by label, as people read them: each kind's sizes, the VMs' budget, what fits beside the VMs
// up now, the mixes that fit, and the size suggestions (usage.ts). taskbox size list and the "Sizes"
// row in taskbox check show them. Nothing here starts or stops a VM: the scheduler does (scheduler.ts).
import { type Budget, budgetOf, capOf, type Config, type Kind, kindCapOf as kindCap, KIND_WORD, kindsOf, type Size, sizeOf, sizesOf, vmsAtMostOf } from "./config.ts";
import type { SizeShape, UsageRun } from "./usage.ts";
import { jobUsage, jobUsageLines } from "./usage.ts";

export interface SizeRow {
  kind: Kind;
  name: string;
  labels: string[];
  cpus: number;
  memoryMB: number;
  cap: number;
  fits: boolean; // it fits the whole budget alone
  fitsNow?: boolean; // one more fits beside the VMs up now; absent when the budget isn't known
}
export interface SizesView {
  budget: Budget;
  totalGB?: number; // the Mac's memory, hw.memsize / 1e9
  vmsAtMost: number;
  sizes: SizeRow[];
  up: { kind: Kind; size: string }[];
  mixes: { kind: Kind; size: string; n: number }[][];
}

// GB is MB / 1024, the sizes' own unit, on every screen.
const gb = (mb: number) => (mb / 1024).toFixed(1);
const gib = (mb: number) => Math.round(mb / 1024);
export const sizeName = (r: { kind: Kind; name: string }) => (r.name === "default" ? `${KIND_WORD[r.kind]} default` : `${KIND_WORD[r.kind]} ${r.name}`);
const all = (cfg: Config): { kind: Kind; s: Size }[] => kindsOf(cfg).flatMap((k) => sizesOf(cfg, k).map((s) => ({ kind: k, s })));

// up: the VMs up now, by kind and size, from the loop's state.
export function sizesView(cfg: Config, totalGB: number | undefined, logicalCpus: number | undefined, up: { kind: Kind; size: string }[] = []): SizesView {
  const budget = budgetOf(cfg, totalGB, logicalCpus);
  const n = vmsAtMostOf(cfg);
  const known = budget.memoryMB !== undefined;
  const fit = (memoryMB: number, cpus: number) => known && memoryMB <= budget.memoryMB! && (budget.cpus === undefined || cpus <= budget.cpus);
  const held = up.reduce((a, u) => ({ mem: a.mem + sizeOf(cfg, u.kind, u.size).vmMemoryMB, cpus: a.cpus + sizeOf(cfg, u.kind, u.size).vmCpus }), { mem: 0, cpus: 0 });
  const rows = all(cfg).map(({ kind, s }) => {
    const cap = capOf(s, budget, n);
    const count = (pred: (u: { kind: Kind; size: string }) => boolean) => up.filter(pred).length;
    const capsOk = up.length < n && count((u) => u.kind === kind) < kindCap(kind, n) && count((u) => u.kind === kind && u.size === s.name) < cap;
    return { kind, name: s.name, labels: s.labels, cpus: s.vmCpus, memoryMB: s.vmMemoryMB, cap, fits: fit(s.vmMemoryMB, s.vmCpus), ...(known ? { fitsNow: capsOk && fit(held.mem + s.vmMemoryMB, held.cpus + s.vmCpus) } : {}) };
  });
  return { budget, ...(totalGB !== undefined ? { totalGB } : {}), vmsAtMost: n, sizes: rows, up, mixes: known ? mixes(rows, budget, n) : [] };
}

// Every mix of sizes that fits the budget, the count and each cap, and that has no room for one more
// VM of any size: the most VMs first. At most 8.
export function mixes(rows: SizeRow[], budget: Budget, n: number, most = 8): { kind: Kind; size: string; n: number }[][] {
  const out: number[][] = [];
  const counts = rows.map(() => 0);
  const ok = (c: number[]) => {
    const mem = c.reduce((a, x, i) => a + x * rows[i]!.memoryMB, 0);
    const cpus = c.reduce((a, x, i) => a + x * rows[i]!.cpus, 0);
    const vms = c.reduce((a, x) => a + x, 0);
    const byKind = (k: Kind) => c.reduce((a, x, i) => a + (rows[i]!.kind === k ? x : 0), 0);
    return vms <= n && mem <= budget.memoryMB! && (budget.cpus === undefined || cpus <= budget.cpus) && c.every((x, i) => x <= rows[i]!.cap) && (["macos", "linux"] as Kind[]).every((k) => byKind(k) <= kindCap(k, n));
  };
  const walk = (i: number) => {
    if (i === rows.length) {
      if (counts.some((x) => x) && rows.every((_, j) => !ok(counts.map((x, k) => (k === j ? x + 1 : x))))) out.push([...counts]);
      return;
    }
    for (let x = 0; x <= rows[i]!.cap; x++) {
      counts[i] = x;
      if (!ok(counts)) break;
      walk(i + 1);
    }
    counts[i] = 0;
  };
  walk(0);
  const total = (c: number[]) => c.reduce((a, x) => a + x, 0);
  return out
    .sort((a, b) => total(b) - total(a))
    .slice(0, most)
    .map((c) => c.flatMap((x, i) => (x ? [{ kind: rows[i]!.kind, size: rows[i]!.name, n: x }] : [])));
}

// The budget line: "VMs get 22.4 GB and 10 CPUs, at most 5 at once."
export function budgetLine(v: SizesView): string {
  if (v.budget.memoryMB === undefined) return `The box can't read its memory, so no VM starts beside another. At most ${v.vmsAtMost} at once.`;
  return `VMs get ${gb(v.budget.memoryMB)} GB${v.budget.cpus !== undefined ? ` and ${v.budget.cpus} CPUs` : ""}, at most ${v.vmsAtMost} at once.`;
}

// The "Sizes" row: every size in one line, and a FAIL for a size that can never fit.
export function sizesRow(v: SizesView): { status: "OK" | "SKIP" | "FAIL"; detail: string } {
  const byKind = (["linux", "macos"] as Kind[])
    .map((k) => v.sizes.filter((r) => r.kind === k))
    .filter((rs) => rs.length)
    .map((rs) => `${KIND_WORD[rs[0]!.kind]} ${[...rs].sort((a, b) => a.memoryMB - b.memoryMB).map((r) => `${r.name} ${r.cpus}/${gib(r.memoryMB)} GB`).join(", ")}`)
    .join("; ");
  if (v.budget.memoryMB === undefined) return { status: "SKIP", detail: `${byKind}. ${budgetLine(v)}` };
  const big = v.sizes.filter((r) => !r.fits);
  if (big.length) return { status: "FAIL", detail: `${big.map((r) => `${sizeName(r)} needs ${gb(r.memoryMB)} GB and ${r.cpus} CPUs`).join("; ")}, more than the VMs get of this Mac's ${((v.totalGB ?? 0) * 1e9 / 1024 ** 3).toFixed(0)} GB, so its jobs wait for a size that can't fit. ${budgetLine(v)} Fix: a settings PR makes the size smaller, or lowers boxKeepsGB` };
  return { status: "OK", detail: `${byKind}. ${budgetLine(v)}` };
}

// taskbox size list, as lines.
export function sizesScreen(v: SizesView, runs: UsageRun[], cfg: Config): string[] {
  const out = ["Sizes:"];
  for (const r of v.sizes) {
    const now = r.fitsNow === undefined ? "" : r.fitsNow ? " One more fits now." : " No more fits now.";
    out.push(`  ${sizeName(r)}: ${r.cpus} CPUs, ${gib(r.memoryMB)} GB, at most ${r.cap} at once. Labels: ${r.labels.join(", ")}.${r.fits ? "" : " It can never fit."}${now}`);
  }
  out.push("", budgetLine(v));
  if (v.up.length) out.push(`Up now: ${v.up.map((u) => sizeName({ kind: u.kind, name: u.size })).join(", ")}.`);
  if (v.mixes.length) {
    out.push("", "Mixes that fit, with no room for one more:");
    for (const m of v.mixes) out.push(`  ${m.map((x) => `${x.n} ${sizeName({ kind: x.kind, name: x.size })}`).join(", ")}`);
  }
  const shapes = shapesOf(cfg);
  const lines = jobUsageLines(jobUsage(runs, shapes), shapes);
  out.push("", "Suggestions, from each job's last 20 runs with a record, from 10 runs:");
  out.push(...(lines.length ? lines.map((l) => `  ${l}`) : ["  None yet."]));
  return out;
}

export const shapesOf = (cfg: Config): SizeShape[] => all(cfg).map(({ kind, s }) => ({ kind, name: s.name, labels: s.labels, vmCpus: s.vmCpus, vmMemoryMB: s.vmMemoryMB }));

// The VMs up now, from the loop's state: each slot with a VM, by its kind and size.
export function upFromLoop(slots: Record<string, { slot?: unknown; vmKind?: unknown; size?: unknown }> | undefined): { kind: Kind; size: string }[] {
  return Object.values(slots ?? {}).flatMap((s) => ((s.vmKind === "macos" || s.vmKind === "linux") && s.slot !== "idle" ? [{ kind: s.vmKind as Kind, size: typeof s.size === "string" ? s.size : "default" }] : []));
}

// status's budget line: "VMs hold 16.0 of 21.8 GB and 8 of 10 CPUs."
export function holdsLine(budget: Budget, held: { memoryMB?: number; cpus?: number }[]): string {
  if (budget.memoryMB === undefined) return "The box can't read its memory, so no VM starts beside another.";
  const mem = held.reduce((n, h) => n + (h.memoryMB ?? 0), 0);
  const cpus = held.reduce((n, h) => n + (h.cpus ?? 0), 0);
  return `VMs hold ${gb(mem)} of ${gb(budget.memoryMB)} GB${budget.cpus !== undefined ? ` and ${cpus} of ${budget.cpus} CPUs` : ""}.`;
}
