// The access model's rows: "Accounts", the accounts as taskbox placed them, and "Tailnet policy",
// the SSH rules the tailnet sent this box beside what the settings give now.
import { openWindow } from "../settings/adminssh.ts";
import { poolOf, SYSTEM_USERS } from "../access.ts";
import { idsShared, otherTaskboxShells, ownAccess, readRecord, systemProblem, uidOf } from "../accounts.ts";
import { trustedKey } from "../approver.ts";
import type { Check, CheckContext } from "../checks.ts";
import { REMOTE_SHELL, tagOf } from "../config.ts";
import type { Row } from "../core/rows.ts";
import { readPin, readPoolRecord } from "../pin.ts";
import { policyFor } from "../policy.ts";

type Out = Omit<Check, "name">;
const ok = (detail: string): Out => ({ status: "OK", detail });
const fail = (detail: string): Out => ({ status: "FAIL", detail });
// No WARN: version 3 of the answers, which older controllers read, has OK, FAIL and SKIP only.
const skip = (detail: string): Out => ({ status: "SKIP", detail });
const UPDATE = "As your admin user, type taskbox update.";

export async function accountsRow(c: CheckContext): Promise<Out> {
  const a = c.cfg.accounts;
  const rec = readRecord(c.paths.accountsRecord);
  // A new service account means a reinstall: the loop's state and Tart's images are in the old one's home.
  const inUse = rec.inUse?.service;
  if (inUse !== undefined && inUse !== a.service) {
    return fail(`taskbox.json names ${a.service} as the service account, but this box runs as ${inUse}. A new service account means a reinstall: at the box, as your admin user, type taskbox remove, then install again with ${a.service} in accounts.service`);
  }
  const fails: string[] = [];
  const notes: string[] = [];
  // Any account with the agent's shell but the agent: Tailscale SSH reaching it would reach taskbox.
  const shells = await otherTaskboxShells(c.sys, REMOTE_SHELL, a.agent);
  if (shells === undefined) fails.push("taskbox can't list the box's login shells");
  else for (const n of shells) fails.push(`${n} has taskbox's shell and isn't the agent. ${UPDATE}`);
  // The agent taskbox made: no other user or group may share its IDs. One made before its own group
  // came is in staff, which is said.
  const ag = a.agent !== undefined ? rec.made[a.agent] : undefined;
  if (a.agent !== undefined && ag && (await uidOf(c.sys, a.agent)) === ag.uid) {
    const why = await idsShared(c.sys, a.agent, ag.uid, rec.groups?.[a.agent]?.gid);
    if (why) fails.push(why);
    if (!rec.groups?.[a.agent]) notes.push(`${a.agent} is in staff, as agents made before taskbox gave each its own group are`);
  }
  // taskbox's own accounts, once the install has made them.
  for (const name of SYSTEM_USERS) {
    if (!rec.made[name] && (await uidOf(c.sys, name)) === undefined) {
      notes.push(`${name} isn't made yet; the next taskbox update makes it`);
      continue;
    }
    const why = await systemProblem(c.sys, rec, name, c.uid === 0);
    if (why) fails.push(why);
  }
  // People taskbox made or put on Screen Sharing's list that accounts.people no longer names: their
  // accounts and files stay, for the owner to delete.
  const lower = a.people.map((p) => p.toLowerCase());
  const left = new Set([...Object.entries(rec.made).filter(([, m]) => m.role === "person").map(([n]) => n), ...(rec.screenSharing?.added ?? [])]);
  for (const n of left) {
    if (lower.includes(n.toLowerCase()) || (await uidOf(c.sys, n)) === undefined) continue;
    notes.push(`${n} is no longer in accounts.people, so it has no Screen Sharing or Tailscale SSH, and keeps its files. Delete it in System Settings, Users & Groups, if you want`);
  }
  if (fails.length) return fail(fails.join("; "));
  // Shown, never failed: nothing here reaches the box.
  return ok([`${a.service} runs the loop; only ${a.agent ?? "no account"} has taskbox's shell`, ...notes].join("; "));
}

