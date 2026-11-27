// The guard's update pass, by the one writer only:
// - an update or a rollback past its swap whose child a restart ended is started again, so its proof
//   carries on (optypes/update.ts says it resumes), before the ops pass would fail it;
// - an auto-update begins when update/auto.ts says so, with the public repo read at most hourly.
import { rmSync } from "node:fs";
import { bootId } from "../core/boot.ts";
import { CHILD_BUN, progressPath, reportsPath, runChild } from "../core/child.ts";
import { eventLog } from "../core/events.ts";
import { isObj, readOwnedJson, writeOwnedText } from "../core/rootfile.ts";
import { parseSignerState, settle } from "../release/signers.ts";
import { listOps } from "../core/ops.ts";
import type { PlacedMaker } from "../core/passes.ts";
import { rootStateOf } from "../core/paths.ts";
import { updateOf } from "../settings/update.ts";
import { autoStep, CHECK_EVERY_MS, noHold } from "../update/auto.ts";
import { runningOf, updateFiles } from "../update/box.ts";
import { listedReleases, type Listed } from "../update/pick.ts";
import { readMarks, writeMarks } from "../update/records.ts";
import { CHILD_FILE, startUpdateOp, UPDATE_EVENTS } from "../update/start.ts";

export const updatePass: PlacedMaker = {
  order: 550,
  name: "update",
  make(c) {
    if (!c.writer) return undefined;
    const s = rootStateOf(c.p);
    const root = c.rootUid ?? 0;
    const events = eventLog("guard", { dir: s.events, owner: root }, c.sys);
    const log = (l: string) => c.log.write(`update: ${l}`);
    const tried = new Set<string>();
    let listed: Listed[] | undefined;
    let listedAt = -Infinity;
    let heldSaid = "";
    const job = async () => {
      const boot = await bootId(c.sys);
      if (!boot) return;
      const ops = { dir: s.ops, owner: root };
      const all = listOps(ops).ops;
      for (const op of all) {
        if (op.state !== "running" || (op.type !== "update" && op.type !== "rollback")) continue;
        const child = isObj(op.child) ? (op.child as { boot?: unknown }) : undefined;
        if (!child || child.boot === boot || op.phases.indexOf(op.phase) < op.phases.indexOf("swap")) continue;
        // The reports of the child before the restart were applied as far as they went; the new child
        // numbers its own from 1.
        rmSync(reportsPath(ops, op.id), { force: true });
        rmSync(progressPath(ops, op.id), { force: true });
        const { child: _, ...bare } = op;
        await runChild({ sys: c.sys, ops, events, log, boot }, bare as typeof op, CHILD_BUN, [CHILD_FILE], { events: UPDATE_EVENTS }).catch((e: Error) => log(`${op.id} couldn't start again: ${e.message.slice(0, 120)}`));
        log(`${op.id}: the ${op.type} carries on with its proof after the restart`);
      }
      const u = updateOf(c.cfg);
      const now = c.sys.now();
      // A signer change past its wait, or confirmed at the box, moves the pin (release/signers.ts).
      const sf = updateFiles(s).signers;
      const sr = readOwnedJson(sf, { owner: root, max: 64 * 1024 }, (v) => parseSignerState(v) ?? "out of shape");
      if (sr.kind === "ok" && sr.value.pending) {
        const st = settle(sr.value, now);
        if (st.said.length) {
          writeOwnedText(sf, `${JSON.stringify(st.state)}\n`, { mode: 0o644, owner: root });
          for (const l of st.said) events.write({ type: "update.signers", actor: "taskbox", subject: "box", text: `The box ${l}.`.slice(0, 240) });
        }
      }
      const marks = readMarks(updateFiles(s).marks, root);
      let installed: string;
      try {
        installed = runningOf(c.p, root).version;
      } catch {
        return;
      }
      const offsetMin = -new Date(now).getTimezoneOffset();
      const fresh = now - listedAt < CHECK_EVERY_MS ? listed : undefined;
      let step = autoStep({ now, offsetMin, u, channel: u.channel, installed, marks, running: all, hold: noHold(), listed: fresh, tried });
      if (step.kind === "list") {
        if (!c.cfg.publicRepo) return;
        try {
          const res = await c.sys.fetch(`https://api.github.com/repos/${c.cfg.publicRepo}/releases?per_page=100`, { redirect: "error", signal: c.sys.timeout(30_000), headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "taskbox" } });
          if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
          listed = listedReleases(await res.json());
          listedAt = now;
          writeMarks(updateFiles(s).marks, { ...marks, checkedAt: now }, { rootUid: root });
        } catch (e) {
          log(`the public repo's releases couldn't be read: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
          listedAt = now;
          listed = [];
          return;
        }
        step = autoStep({ now, offsetMin, u, channel: u.channel, installed, marks, running: all, hold: noHold(), listed, tried });
      }
      if (step.kind === "held" && step.line !== heldSaid) {
        heldSaid = step.line;
        log(step.line);
      }
      if (step.kind !== "start") return;
      tried.add(step.key);
      const hctx = { sys: c.sys, cfg: c.cfg, p: c.p, state: s, rootUid: root, events, log, now };
      const r = await startUpdateOp(hctx, "update", { to: step.version, timeout: step.timeout, auto: true }, "taskbox (auto-update)", { auto: true });
      log(r.said);
    };
    return { name: "update", at: "after", start: () => job, next: () => job };
  },
};
