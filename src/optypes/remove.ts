// remove: an admin at the box starts it, and it can't be cancelled.
import type { OpDecl } from "./decl.ts";

export const optypes: OpDecl[] = [
  {
    type: "remove",
    phases: ["confirm", "services", "images", "tailscale", "files", "accounts"],
    pointOfNoReturn: "services",
    cancellable: false,
    onBoot: () => "fail",
    who: ["admin"],
    wayBack: "It can only finish: taskbox remove again carries on from where it stopped.",
  },
];
