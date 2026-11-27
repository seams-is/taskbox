// The agent spool, every tick, by the one writer only: each request taken by the spool's rules
// (core/spool.ts) and handed to its handler (core/dispatch.ts). A spool that can't be read safely is
// closed, and the pass fails, so the "Guard passes" row says so. The guard keeps the spool there: a
// missing one is made in root's state folder, the agent account's at 700; one that is wrong is only
// refused.
//
// Limits, counted in passes so no clock step moves them: at most SIGNED_PER_PASS signed requests a
// pass, so a flood of forged words runs at most that many ssh-keygen checks a pass; and at most
// PER_WINDOW other requests in WINDOW passes (about a minute). Signed requests don't count in the
// window, so no unsigned flood can hold up the owner's step. Requests past a limit wait in the spool,
// taken in the order root first saw them, never by the times their asker set. Past the spool's cap,
// signed requests whose signature fails the in-process check go first, then the other kinds, and a
// signed request that could be the owner's goes last. Every request root removes unread gets an
// outcome that says so, so its asker never takes it for applied.
import { chmodSync, lchownSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { readInstallId } from "../answers.ts";
import { bootId, monoNow } from "../core/boot.ts";
import { type DispatchDeps, type Handlers, handlersProblem, rankOf, requestHandlers, SIGNED, takeRequest } from "../core/dispatch.ts";
import { eventLog } from "../core/events.ts";
import type { PassCtx, PassMaker } from "../core/passes.ts";
import { rootStateOf } from "../core/paths.ts";
import { drainSpool, type Entry, newSpoolMemory, type Outcome, readRequest, readSpoolFile, recordOutcome, REQUEST_FOR_MS, REQUEST_NAME, type SpoolReport } from "../core/spool.ts";
import { pinnedKeys, readApprovers } from "../core/approvers.ts";
import { currentNonce, readNonces } from "../core/nonces.ts";
import { parseStatement, SIGNED_FOR_MS, signsInProcess, splitSigned } from "../core/statement.ts";
import { isSignedWord } from "../core/word.ts";
import { asNobody, type VerifyDeps, verifyFolder } from "../workspace/approval.ts";
import { agentUid } from "../workspace/pass.ts";

export const REFRESH = 30; // passes between lookups of the agent account's uid
export const WINDOW = 30;
export const PER_WINDOW = 60;
export const SIGNED_PER_PASS = 5;
export const OUTCOMES_KEEP = 1000; // outcomes this guard wrote, newest kept; keeping ages the rest

export interface RequestsDeps {
  c: PassCtx;
  handlers: Handlers;
  verify?: VerifyDeps; // ssh-keygen as nobody in root's folder on the box
  chown?: (path: string, uid: number, gid: number) => void;
  outcomesKeep?: number; // OUTCOMES_KEEP but in tests
  perPass?: number; // the spool's PER_PASS but in tests
}

export function requestsJob(d: RequestsDeps): () => Promise<void> {
  const why = handlersProblem(d.handlers);
  if (why) throw new Error(why);
  const { c } = d;
  const root = c.rootUid ?? 0;
  const s = rootStateOf(c.p);
  const outcomes = s.outcomes("agent");
  const mem = newSpoolMemory();
  const events = eventLog("guard", { dir: s.events, owner: root, ...(d.chown ? { chown: d.chown } : {}) }, c.sys);
  const rank = rankOf(d.handlers);
  const said = new Set<string>();
  const seen = new Map<string, number>(); // name: the pass root first saw it in
  const written: string[] = []; // outcome ids, oldest first
  let boot: string | undefined;
  let agent: number | undefined;
  let passes = 0;
  let window = { from: 0, taken: 0 };
  return async () => {
    // No agent account on this box: nothing can write the spool, and there is nothing to read.
    if (c.cfg.accounts.agent === undefined) return;
    const pass = passes++;
    if (pass % REFRESH === 0) agent = await agentUid({ sys: c.sys, cfg: c.cfg, p: c.p, rootUid: root });
    if (agent === undefined) throw new Error("the agent account isn't the one accounts.json records, so the agent spool is closed");
    placeSpool(s.agentSpool, agent, root, d.chown ?? lchownSync);
    boot ??= await bootId(c.sys);
    if (pass - window.from >= WINDOW) window = { from: pass, taken: 0 };
    const verify = d.verify ?? { run: asNobody(c.sys), tmp: verifyFolder(c.p.verifyTmp, { rootUid: root, ...(d.chown ? { chown: d.chown } : {}) }) };
    const dd: DispatchDeps = {
      ctx: { sys: c.sys, cfg: c.cfg, p: c.p, state: s, rootUid: root, ...(d.chown ? { chown: d.chown } : {}), events, log: (l) => c.log.write(l) },
      handlers: d.handlers,
      verify,
      agent,
      installId: () => readInstallId(c.p.installId, root),
      outcomes,
      ...(boot ? { boot } : {}),
      mono: () => monoNow(c.sys),
    };
    const firstSeen = (e: Entry) => seen.get(e.name) ?? pass;
    const now = c.sys.now();
    // The word a signed request carries, when it could be the owner's step still to apply: it passes
    // every check but ssh-keygen's, and names its subject's current nonce. Read only when the spool is
    // over its cap.
    const pending = (name: string, keys: readonly string[], installId: string | undefined, nonces: ReturnType<typeof readNonces>): string | undefined => {
      const f = readSpoolFile(join(s.agentSpool, name), agent!);
      if (!f) return undefined;
      const rr = readRequest(name, f, { owner: agent!, now, kinds: { [SIGNED]: (b) => (isSignedWord(b.word) ? undefined : "no word") } });
      if (!rr.ok) return undefined;
      const word = String(rr.request.body.word);
      const parts = splitSigned(word);
      const st = parts && parseStatement(parts.statement);
      if (!parts || !st || st.box !== installId || Math.abs(now - Date.parse(st.at)) > SIGNED_FOR_MS) return undefined;
      if (nonces.kind !== "ok" || currentNonce(nonces.value, st.subject) !== st.nonce) return undefined;
      return keys.some((k) => signsInProcess(k, parts.statement, parts.signature)) ? word : undefined;
    };
    // Over the cap, signed requests are ranked once a pass, in the order root saw them: the first copy
    // of each pending word goes last; forged words, used ones and later copies go first.
    let owners: Set<string> | undefined;
    const ranked = (): Set<string> => {
      if (owners) return owners;
      owners = new Set();
      const a = readApprovers(s.approvers, root);
      const keys = a.kind === "ok" ? pinnedKeys(a.value) : [];
      const installId = readInstallId(c.p.installId, root);
      const nonces = readNonces(s.nonces, root);
      const words = new Set<string>();
      const names = [...seen.keys()].filter((n) => REQUEST_NAME.exec(n)?.[2] === SIGNED).sort((x, y) => seen.get(x)! - seen.get(y)! || (x < y ? -1 : 1));
      for (const n of names) {
        const w = pending(n, keys, installId, nonces);
        if (w === undefined || words.has(w)) continue;
        words.add(w);
        owners.add(n);
      }
      return owners;
    };
    // An unsigned request its handler vouches for, such as the owner's connect code: read once a pass,
    // kept last past the cap, and taken outside the window, at most SIGNED_PER_PASS a pass.
    const vouchedNames = new Map<string, boolean>();
    const vouched = (name: string): boolean => {
      const kind = REQUEST_NAME.exec(name)?.[2];
      const h = d.handlers.unsigned.find((u) => u.kind === kind);
      if (!h?.vouched || !kind) return false;
      if (vouchedNames.has(name)) return vouchedNames.get(name)!;
      const f = readSpoolFile(join(s.agentSpool, name), agent!);
      const rr = f ? readRequest(name, f, { owner: agent!, now, kinds: { [kind]: (b) => h.check(b) } }) : undefined;
      const v = rr?.ok === true && h.vouched({ ...dd.ctx, now }, rr.request.body);
      vouchedNames.set(name, v);
      return v;
    };
    const BIG = 1e12;
    const age = (e: Entry): number => (REQUEST_NAME.exec(e.name)?.[2] !== SIGNED ? firstSeen(e) + (vouched(e.name) ? BIG : 0) : firstSeen(e) + (ranked().has(e.name) ? BIG : -BIG));
    const note = (name: string, code: "busy" | "expired", said: string) => {
      const id = REQUEST_NAME.exec(name)?.[1];
      if (!id) return;
      const o: Outcome = { id, at: now, ok: false, code, said, ...(boot ? { boot } : {}) };
      try {
        if (recordOutcome(outcomes, o, { owner: root, ...(d.chown ? { chown: d.chown } : {}) })) written.push(id);
      } catch (e) {
        c.log.write(`agent spool: the outcome of ${id} couldn't be written: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
      }
    };
    const dropped = (name: string, why: "flood" | "expired") =>
      why === "flood"
        ? note(name, "busy", "The box dropped it unread: its spool held more than 50 requests. Send it again in a minute.")
        : note(name, "expired", `It waited past its ${REQUEST_FOR_MS / 60_000} minutes in the spool unread. Send it again.`);
    const order = (entries: readonly Entry[], perPass: number): string[] => {
      const here = new Set(entries.map((e) => e.name));
      for (const n of [...seen.keys()]) if (!here.has(n)) seen.delete(n);
      for (const e of entries) if (!seen.has(e.name)) seen.set(e.name, pass);
      const sorted = entries
        .map((e) => ({ e, m: REQUEST_NAME.exec(e.name) }))
        .filter((x) => x.m !== null)
        .sort((a, b) => rank(a.m![2]!) - rank(b.m![2]!) || Number(vouched(b.e.name)) - Number(vouched(a.e.name)) || firstSeen(a.e) - firstSeen(b.e) || (a.e.name < b.e.name ? -1 : 1));
      let left = Math.max(0, perPass);
      let signedLeft = SIGNED_PER_PASS;
      let otherLeft = Math.max(0, PER_WINDOW - window.taken);
      let vouchedLeft = SIGNED_PER_PASS;
      const out: string[] = [];
      for (const x of sorted) {
        if (left === 0 && !(vouchedLeft > 0 && x.m![2] !== SIGNED && vouched(x.e.name))) continue;
        if (x.m![2] === SIGNED) {
          if (signedLeft === 0) continue;
          signedLeft--;
        } else if (vouched(x.e.name)) {
          if (vouchedLeft === 0) continue;
          vouchedLeft--;
          out.push(x.e.name);
          continue;
        } else {
          if (otherLeft === 0) continue;
          otherLeft--;
        }
        left--;
        out.push(x.e.name);
      }
      return out;
    };
    const late: string[] = [];
    const report: SpoolReport = { did: [], problems: [] };
    await drainSpool({ dir: s.agentSpool, owner: agent, rootUid: root, isRequest: (n) => REQUEST_NAME.test(n), order, age, dropped, whose: "the agent account", ...(d.perPass ? { perPass: d.perPass } : {}) }, mem, c.sys, report, async (name, f) => {
      if (REQUEST_NAME.exec(name)?.[2] !== SIGNED && !vouched(name)) window.taken++;
      const o = await takeRequest(dd, name, f);
      if (!o) return;
      if (o.code === "timeout") late.push(o.said);
      written.push(o.id);
      while (written.length > (d.outcomesKeep ?? OUTCOMES_KEEP)) {
        try {
          unlinkSync(join(outcomes, `${written.shift()}.json`));
        } catch {}
      }
    });
    for (const l of report.did) c.log.write(`agent spool: ${l}`);
    // A problem is said once while it lasts. A closed spool, or a handler that didn't answer, fails the pass.
    const problems = new Set(report.problems);
    for (const p of problems) if (!said.has(p)) c.log.write(`agent spool: ${p}`);
    said.clear();
    for (const p of problems) said.add(p);
    if (report.closed) throw new Error(`the agent spool: ${report.closed}, so the spool is closed`);
    if (late.length) throw new Error(late[0]!.slice(0, 200));
  };
}

// The spool made when it is missing, and only when its folder is root's alone, so the path can't be
// swapped under the change. Anything at the name is left as it is: drainSpool refuses a wrong one.
export function placeSpool(spool: string, agent: number, rootUid: number, chown: (path: string, uid: number, gid: number) => void): void {
  try {
    lstatSync(spool);
    return;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") return;
  }
  try {
    const up = lstatSync(dirname(spool));
    if (!up.isDirectory() || up.isSymbolicLink() || up.uid !== rootUid || (up.mode & 0o022) !== 0) return;
  } catch {
    return;
  }
  mkdirSync(spool, { mode: 0o700 });
  chown(spool, agent, 20); // group staff, as every account's own folders have it
  chmodSync(spool, 0o700);
}

export const requestsPass: PassMaker = {
  name: "requests",
  make(c) {
    if (!c.writer) return undefined;
    const job = requestsJob({ c, handlers: requestHandlers() });
    return { name: "requests", at: "after", start: () => job, next: () => job };
  },
};
