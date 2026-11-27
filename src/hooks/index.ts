// Every job hook, in the order the loop runs them (core/hooks.ts). A package with a hook adds a file
// here that exports its JobHook, and one line below.
import type { JobHook } from "../core/hooks.ts";
import { identityHook } from "./identity.ts";
import { measureHook } from "./measure.ts";
import { netHook } from "./net.ts";

export const jobHooks = (): JobHook[] => [identityHook, measureHook(), netHook];
