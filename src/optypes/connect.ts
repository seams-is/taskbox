// connect: the owner (from the controller) or an admin at the box starts it. A cancel ends the op,
// then drops what it left pending: an App made and not kept is uninstalled with its own key, and its
// key and record go (connectflow.ts cancelConnect). It can't be cancelled once it keeps.
import type { OpDecl } from "./decl.ts";

export const CONNECT_PHASES = ["making-runner", "installing-runner", "making-source", "installing-source", "keeping"];

export const optypes: OpDecl[] = [
  {
    type: "connect",
    phases: CONNECT_PHASES,
    pointOfNoReturn: "keeping",
    cancellable: true,
    // A restart fails it; the next connect finds a pending App again.
    onBoot: () => "fail",
    who: ["owner", "admin"],
    wayBack: "It is keeping its Apps already: taskbox connect status shows them once it ends.",
    async cancel(c, op, actor) {
      const { endAsCancelled } = await import("../opcancel.ts");
      const ended = await endAsCancelled(c, op, actor);
      if (!ended.ok) return ended;
      // The guard's cleanup pass does the same each full pass, so a keeper not up now loses nothing.
      const { cancelPending } = await import("../connectflow.ts");
      const lines = await cancelPending(c, op.id).catch(() => [] as string[]);
      return { ...ended, said: [ended.said, ...lines].join(" ").slice(0, 400) };
    },
  },
];
