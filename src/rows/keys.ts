// The key rows: "Keys" (each key's age, and past keys.maxAgeDays, due to rotate), "Approver keys" (is one pinned in approvers.json?) and "Retired Apps" (Apps a rotation left on GitHub,
// each with its delete link, for RETIRED_DAYS).
import type { Check, CheckContext } from "../checks.ts";
import { appPage } from "../connect.ts";
import { readApprovers } from "../core/approvers.ts";
import { rootStateOf } from "../core/paths.ts";
import type { Row, RowFn } from "../core/rows.ts";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { keptApp } from "../connectflow.ts";
import { brokerPathsOf, keyFileName } from "../keys.ts";
import { readRetired, RETIRED_DAYS, retiredPath } from "../keyrotate.ts";
import { maxAgeDaysOf } from "../settings/keys.ts";

type Out = Omit<Check, "name">;

export async function approverRow(c: CheckContext): Promise<Out> {
  const a = readApprovers(rootStateOf(c.paths).approvers, c.rootUid ?? 0);
  if (a.kind === "bad") return { status: "FAIL", detail: `approvers.json can't be read (${a.why}), so no signed request applies. At the box: as your admin user, taskbox key reset approver, then taskbox key trust approver` };
  if (a.kind === "missing" || !a.value.keys.length) return { status: "SKIP", detail: "no approver key is pinned, so signed commands and workspaces wait. At the box: as your admin user, taskbox key trust approver" };
  return { status: "OK", detail: `${a.value.keys.length} pinned: ${a.value.keys.map((k) => k.fingerprint).join(", ")}` };
}

export async function retiredRow(c: CheckContext): Promise<Out> {
  const now = c.sys.now();
  const left = readRetired(retiredPath(rootStateOf(c.paths).dir), c.rootUid ?? 0).filter((r) => now - r.at < RETIRED_DAYS * 86_400_000);
  if (!left.length) return { status: "OK", detail: "no App a rotation retired is left on GitHub" };
  return { status: "FAIL", detail: `a rotation retired ${left.map((r) => `${r.slug} (App ${r.appId})`).join(", ")}, and GitHub keeps ${left.length === 1 ? "it" : "them"} until you delete ${left.length === 1 ? "it" : "them"}: ${left.map((r) => `${appPage(c.cfg.org, r.slug)}/advanced`).join(", ")}` };
}

// Each key's age in days: the App keys' from their files (root and the keeper see them), the
// approver keys' from when they were pinned. A key whose age can't be read is left out.
export function keyAges(c: CheckContext): { key: string; days: number }[] {
  const now = c.sys.now();
  const days = (ms: number) => Math.max(0, Math.floor((now - ms) / 86_400_000));
  const out: { key: string; days: number }[] = [];
  for (const role of ["runner", "source"] as const) {
    const k = keptApp(c.cfg, role);
    if (!k) continue;
    try {
      out.push({ key: role, days: days(lstatSync(join(brokerPathsOf(c.paths).keys, keyFileName(role, k.appId))).mtimeMs) });
    } catch {}
  }
  const a = readApprovers(rootStateOf(c.paths).approvers, c.rootUid ?? 0);
  if (a.kind === "ok") for (const k of a.value.keys) out.push({ key: `approver ${k.fingerprint.slice(7, 15)}`, days: days(k.pinnedAt) });
  return out;
}

export async function keysRow(c: CheckContext): Promise<Out> {
  const ages = keyAges(c);
  const max = maxAgeDaysOf(c.cfg);
  if (!ages.length) return { status: "SKIP", detail: "no key's age can be read by this user: run taskbox check as your admin user" };
  const line = ages.map((a) => `${a.key} ${a.days} day${a.days === 1 ? "" : "s"}`).join(", ");
  const old = max > 0 ? ages.filter((a) => a.days > max) : [];
  if (!old.length) return { status: "OK", detail: max > 0 ? `${line}; each rotates past ${max} days` : line };
  return { status: "FAIL", detail: `${old.map((a) => a.key).join(", ")} ${old.length === 1 ? "is" : "are"} past keys.maxAgeDays, ${max}: ${line}. From the controller: taskbox key rotate ${old[0]!.key.split(" ")[0]}` };
}

export const KEY_ROWS: Row[] = [
  { name: "Keys", fn: keysRow as RowFn, order: 8155, in: ["check"] },
  { name: "Approver keys", fn: approverRow as RowFn, order: 8160, in: ["check"] },
  { name: "Retired Apps", fn: retiredRow as RowFn, order: 8170, in: ["check"] },
];