// The SSH rules in a netmap, as each local user's modes: accept, or check (Tailscale's
// holdAndDelegate). "*" stands for a rule open to any user. undefined when the netmap has no SSHPolicy key.
export function liveSshUsers(netmap: unknown): Map<string, Set<"accept" | "check">> | undefined {
  if (!netmap || typeof netmap !== "object" || !("SSHPolicy" in netmap)) return undefined;
  const out = new Map<string, Set<"accept" | "check">>();
  const pol = (netmap as { SSHPolicy?: { rules?: unknown } | null }).SSHPolicy;
  // null is no rules; anything else must have its rules where taskbox reads them, or it can't be read.
  if (pol !== null && !(pol && typeof pol === "object" && (pol.rules === undefined || pol.rules === null || Array.isArray(pol.rules)))) return undefined;
  const rules = pol && Array.isArray(pol.rules) ? pol.rules : [];
  for (const r of rules) {
    if (!r || typeof r !== "object") continue;
    const { action, sshUsers } = r as { action?: { accept?: unknown; reject?: unknown; holdAndDelegate?: unknown }; sshUsers?: unknown };
    if (!action || action.reject === true) continue;
    const mode = typeof action.holdAndDelegate === "string" && action.holdAndDelegate !== "" ? "check" : action.accept === true ? "accept" : undefined;
    if (!mode || !sshUsers || typeof sshUsers !== "object") continue;
    for (const [asked, local] of Object.entries(sshUsers as Record<string, unknown>)) {
      if (typeof local !== "string" || local === "") continue;
      const user = local === "=" ? asked : local;
      out.set(user, (out.get(user) ?? new Set()).add(mode));
    }
  }
  return out;
}

// What the settings give now, beside what the tailnet sent: one phrase per difference.
export function policyDiff(live: Map<string, Set<"accept" | "check">>, want: { accept: readonly string[]; check: readonly string[] }): string[] {
  const out: string[] = [];
  const shown = (n: string) => n.replace(/[^\x21-\x7e]/g, "").slice(0, 32);
  for (const [user, modes] of [...live].sort(([x], [y]) => (x < y ? -1 : 1))) {
    const should = want.accept.includes(user) ? "accept" : want.check.includes(user) ? "check" : undefined;
    if (user === "*") out.push("a rule lets any user in");
    else if (!should) out.push(`${shown(user)} is let in, and the settings name nobody by that name`);
    else if (modes.size > 1 || !modes.has(should)) out.push(`${shown(user)} is let in by ${[...modes].sort().join(" and ")}, where the settings say ${should} alone`);
  }
  for (const user of [...want.accept, ...want.check]) if (!live.has(user)) out.push(`${shown(user)} isn't let in`);
  return out;
}

export async function tailnetPolicyRow(c: CheckContext): Promise<Out> {
  // Only root and the service account can ask tailscaled (the Tailscale row says so for others).
  if (c.uid !== 0 && (c.serviceUid === undefined || c.uid !== c.serviceUid)) return { status: "SKIP", detail: "only the service account can read the tailnet's rules for this box" };
  // No credential: the rules the tailnet sent this node. The netmap is read here and never kept.
  const r = await c.sys.run(c.paths.tailscale, [`--socket=${c.paths.tailscaleSocket}`, "debug", "netmap"], { timeoutMs: 10_000 }).catch(() => ({ code: -1, stdout: "", stderr: "" }));
  let netmap: unknown;
  try {
    netmap = r.code === 0 ? JSON.parse(r.stdout) : undefined;
  } catch {}
  const live = liveSshUsers(netmap);
  if (!live) return skip("taskbox can't see the tailnet's SSH rules for this box, so it can't compare them with the settings. On the controller, type taskbox policy show --box all, and check what you pasted");
  // Only the accounts taskbox made get accept, as in policy show.
  const own = await ownAccess(c.sys, c.cfg.accounts.agent, poolOf(c.cfg.accounts, trustedKey(c.cfg.approverKey, readPin(c.paths.approverPin, c.rootUid ?? 0))), readRecord(c.paths.accountsRecord), readPoolRecord(c.paths.poolRecord, c.rootUid ?? 0));
  if ("refuse" in own) return fail(`${own.refuse}. As your admin user, type taskbox update`);
  const accounts = { ...c.cfg.accounts };
  if (own.agent === undefined) delete accounts.agent;
  const temp = openWindow(c.cfg.adminSsh, c.sys.now());
  const want = policyFor(accounts, { tag: tagOf(c.cfg), ...(temp ? { adminSsh: temp } : {}) }, own.pool).ssh;
  const users = (action: string) => want.filter((x) => x.action === action).flatMap((x) => x.users as string[]);
  const diff = policyDiff(live, { accept: users("accept"), check: users("check") });
  if (diff.length) return fail(`the tailnet's rules for this box differ from the settings (${diff.slice(0, 4).join("; ")}): on the controller, type taskbox policy show --box all, then paste it`);
  return ok("the tailnet's SSH rules for this box are the settings'");
}

// Beside the service account's row (2050) and the Tailscale row.
export const ACCOUNT_ROWS: Row[] = [
  { name: "Accounts", fn: accountsRow, order: 2055, in: ["check", "away"] },
  { name: "Tailnet policy", fn: tailnetPolicyRow, order: 2075, in: ["check", "away"] },
];
