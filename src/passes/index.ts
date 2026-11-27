// Every guard pass, in the order the guard runs them on each tick (core/passes.ts). A package with a
// pass adds a file here that exports its PassMaker, and one line below.
import type { PassMaker } from "../core/passes.ts";
import { accountsPass } from "./accounts.ts";
import { beatPass } from "./beat.ts";
import { connectPass } from "./connect.ts";
import { controlPass } from "./control.ts";
import { endingPass } from "./ending.ts";
import { gpuPass } from "./gpu.ts";
import { pfStartsPass } from "../pfstarts.ts";
import { keepingPass } from "./keeping.ts";
import { opsPass } from "./ops.ts";
import { probePass } from "./probe.ts";
import { requestsPass } from "./requests.ts";
import { settingsPass } from "./settings.ts";
import { updatePass } from "./update.ts";
import { v2Passes } from "./v2.ts";

export const passMakers = (): PassMaker[] => [beatPass, ...v2Passes(), probePass, endingPass, keepingPass, updatePass, opsPass, accountsPass, requestsPass, controlPass, connectPass, gpuPass, pfStartsPass, settingsPass];
