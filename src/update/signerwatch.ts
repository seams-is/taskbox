// The guard's hourly look at a signer change that waits (release/signers.ts): the revoke list and a
// revoke published on the release that carries it, verified against the pin as nobody, cancel it,
// and a read that fails keeps the add waiting; a removal is raised
// for confirm at the box, and an admin's yes there (confirm writes signers-yes.json) lets it apply.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { type Moment, raise, updatePending } from "../core/pending.ts";
import type { RootState } from "../core/paths.ts";
import { readOwnedJson, writeOwnedText, type WriteRules } from "../core/rootfile.ts";
import { SUDO } from "../elevate.ts";
import { publicRelease } from "../hop.ts";
import { parseStatement, tagOf, verifySigned } from "../release.ts";
import { listOf, listProblem, REVOKES, REVOKES_MAX, takeList } from "../release/revokes.ts";
import { confirm, parseRevoke, parseSignerState, REVOKE, removalShows, revoke, type SignerState } from "../release/signers.ts";
import type { Sys } from "../sys.ts";

export const signerFiles = (s: Pick<RootState, "dir">) => ({ state: join(s.dir, "signers.json"), yes: join(s.dir, "update", "signers-yes.json"), work: join(s.dir, "update") });

export interface WatchDeps {
  sys: Sys;
  state: Pick<RootState, "dir" | "pending">;
  repo?: string;
  rootUid: number;
  chown?: WriteRules["chown"];
  moment(): Promise<Moment>;
  log(line: string): void;
}

const read = (d: WatchDeps): SignerState | undefined => {
  const r = readOwnedJson(signerFiles(d.state).state, { owner: d.rootUid, max: 64 * 1024 }, (v) => parseSignerState(v) ?? "out of shape");
  return r.kind === "ok" ? r.value : undefined;
};
const save = (d: WatchDeps, s: SignerState) => writeOwnedText(signerFiles(d.state).state, `${JSON.stringify(s)}\n`, { mode: 0o644, owner: d.rootUid, ...(d.chown ? { chown: d.chown } : {}) });

// An admin's yes from confirm, applied by the guard.
export function takeSignerYes(d: WatchDeps): string | undefined {
  const f = signerFiles(d.state);
  const y = readOwnedJson(f.yes, { owner: d.rootUid, max: 1024 }, (v) => (v && typeof v === "object" && typeof (v as { sha?: unknown }).sha === "string" ? (v as { sha: string }) : "out of shape"));
  if (y.kind === "missing") return undefined;
  rmSync(f.yes, { force: true });
  const s = read(d);
  if (y.kind !== "ok" || !s) return undefined;
  const c = confirm(s, y.value.sha, d.sys.now());
  if (typeof c === "string") return c;
  save(d, c);
  return "an admin confirmed the release signers' removal at the box";
}

// The removal raised for confirm, again each hour while it waits (each lapses after 24 hours).
export async function raiseRemoval(d: WatchDeps): Promise<void> {
  const s = read(d);
  const p = s?.pending;
  if (!p || !p.removes.length || p.removesDone || p.confirmed !== undefined) return;
  const at = await d.moment();
  await updatePending(d.state.pending, { rootUid: d.rootUid, ...(d.chown ? { chown: d.chown } : {}) }, (st) => {
    const r = raise(st, { kind: "signers", subject: "release signers", shows: removalShows(p), actor: "taskbox", payload: { sha: p.sha } }, at);
    return r.ok ? { state: r.state, out: undefined } : { state: st, out: undefined };
  });
}

// The release that carries a waiting add, read hourly: its signed statement, its revoke list (named
// in that statement), and a revoke signed on its own if one is published, each verified against the
// pin as nobody. Anything that can't be read fails closed: the problem is kept for status, and the
// add doesn't apply until a later read finds no revoke (release/signers.ts settle).
export async function readRevoke(d: WatchDeps): Promise<string | undefined> {
  const s = read(d);
  const p = s?.pending;
  if (!s || !p?.version || p.addsDone || p.confirmed !== undefined) return undefined;
  const tag = tagOf(p.version);
  const fail = (why: string) => (save(d, listProblem(s, why)), `FAIL ${why}, so the release key add waits`);
  if (!d.repo) return fail("taskbox.json names no publicRepo, so the revoke list can't be read");
  const nobody = { readable: true, run: (cmd: string, args: string[], o?: { stdin?: string | Uint8Array; timeoutMs?: number }) => d.sys.run(SUDO, ["-n", "-u", "nobody", "--", "/usr/bin/env", "-i", "HOME=/var/empty", "PATH=/usr/bin:/bin", cmd, ...args], o) };
  const work = signerFiles(d.state).work;
  let rel;
  try {
    rel = await publicRelease(d.sys, d.repo, tag);
  } catch {
    return fail(`the release ${tag} that carries the signer change can't be read`);
  }
  const sv = await verifySigned(nobody, { message: rel.statement, signature: rel.signature, pinned: s.pinned, workRoot: work }).catch(() => undefined);
  const st = parseStatement(new TextDecoder().decode(rel.statement));
  if (!sv?.ok || !st || st.tag !== tag) return fail(`${tag}'s statement isn't signed by a pinned key`);
  const bytes = await rel.asset(REVOKES, REVOKES_MAX).catch(() => undefined);
  const list = listOf(st, bytes);
  if (typeof list === "string") return fail(list);
  // A revoke signed on its own, uploaded after the release: none is the usual case.
  let one: { text: Uint8Array; sig: Uint8Array } | undefined;
  try {
    one = { text: await rel.asset(REVOKE, 4096), sig: await rel.asset(`${REVOKE}.sig`, 16_384) };
  } catch {
    one = undefined;
  }
  if (one) {
    const r = parseRevoke(new TextDecoder().decode(one.text));
    if (!r) return fail(`a revoke on ${tag} isn't one taskbox reads`);
    const v = await verifySigned(nobody, { message: one.text, signature: one.sig, pinned: s.pinned, workRoot: work });
    if (!v.ok || !v.signer) return fail(`a revoke on ${tag} isn't signed by a pinned key`);
    const done = revoke(s, r, v.signer);
    if (!("why" in done)) {
      const { revokeProblem: _, ...clean } = done.state;
      save(d, clean);
      return done.said;
    }
  }
  const t = takeList(s, list, sv.signer, d.sys.now());
  save(d, t.state);
  return t.said;
}
