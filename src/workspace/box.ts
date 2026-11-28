// What the box itself says about workspaces: whether they are on, and which pool accounts it has.
// Workspaces are on when an approver key is pinned at the box (approvers.json), the agent account is
// named, and pool.json records the pool accounts the settings name. Read the same way by the guard's
// pass, the handlers, the gate's line and the check rows.
import { poolNames } from "../access.ts";
import { uidOf } from "../accounts.ts";
import type { Config, Paths } from "../config.ts";
import { pinnedKeys, readApprovers } from "../core/approvers.ts";
import { rootStateOf } from "../core/paths.ts";
import { FIRST_HIDDEN_ID, LAST_HIDDEN_ID, readPoolRecord } from "../pin.ts";
import type { Sys } from "../sys.ts";
import { NO_KEY, POOL_USER } from "./model.ts";

export { NO_KEY };

export type PoolAccount = { name: string; uid: number };

// The pool accounts to fence: those pool.json records. A pool.json that can't be read leaves each
// account the settings name (<pool>1 to <pool><size>) that has a hidden user ID: fenced, never given
// a workspace (sure is false).
export async function poolAccounts(d: { sys: Sys; cfg: Config; p: Paths; rootUid?: number }): Promise<{ list: PoolAccount[]; sure: boolean }> {
  const rec = readPoolRecord(d.p.poolRecord, d.rootUid ?? 0);
  if (rec !== "bad") return { list: Object.entries(rec.made).filter(([n]) => POOL_USER.test(n)).map(([name, m]) => ({ name, uid: m.uid })), sure: true };
  const list: PoolAccount[] = [];
  for (const name of poolNames(d.cfg.accounts)) {
    const uid = await uidOf(d.sys, name).catch(() => undefined);
    if (uid !== undefined && uid >= FIRST_HIDDEN_ID && uid <= LAST_HIDDEN_ID) list.push({ name, uid });
  }
  return { list, sure: false };
}

// Whether an approver key is pinned at the box. A file that can't be read pins nothing.
export function keyPinned(p: Pick<Paths, "installId">, rootUid = 0): boolean {
  const a = readApprovers(rootStateOf(p).approvers, rootUid);
  return a.kind === "ok" && pinnedKeys(a.value).length > 0;
}

export type On = { on: true; pool: string[] } | { on: false; why: string; pool: [] };

// Whether workspaces are on, and the pool accounts a workspace may be given: the settings' names
// that pool.json records, in the settings' order.
export function workspacesOn(d: { cfg: Config; p: Paths; rootUid?: number }, recorded: readonly string[] | undefined): On {
  if (!keyPinned(d.p, d.rootUid ?? 0)) return { on: false, why: `${NO_KEY[0]!.toUpperCase()}${NO_KEY.slice(1)}`, pool: [] };
  if (d.cfg.accounts.agent === undefined) return { on: false, why: "This box names no agent account, so no agent can ask for a workspace.", pool: [] };
  const pool = recorded === undefined ? [] : poolNames(d.cfg.accounts).filter((n) => recorded.includes(n));
  if (!pool.length) return { on: false, why: "This box has none of its pool accounts yet. As your admin user, type taskbox update.", pool: [] };
  return { on: true, pool };
}

// The same, from pool.json alone, for the handlers, which need no user IDs.
export function onNow(d: { cfg: Config; p: Paths; rootUid?: number }): On {
  const rec = readPoolRecord(d.p.poolRecord, d.rootUid ?? 0);
  return workspacesOn(d, rec === "bad" ? undefined : Object.keys(rec.made));
}
