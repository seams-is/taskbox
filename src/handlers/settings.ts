// The owner's signed settings requests, from the controller through the agent spool (core/dispatch.ts):
// - settings apply COMMIT: a waiting commit's second-tier guarded keys apply, and its first-tier
//   keys then wait for confirm at the box;
// - settings repo ORG/REPO: names this box's settings repo when it has none. Moving a named one is an
//   admin's, at the box;
// - withdraw ID: drops a lasting change waiting for confirm. It narrows, so it applies at once.
// Each names the box as its subject, and the actor is the key that signed.
import type { Answer, SignedHandler } from "../core/dispatch.ts";
import { drop, updatePending } from "../core/pending.ts";
import type { Args } from "../core/statement.ts";
import { REPO, SHA } from "../settings/inforce.ts";
import type { SettingsCtx } from "../settings/repo.ts";

const word = (a: Args): string | undefined => (Array.isArray(a.words) && a.words.length === 1 && typeof a.words[0] === "string" ? a.words[0] : undefined);
const only = (a: Args) => Object.keys(a).every((k) => k === "words");
const deps = async (c: SettingsCtx) => (await import("../settings/repo.ts")).settingsDepsOf(c);

// The repo named and its read proved: the settings files ask, through the guard's socket.
export async function nameRepo(c: SettingsCtx, repo: string, actor: string): Promise<Answer> {
  const d = await deps(c);
  const a = await d.ask({ ask: "settings-files", repo, box: d.box });
  if (!a.ok) return { ok: false, code: "failed", said: `${repo} can't be read with the runner App: ${a.why}. On GitHub, add it to the runner App's repositories, then send it again.` };
  await d.setBoxKeys({ settingsRepo: repo });
  const { updateState } = await import("../settings/inforce.ts");
  await updateState(d.files, { rootUid: c.rootUid, ...(c.chown ? { chown: c.chown } : {}) }, (s) => ({ state: { ...s, readNow: true }, out: undefined }));
  c.events.write({ type: "settings.repo", actor, subject: "settings", text: `This box's settings repo is now ${repo}.`, data: { repo } });
  return { ok: true, said: `This box reads its settings from ${repo} now. The guard reads its head commit within a minute.` };
}

export const handlers: { signed: SignedHandler[] } = {
  signed: [
    {
      action: "settings.apply",
      subject: () => "box",
      check: (a) => (only(a) && SHA.test(word(a) ?? "") ? undefined : "settings apply takes one commit, its full 40-character SHA"),
      async apply(c, r) {
        const { applySigned } = await import("../settings/op.ts");
        return applySigned(await deps(c), word(r.statement.args)!, r.by.actor);
      },
    },
    {
      action: "settings.repo",
      subject: () => "box",
      check: (a) => (only(a) && REPO.test(word(a) ?? "") ? undefined : "settings repo takes one repo, as ORG/REPO"),
      async apply(c, r) {
        const d = await deps(c);
        const named = d.boxKeys()?.settingsRepo;
        if (typeof named === "string") return { ok: false, code: "denied", said: `This box's settings repo is ${named} already. Moving it is an admin's, at the box: taskbox settings repo ORG/REPO there.` };
        return nameRepo(c, word(r.statement.args)!, r.by.actor);
      },
    },
    {
      action: "withdraw",
      subject: () => "box",
      check: (a) => (only(a) && /^pc_[0-9A-HJKMNP-TV-Z]{26}$/.test(word(a) ?? "") ? undefined : "withdraw takes one id of a change waiting for confirm"),
      async apply(c, r) {
        const id = word(r.statement.args)!;
        const gone = await updatePending(c.state.pending, { rootUid: c.rootUid, ...(c.chown ? { chown: c.chown } : {}) }, (s) => {
          const x = drop(s, (p) => p.id === id);
          return { state: x.state, out: x.dropped[0] };
        });
        if (!gone) return { ok: false, code: "not-found", said: `Nothing with the id ${id} waits for confirm.` };
        c.events.write({ type: "confirm.withdrawn", actor: r.by.actor, subject: gone.subject, text: `An approver withdrew a ${gone.kind} change that waited for confirm.`, data: { id } });
        if (gone.kind === "settings") {
          const { passOver } = await import("../settings/op.ts");
          const d = await deps(c);
          const { readState } = await import("../settings/inforce.ts");
          const s = readState(d.files, c.rootUid);
          if (s.kind === "ok" && s.value.waiting?.pending === id) {
            const wt = await passOver(d, "an approver withdrew it");
            if (wt) {
              const { readOp, end, writeOp, opEvent } = await import("../core/ops.ts");
              const ops = { dir: c.state.ops, owner: c.rootUid, ...(c.chown ? { chown: c.chown } : {}) };
              const op = readOp(ops, wt.op);
              if (op.kind === "ok" && op.value.state === "running") {
                const after = end(op.value, "cancelled", c.now, { why: "withdrawn by an approver" });
                writeOp(ops, after);
                const e = opEvent(op.value, after);
                if (e) c.events.write(e);
              }
            }
          }
        }
        return { ok: true, said: `Withdrawn: the ${gone.kind} change ${id} won't apply.` };
      },
    },
  ],
};
