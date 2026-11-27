// workspace-clear: a pool account's last agent's files deleted, when the guard gives the account to
// another agent (workspace/handover.ts), or at an admin's workspace clear. The home is moved into a
// root-only folder first, so nobody reads them while they go, and from then on it can only finish.
import type { OpDecl } from "./decl.ts";

export const optypes: OpDecl[] = [
  {
    type: "workspace-clear",
    phases: ["moving", "deleting"],
    pointOfNoReturn: "moving",
    cancellable: false,
    // Deleting goes on after a restart: the guard's next pass deletes what is left.
    onBoot: () => "resume",
    who: ["owner", "admin"],
    wayBack: "It can only finish: the files moved aside are deleted, and the account's home is empty already.",
  },
];
