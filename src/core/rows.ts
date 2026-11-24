// The check-row registry. Every row taskbox checks is one entry: its name, its function, where it
// runs, and its place. A package that adds a row adds a file of rows (src/rows/) and one line in
// src/rows/index.ts, and never edits checks.ts, the loop or the install. Where a row runs:
// - prestart: before every VM start (the loop), and so in check and away too, as before;
// - check: `taskbox check`;
// - away: `taskbox check --away` (v2's `taskbox away`);
// - preflight: before an install, as root.
// Rows run in order, lowest first; two rows in one place never share a name or a number.
import type { Check, CheckContext } from "../checks.ts";

export type RowFn = (c: CheckContext) => Promise<Omit<Check, "name">>;
export const PLACES = ["prestart", "check", "away", "preflight"] as const;
export type Place = (typeof PLACES)[number];

export interface Row {
  name: string;
  fn: RowFn;
  order: number;
  in: readonly Place[];
  when?: (c: CheckContext) => boolean; // runs only when this is true, such as only with a load repo
}

// The rows for one place, in order, as runChecks takes them. With no context, rows with a when are
// left out.
export function rowsFor(rows: readonly Row[], place: Place, c?: CheckContext): [string, RowFn][] {
  return rows
    .filter((r) => r.in.includes(place) && (r.when === undefined || (c !== undefined && r.when(c))))
    .sort((a, b) => a.order - b.order)
    .map((r) => [r.name, r.fn]);
}

// Why a list of rows can't be used, or undefined: a name or a number twice in one place.
export function rowsProblem(rows: readonly Row[]): string | undefined {
  for (const place of PLACES) {
    const here = rows.filter((r) => r.in.includes(place));
    const names = new Set<string>();
    const orders = new Set<number>();
    for (const r of here) {
      if (!Number.isSafeInteger(r.order) || r.order < 0) return `the row ${r.name} has no place`;
      if (names.has(r.name)) return `two rows in ${place} are named ${r.name}`;
      if (orders.has(r.order)) return `two rows in ${place} have the place ${r.order}`;
      names.add(r.name);
      orders.add(r.order);
    }
  }
  return undefined;
}

// Rows from a v2 list, numbered from base in steps of 10, so a later row can sit between two.
export const numbered = (list: readonly (readonly [string, RowFn])[], base: number, places: readonly Place[]): Row[] => list.map(([name, fn], i) => ({ name, fn, order: base + i * 10, in: places }));
