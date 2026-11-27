// selftest-run: the service account starts it at the box, and the loop runs the Linux selftest (the
// Softnet proof, proof.ts) in its next free slot. The loop reads the record before each step, so the
// service account cancels it by ending that record (byLoop).
import type { OpDecl } from "./decl.ts";

export const optypes: OpDecl[] = [
  {
    type: "selftest-run",
    phases: ["waiting", "proving"],
    // A restart drops the ask with the op: the loop proves again by itself after its start.
    onBoot: () => "fail",
    who: ["service"],
    byLoop: true,
    wayBack: "taskbox selftest run starts it again.",
  },
];
