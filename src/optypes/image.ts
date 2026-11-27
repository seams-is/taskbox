// image-pull: the service account starts it at the box, and the loop pulls that kind's pinned image
// in its next free slot. Cancelling stops the download; the bytes already fetched are kept, so the
// next pull goes on from them (byLoop: the loop reads the record as the pull runs).
import type { OpDecl } from "./decl.ts";

export const optypes: OpDecl[] = [
  {
    type: "image-pull",
    phases: ["waiting", "downloading"],
    onBoot: () => "fail",
    who: ["service"],
    byLoop: true,
    wayBack: "taskbox image pull starts it again, from the bytes already fetched.",
  },
];
