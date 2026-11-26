// The accounts block (v2.7.0), in its own function, apart from the scheduling settings. The service
// account holds the App key, so it is never the agent or a person (access.ts).
import { oldKeyProblem, validateAccounts, workspacesProblem } from "../access.ts";
import type { Config } from "./core.ts";

export function checkAccounts(c: Config): void {
  const old = oldKeyProblem(c as unknown as Record<string, unknown>);
  if (old) throw new Error(old);
  if (!("accounts" in c)) throw new Error("taskbox.json: accounts names the box's accounts: { \"service\": ..., \"agent\": ..., \"people\": [...] }");
  c.accounts = validateAccounts(c.accounts);
  const ws = workspacesProblem(c);
  if (ws) throw new Error(ws);
}
