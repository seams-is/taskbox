// Every job hook, by static import (core/hooks.ts). A package with a hook adds a file here that
// exports a PlacedHook, one import and one line in the list below, each sorted by file. The loop runs
// them in the order each file gives (its `order`), not their place in this list.
import type { JobHook, PlacedHook } from "../core/hooks.ts";
import { identityHook } from "./identity.ts";
import { measureHook } from "./measure.ts";
import { netHook } from "./net.ts";

const placed: readonly PlacedHook[] = [
  identityHook,
  measureHook(),
  netHook,
];

export const jobHooks = (): JobHook[] => {
  const orders = placed.map((h) => h.order);
  if (new Set(orders).size !== orders.length) throw new Error("two job hooks share one order");
  return [...placed].sort((a, b) => a.order - b.order);
};
