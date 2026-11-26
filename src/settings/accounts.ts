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
