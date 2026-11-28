// migrate-v3 (migrate/run.ts): the move from v2.6.1, begun by the guard itself after the hop. Nobody
// starts or cancels it: its way back is v2.6.1's rollback watcher. A restart of the box resumes it,
// since every step is idempotent and its journal says where it got to.
import { MIGRATE_PHASES } from "../migrate/run.ts";
import type { OpDecl } from "./decl.ts";

export const optypes: OpDecl[] = [
  {
    type: "migrate-v3",
    phases: MIGRATE_PHASES,
    cancellable: false,
    onBoot: () => "resume",
    who: ["admin"],
    wayBack: "v2.6.1's rollback watcher takes the box back if v3 isn't proved by its deadline.",
  },
];
