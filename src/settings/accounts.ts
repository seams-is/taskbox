// The accounts block (v2.7.0), in its own function, apart from the scheduling settings. The service
// account holds the App key, so it is never the agent or a person (access.ts).
import { oldKeyProblem, validateAccounts, workspacesProblem } from "../access.ts";
import { TAILNET_TAG_SHAPE } from "../config.ts";
import type { Config } from "./core.ts";

export function checkAccounts(c: Config): void {
  const old = oldKeyProblem(c as unknown as Record<string, unknown>);
  if (old) throw new Error(old);
  if (!("accounts" in c)) throw new Error("taskbox.json: accounts names the box's accounts: { \"service\": ..., \"agent\": ..., \"people\": [...] }");
  c.accounts = validateAccounts(c.accounts);
  const ws = workspacesProblem(c);
  if (ws) throw new Error(ws);
  // The box's own tag, which the policy, the install's sign-in and the Tailscale row all use.
  if ("tailnetTag" in c && (typeof c.tailnetTag !== "string" || c.tailnetTag.length > 64 || !TAILNET_TAG_SHAPE.test(c.tailnetTag))) throw new Error("taskbox.json: tailnetTag is tag:taskbox, or tag:taskbox- then lowercase letters and digits, such as tag:taskbox-studio");
}

// The access model's guarded keys, first tier (reach and trust): a merged change to one waits for
// the owner's settings apply and then the box's own confirm. tailnetTag is here because it decides
// which of the tailnet's rules reach the box. The settings op reads this list and enforces it.
export const REACH_KEYS = ["accounts.service", "accounts.agent", "accounts.ssh", "accounts.people", "accounts.workspaces", "tailnetTag"] as const;
