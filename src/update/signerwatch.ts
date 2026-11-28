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
import { confirm, parseRevoke, parseSignerState, REVOKE, refuse, removalShows, revoke, type SignerState, waitingOf } from "../release/signers.ts";
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

// An admin's answer from confirm, applied by the guard: a yes lets that change's removals apply; a no
// drops that change, and it is never taken again, so another change waiting beside it goes on.
export function takeSignerYes(d: WatchDeps): string | undefined {
  const f = signerFiles(d.state);
  const y = readOwnedJson(f.yes, { owner: d.rootUid, max: 1024 }, (v) => (v && typeof v === "object" && typeof (v as { sha?: unknown }).sha === "string" && ((v as { yes?: unknown }).yes === undefined || typeof (v as { yes?: unknown }).yes === "boolean") ? (v as { sha: string; yes?: boolean }) : "out of shape"));
  if (y.kind === "missing") return undefined;
  rmSync(f.yes, { force: true });
  const s = read(d);
  if (y.kind !== "ok" || !s) return undefined;
  if (y.value.yes === false) {
    const r = refuse(s, y.value.sha);
    if (typeof r === "string") return r;
    save(d, r);
    return "an admin refused a release signer change at the box, and it is dropped";
  }
  const c = confirm(s, y.value.sha, d.sys.now());
  if (typeof c === "string") return c;
  save(d, c);
  return "an admin confirmed the release signers' removal at the box";
}

// Each waiting removal raised for confirm, again each hour while it waits (each lapses after 24 hours).
export async function raiseRemoval(d: WatchDeps): Promise<void> {
  const s = read(d);
  const list = (s ? waitingOf(s) : []).filter((p) => p.removes.length && !p.removesDone && p.confirmed === undefined);
  if (!list.length) return;
  const at = await d.moment();
  await updatePending(d.state.pending, { rootUid: d.rootUid, ...(d.chown ? { chown: d.chown } : {}) }, (st) => {
    let next = st;
    for (const p of list) {
      const r = raise(next, { kind: "signers", subject: "release signers", shows: removalShows(p), actor: "taskbox", payload: { sha: p.sha } }, at);
      if (r.ok) next = r.state;
    }
    return { state: next, out: undefined };
  });
}

// Each release that carries a waiting add, read hourly: its signed statement, its revoke list (named
// in that statement), and a revoke signed on its own if one is published, each verified against the
// pin as nobody. Anything that can't be read fails closed: the problem is kept for status, and no
// add applies until a later read finds no revoke (release/signers.ts settle).
export async function readRevoke(d: WatchDeps): Promise<string | undefined> {
  const s = read(d);
  const waits = s ? waitingOf(s).filter((p) => p.version && !p.addsDone && p.confirmed === undefined) : [];
  if (!s || !waits.length) return undefined;
  if (!d.repo) {
    save(d, listProblem(s, "taskbox.json names no publicRepo, so the revoke list can't be read"));
    return "FAIL taskbox.json names no publicRepo, so the revoke list can't be read, so the release key add waits";
  }
  const nobody = { readable: true, run: (cmd: string, args: string[], o?: { stdin?: string | Uint8Array; timeoutMs?: number }) => d.sys.run(SUDO, ["-n", "-u", "nobody", "--", "/usr/bin/env", "-i", "HOME=/var/empty", "PATH=/usr/bin:/bin", cmd, ...args], o) };
  const work = signerFiles(d.state).work;
  const said: string[] = [];
  let problem: string | undefined;
  let cur = s;
  for (const p of waits) {
    // An earlier read this pass may have dropped it.
    if (!waitingOf(cur).some((x) => x.sha === p.sha)) continue;
    const tag = tagOf(p.version!);
    const fail = (why: string) => {
      problem = why;
      said.push(`FAIL ${why}, so the release key add waits`);
    };
    let rel;
    try {
      rel = await publicRelease(d.sys, d.repo, tag);
    } catch {
      fail(`the release ${tag} that carries the signer change can't be read`);
      continue;
    }
    const sv = await verifySigned(nobody, { message: rel.statement, signature: rel.signature, pinned: cur.pinned, workRoot: work }).catch(() => undefined);
    const st = parseStatement(new TextDecoder().decode(rel.statement));
    if (!sv?.ok || !st || st.tag !== tag) {
      fail(`${tag}'s statement isn't signed by a pinned key`);
      continue;
    }
    const bytes = await rel.asset(REVOKES, REVOKES_MAX).catch(() => undefined);
    const list = listOf(st, bytes);
    if (typeof list === "string") {
      fail(list);
      continue;
    }
    // A revoke signed on its own, uploaded after the release: none is the usual case.
    let one: { text: Uint8Array; sig: Uint8Array } | undefined;
    try {
      one = { text: await rel.asset(REVOKE, 4096), sig: await rel.asset(`${REVOKE}.sig`, 16_384) };
    } catch {
      one = undefined;
    }
    if (one) {
      const r = parseRevoke(new TextDecoder().decode(one.text));
      if (!r) {
        fail(`a revoke on ${tag} isn't one taskbox reads`);
        continue;
      }
      const v = await verifySigned(nobody, { message: one.text, signature: one.sig, pinned: cur.pinned, workRoot: work });
      if (!v.ok || !v.signer) {
        fail(`a revoke on ${tag} isn't signed by a pinned key`);
        continue;
      }
      const done = revoke(cur, r, v.signer);
      if (!("why" in done)) {
        cur = done.state;
        said.push(done.said);
        continue;
      }
    }
    const t = takeList(cur, list, sv.signer, d.sys.now(), p.sha);
    cur = t.state;
    if (t.said) said.push(t.said);
  }
  // takeList clears a kept problem on a good read; one that failed this pass stays.
  if (problem !== undefined) cur = listProblem(cur, problem);
  else {
    const { revokeProblem: _, ...clean } = cur;
    cur = clean;
  }
  save(d, cur);
  return said.length ? said.join("; ") : undefined;
}
