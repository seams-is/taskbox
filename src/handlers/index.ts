// Every file of agent-spool request handlers, by static import, so the engine compiles to one
// binary with nothing read from disk. A package adds src/handlers/<package>.ts, which exports
// `handlers: { signed?, unsigned? }`, and one line below, sorted by file. A test checks that every
// file in this folder is named here.
import type { HandlerFile } from "../core/dispatch.ts";

export const handlerFiles: readonly HandlerFile[] = [];
