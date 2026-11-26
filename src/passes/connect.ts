// The runner group's allowed workflows, kept true by the guard each hour through the GitHub key
// keeper's guard socket: a drift is put back and written as connect.group-corrected. The list comes
// from the settings' runner group workflows; an empty list leaves the group as the owner set it. By the
// one writer only, and only once the keeper is on the box.
import { brokerHere, askerFor, type Asker } from "../broker.ts";
import type { Config } from "../config.ts";
import { eventLog, type EventLog } from "../core/events.ts";
import { everyPass, type PassMaker } from "../core/passes.ts";
import { rootStateOf } from "../core/paths.ts";
import { brokerPathsOf } from "../keys.ts";

export const GROUP_PASS_MS = 60 * 60_000;

// The patterns the settings give, or none until the settings carry them.
export function workflowsOf(cfg: Config): string[] {
  const w = (cfg as unknown as { runnerGroupWorkflows?: unknown }).runnerGroupWorkflows;
  return Array.isArray(w) ? w.filter((x): x is string => typeof x === "string") : [];
}

export async function groupPass(ask: Asker, cfg: Config, events: Pick<EventLog, "write">, log: (l: string) => void): Promise<string> {
  const a = await ask({ ask: "group-workflows", workflows: workflowsOf(cfg) });
  if (!a.ok) {
    log(`the runner group's workflows couldn't be checked: ${a.why}`);
    return "unchecked";
  }
  const did = String((a as { did?: unknown }).did);
  if (did === "corrected") {
    const before = (a as { before?: { workflows?: string[] } }).before?.workflows?.length ?? 0;
    events.write({ type: "connect.group-corrected", actor: "taskbox", subject: "box", text: `The runner group's allowed workflows were put back to the settings' ${workflowsOf(cfg).length} (GitHub had ${before}).` });
    log("put the runner group's allowed workflows back to the settings");
  }
  if ((a as { allowsPublic?: unknown }).allowsPublic === true) log("the runner group allows public repositories: the Runner group row fails");
  return did;
}

export const connectPass: PassMaker = {
  name: "runner-group",
  make(c) {
    if (!c.writer) return undefined;
    const b = brokerPathsOf(c.p);
    const events = eventLog("guard", { dir: rootStateOf(c.p).events, owner: c.rootUid ?? 0 }, c.sys);
    return everyPass("runner-group", "after", GROUP_PASS_MS, async () => {
      if (!brokerHere(b.guardSocket)) return;
      await groupPass(askerFor(b.guardSocket), c.cfg, events, (l) => c.log.write(l));
    });
  },
};
