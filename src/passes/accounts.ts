// The service account, every full pass: when accounts.service has no account, the loop can't run
// or write its own state, so the guard says so in root's event log, once until the account is back.
// The "Service account" row fails meanwhile. By the one writer only.
import { eventLog } from "../core/events.ts";
import { everyPass, type PlacedMaker } from "../core/passes.ts";
import { rootStateOf } from "../core/paths.ts";
import { GUARD_FULL_MS } from "../guard.ts";

export const accountsPass: PlacedMaker = {
  name: "accounts",
  order: 700,
  make(c) {
    if (!c.writer) return undefined;
    const events = eventLog("guard", { dir: rootStateOf(c.p).events, owner: c.rootUid ?? 0 }, c.sys);
    let missing = false;
    return everyPass("accounts", "after", GUARD_FULL_MS, async () => {
      const name = c.cfg.accounts.service;
      const r = await c.sys.run("/usr/bin/id", ["-u", name], { timeoutMs: 5_000 });
      // Only a plain "no such user" counts as missing; anything else is a lookup that failed.
      const gone = r.code !== 0 && /no such user/i.test(r.stderr);
      if (gone && !missing) {
        events.write({ type: "guard.service-missing", subject: name, actor: "guard", text: `The service account ${name} isn't on this Mac, so the loop can't run. As your admin user, type taskbox update.` });
        c.log.write(`accounts: the service account ${name} isn't on this Mac`);
      }
      if (!gone && r.code === 0 && missing) c.log.write(`accounts: the service account ${name} is back`);
      if (gone || r.code === 0) missing = gone;
    });
  },
};
