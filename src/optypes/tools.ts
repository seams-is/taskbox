// tool-refresh: the service account starts it at the box, and the loop runs it. The loop reads the
// op's record before each step, so the service account cancels it by ending that record (byLoop).
import type { OpDecl } from "./decl.ts";

export const optypes: OpDecl[] = [
  {
    type: "tool-refresh",
    phases: ["waiting", "verifying", "fetching", "building", "baking", "cleaning"],
    // A restart drops the request with the op: the loop's start runs the pass anyway.
    onBoot: () => "fail",
    who: ["service"],
    byLoop: true,
    wayBack: "taskbox tool refresh starts it again; the pins never change.",
  },
];
