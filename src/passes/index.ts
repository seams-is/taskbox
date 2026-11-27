// Every guard pass, in the order the guard runs them on each tick (core/passes.ts). A package with a
// pass adds a file here that exports its PassMaker, and one line below.
import type { PassMaker } from "../core/passes.ts";
import { accountsPass } from "./accounts.ts";
import { beatPass } from "./beat.ts";
import { endingPass } from "./ending.ts";
import { gpuPass } from "./gpu.ts";
import { keepingPass } from "./keeping.ts";
import { opsPass } from "./ops.ts";
import { probePass } from "./probe.ts";
import { requestsPass } from "./requests.ts";
import { v2Passes } from "./v2.ts";

export const passMakers = (): PassMaker[] => [beatPass, ...v2Passes(), probePass, endingPass, keepingPass, opsPass, accountsPass, requestsPass, gpuPass];
