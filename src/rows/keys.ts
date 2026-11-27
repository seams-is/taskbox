// The key rows: "Approver keys" (is one pinned in approvers.json?) and "Retired Apps" (Apps a rotation left on GitHub,
// each with its delete link, for RETIRED_DAYS).
import type { Check, CheckContext } from "../checks.ts";
import { appPage } from "../connect.ts";
import { readApprovers } from "../core/approvers.ts";
import { rootStateOf } from "../core/paths.ts";
import type { Row, RowFn } from "../core/rows.ts";
import { readRetired, RETIRED_DAYS, retiredPath } from "../keyrotate.ts";

type Out = Omit<Check, "name">;

export async function approverRow(c: CheckContext): Promise<Out> {
  const a = readApprovers(rootStateOf(c.paths).approvers, c.rootUid ?? 0);
  if (a.kind === "bad") return { status: "FAIL", detail: `approvers.json can't be read (${a.why}), so no signed request applies. At the box: as your admin user, taskbox key reset approver, then taskbox key trust approver` };
  if (a.kind === "missing" || !a.value.keys.length) return { status: "SKIP", detail: "no approver key is pinned, so owner-signed commands and workspaces wait. At the box: as your admin user, taskbox key trust approver" };
  return { status: "OK", detail: `${a.value.keys.length} pinned: ${a.value.keys.map((k) => k.fingerprint).join(", ")}` };
}

export async function retiredRow(c: CheckContext): Promise<Out> {
  const now = c.sys.now();
  const left = readRetired(retiredPath(rootStateOf(c.paths).dir), c.rootUid ?? 0).filter((r) => now - r.at < RETIRED_DAYS * 86_400_000);
  if (!left.length) return { status: "OK", detail: "no App a rotation retired is left on GitHub" };
  return { status: "FAIL", detail: `a rotation retired ${left.map((r) => `${r.slug} (App ${r.appId})`).join(", ")}, and GitHub keeps ${left.length === 1 ? "it" : "them"} until you delete ${left.length === 1 ? "it" : "them"}: ${left.map((r) => `${appPage(c.cfg.org, r.slug)}/advanced`).join(", ")}` };
}

export const KEY_ROWS: Row[] = [
  { name: "Approver keys", fn: approverRow as RowFn, order: 8160, in: ["check"] },
  { name: "Retired Apps", fn: retiredRow as RowFn, order: 8170, in: ["check"] },
];
