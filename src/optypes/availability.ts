// drain and stop: the owner from the controller, or the service account at the box, starts them, and
// they are cancelled as resume and start cancel them (the one cancel grammar). After a restart they
// carry on: control.json, on disk, still says draining.
import type { OpDecl } from "./decl.ts";

const cancel = (verb: "resume" | "start"): OpDecl["cancel"] => async (c, op, actor) => (await import("../availability.ts")).cancelControlOp(c, op, verb, actor);

export const optypes: OpDecl[] = [
  { type: "drain", phases: ["draining", "forcing"], onBoot: () => "resume", who: ["owner", "service"], wayBack: "taskbox resume ends it.", cancel: cancel("resume") },
  { type: "stop", phases: ["draining", "forcing"], onBoot: () => "resume", who: ["owner", "service"], wayBack: "taskbox start ends it.", cancel: cancel("start") },
];
