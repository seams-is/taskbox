// op cancel, as the guard applies it, whoever asks: the owner signed, the service account from its
// spool, an admin at the box from root's admin spool. The op's type says who may start it, and so who
// may cancel it, and how (src/optypes/). One the type can't cancel, or past its point of no return,
// is refused with the way back.
import type { Answer, HandlerCtx } from "./core/dispatch.ts";
import { isId } from "./core/ids.ts";
import { cancel, opEvent, pastNoReturn, readOp, writeOp } from "./core/ops.ts";
import type { Args } from "./core/statement.ts";
import type { OpDecl, Starter } from "./optypes/decl.ts";
import { opDecls } from "./optypes/index.ts";

export const opIdOf = (a: Args | Record<string, unknown>): string | undefined => (Array.isArray(a.words) && a.words.length === 1 && isId("op", a.words[0]) ? (a.words[0] as string) : undefined);
// The body an op-cancel request carries: its op id, and for an admin the admin's name.
export function cancelProblem(a: Record<string, unknown>, admin = false): string | undefined {
  const keys = Object.keys(a).sort().join(",");
  if (keys !== (admin ? "admin,words" : "words") || !opIdOf(a)) return "op cancel takes one op id";
  if (admin && !(typeof a.admin === "string" && /^[a-z_][a-z0-9_.-]{0,31}$/.test(a.admin))) return "op cancel names the admin who asked";
  return undefined;
}

const NAME: Record<Starter, string> = { owner: "the owner", service: "the service account", admin: "an admin at the box" };
const list = (xs: readonly string[]) => (xs.length < 2 ? (xs[0] ?? "nobody") : `${xs.slice(0, -1).join(", ")} or ${xs.at(-1)}`);

export async function cancelOp(c: HandlerCtx, id: string, role: Starter, actor: string, decls: readonly OpDecl[] = opDecls()): Promise<Answer> {
  const ops = { dir: c.state.ops, owner: c.rootUid, ...(c.chown ? { chown: c.chown } : {}) };
  const r = readOp(ops, id);
  if (r.kind !== "ok") return { ok: false, code: "not-found", said: `No op ${id} on this box.` };
  const op = r.value;
  if (op.state !== "running") return { ok: true, said: `The ${op.type} has ended already: ${op.state}.`, op: id };
  const d = decls.find((x) => x.type === op.type);
  if (!d) return { ok: false, code: "failed", said: `The ${op.type} can't be cancelled: this release doesn't declare it.`, op: id };
  if (!d.who.includes(role)) return { ok: false, code: "denied", said: `A ${op.type} is cancelled by ${list(d.who.map((w) => NAME[w]))}, as it is started.`, op: id };
  if (!d.cancel || !op.cancellable) return { ok: false, code: "failed", said: `The ${op.type} can't be cancelled. ${d.wayBack}`, op: id };
  if (pastNoReturn(op)) return { ok: false, code: "failed", said: `The ${op.type} is past ${op.pointOfNoReturn}, so it can't be cancelled. ${d.wayBack}`, op: id };
  const a = await d.cancel(c, op, actor);
  return { ...a, op: id };
}

// The cancel a type with a child uses: the guard ends the op as cancelled, and the ops pass then
// boots out its child (core/child.ts follow).
export async function endAsCancelled(c: HandlerCtx, op: { id: string; type: string }, actor: string): Promise<Answer> {
  const ops = { dir: c.state.ops, owner: c.rootUid, ...(c.chown ? { chown: c.chown } : {}) };
  const r = readOp(ops, op.id);
  if (r.kind !== "ok") return { ok: false, code: "not-found", said: `No op ${op.id} on this box.` };
  const done = cancel(r.value, c.now, actor);
  if (!done.ok) return { ok: false, code: "failed", said: done.why };
  writeOp(ops, done.op);
  const e = opEvent(r.value, done.op);
  if (e) c.events.write(e);
  return { ok: true, said: `The ${op.type} ${op.id} is cancelled.` };
}
