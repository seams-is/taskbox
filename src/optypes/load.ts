// load: a load test session, begun by the owner's signed load start (handlers/load.ts, loadop.ts).
// load stop is its named opposite, and op cancel ends it the same way. After a restart it carries
// on: the session in root's load.json still names its end.
import type { OpDecl } from "./decl.ts";

export const optypes: OpDecl[] = [
  {
    type: "load",
    phases: ["running"],
    onBoot: () => "resume",
    who: ["owner", "service"],
    wayBack: "taskbox load stop ends it.",
    cancel: async (c, op, actor) => (await import("../loadop.ts")).cancelLoadOp(c, op, actor),
  },
];
