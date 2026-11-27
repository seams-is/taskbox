// Every guard pass, by static import. A package with a pass adds a file here that exports a
// PlacedMaker, one import and one line in the list below, each sorted by file. The guard runs them
// in the order each file gives (its `order`), not their place in this list.
import type { PassMaker, PlacedMaker } from "../core/passes.ts";
import { accountsPass } from "./accounts.ts";
import { beatPass } from "./beat.ts";
import { connectPass } from "./connect.ts";
import { controlPass } from "./control.ts";
import { endingPass } from "./ending.ts";
import { keepingPass } from "./keeping.ts";
import { opsPass } from "./ops.ts";
import { probePass } from "./probe.ts";
import { requestsPass } from "./requests.ts";
import { loginsPass, loopWatchPass, tailscaledPass, workspacesPass } from "./v2.ts";

const placed: readonly PlacedMaker[] = [
  accountsPass,
  beatPass,
  connectPass,
  controlPass,
  endingPass,
  keepingPass,
  opsPass,
  probePass,
  requestsPass,
  loginsPass,
  loopWatchPass,
  tailscaledPass,
  workspacesPass,
];

export const passMakers = (): PassMaker[] => {
  const orders = placed.map((m) => m.order);
  if (new Set(orders).size !== orders.length) throw new Error("two guard passes share one order");
  return [...placed].sort((a, b) => a.order - b.order);
};
