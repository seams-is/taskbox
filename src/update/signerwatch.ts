// The guard's hourly look at a signer change that waits (release/signers.ts): a revoke published on
// the release that carries it, verified against the pin as nobody, cancels it; a removal is raised
// for confirm at the box, and an admin's yes there (confirm writes signers-yes.json) lets it apply.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { type Moment, raise, updatePending } from "../core/pending.ts";
import type { RootState } from "../core/paths.ts";
import { readOwnedJson, writeOwnedText, type WriteRules } from "../core/rootfile.ts";
import { SUDO } from "../elevate.ts";
import { publicRelease } from "../hop.ts";
import { tagOf, verifySigned } from "../release.ts";
import { confirm, parseRevoke, parseSignerState, refuse, REVOKE, removalShows, revoke, type SignerState, waitingOf } from "../release/signers.ts";
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

// A revoke on the release that carries a waiting change: verified against the pin, as nobody.
export async function readRevoke(d: WatchDeps): Promise<string | undefined> {
  const s = read(d);
  if (!s || !d.repo) return undefined;
  const said: string[] = [];
  let cur = s;
  for (const p of waitingOf(s)) {
    if (!p.version || p.addsDone || p.confirmed !== undefined) continue;
    let rel;
    try {
      rel = await publicRelease(d.sys, d.repo, tagOf(p.version));
    } catch {
      continue;
    }
    let text: Uint8Array;
    let sig: Uint8Array;
    try {
      text = await rel.asset(REVOKE, 4096);
      sig = await rel.asset(`${REVOKE}.sig`, 16_384);
    } catch {
      continue; // no revoke published
    }
    const r = parseRevoke(new TextDecoder().decode(text));
    if (!r) {
      said.push("a revoke on that release isn't one taskbox reads");
      continue;
    }
    const nobody = { readable: true, run: (cmd: string, args: string[], o?: { stdin?: string | Uint8Array; timeoutMs?: number }) => d.sys.run(SUDO, ["-n", "-u", "nobody", "--", "/usr/bin/env", "-i", "HOME=/var/empty", "PATH=/usr/bin:/bin", cmd, ...args], o) };
    const v = await verifySigned(nobody, { message: text, signature: sig, pinned: cur.pinned, workRoot: signerFiles(d.state).work });
    if (!v.ok || !v.signer) {
      said.push(`a revoke on that release isn't signed by a pinned key: ${v.ok ? "no signer named" : v.why}`);
      continue;
    }
    const done = revoke(cur, r, v.signer);
    if ("why" in done) {
      said.push(done.why);
      continue;
    }
    cur = done.state;
    save(d, cur);
    said.push(done.said);
  }
  return said.length ? said.join("; ") : undefined;
}
