// Every handler of the agent spool's requests (core/dispatch.ts). A package that takes a signed
// action or an unsigned kind adds a file here that exports its handler, and one line below; the
// dispatcher is never edited. Signed handlers are named by the command's action (job.cancel); the
// command then lists --signed in its flags, so the agent shell carries it.
import type { Handlers } from "../core/dispatch.ts";

export const requestHandlers = (): Handlers => ({ signed: [], unsigned: [] });
