// Where v3's shared root state lives. Kept here, apart from config.ts's Paths, so the packages that
// add state add it beside these without editing config.ts. root is "/" on the box and a temporary
// folder in tests, as config.ts paths() takes it.
import { dirname, join } from "node:path";

export interface RootState {
  dir: string; // /opt/taskbox-state: root's, 755
  approvers: string; // root's, 644: the pinned approver keys (approvers.ts)
  nonces: string; // root's, 644: one nonce per subject (nonces.ts)
  pending: string; // root's, 644: lasting changes waiting for confirm (pending.ts)
  control: string; // root's, 644: the box's availability (availability.ts)
  outcomes: (spool: string) => string; // root's folder at 711 per spool, one 644 file per request's outcome (spool.ts)
  ops: string; // root's ops, one file each (ops.ts)
  events: string; // root's event log, one file a day (events.ts)
  admins: string; // root's, 600: which admin did what, by event id (events.ts)
  agentSpool: string; // the agent account's, 700 (spool.ts)
  serviceSpool: string; // the service account's, 700
  adminSpool: string; // root's, 700: an admin's requests at the box, run as root
  poolSpool: (n: number) => string; // each pool account's, 700
}

export const rootState = (root: string): RootState => rootStateIn(join(root, "opt/taskbox-state"));
// The same, from config.ts's Paths, whose install ID sits in the state folder.
export const rootStateOf = (p: { installId: string }): RootState => rootStateIn(dirname(p.installId));

export function rootStateIn(dir: string): RootState {
  return {
    dir,
    approvers: join(dir, "approvers.json"),
    nonces: join(dir, "nonces.json"),
    pending: join(dir, "pending.json"),
    control: join(dir, "control.json"),
    outcomes: (spool: string) => {
      if (!/^(agent|service|admin|pool-[1-9][0-9]?)$/.test(spool)) throw new Error("not a spool's name");
      return join(dir, "outcomes", spool);
    },
    ops: join(dir, "ops"),
    events: join(dir, "events"),
    admins: join(dir, "admins.jsonl"),
    agentSpool: join(dir, "agent-spool"),
    serviceSpool: join(dir, "service-spool"),
    adminSpool: join(dir, "admin-spool"),
    poolSpool: (n: number) => {
      if (!Number.isSafeInteger(n) || n < 1 || n > 99) throw new Error("not a pool account's number");
      return join(dir, "pool-spool", String(n));
    },
  };
}

// The loop's own records, in the service account's state folder (config.ts Paths.state).
export interface LoopState {
  ops: string;
  events: string;
}
export function loopState(serviceState: string): LoopState {
  return { ops: join(serviceState, "ops"), events: join(serviceState, "events") };
}
