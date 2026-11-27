// key rotate runner and key rotate source. GitHub's API can't make an App key, so a new key
// is a new App by manifest, made as connect makes one (connectflow.ts makeApp), its key handed to the
// keeper as pending. The old App and key stay in use until switching: the new key is promoted, box.json
// names the new App, and the loop takes it once no job runs. Then retiring: the old App is uninstalled
// with its own key, and its key file goes. GitHub keeps the old App until the owner deletes it, so it
// is listed (retired.json) with its delete link, for the Retired Apps row and key list.
import { createHash, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { type AppRole, deleteLine, ROLE_NAME } from "./connect.ts";
import { clientFor, type CodeGot, Ended, fixable, fixPage, type FlowDeps, heldKey, keptApp, makeApp, proveApp, readPendingFile, repoWants, sourceSettings, uninstallAll, waitTrue, wantsOf, writeBoxKeys, writePendingFile } from "./connectflow.ts";
import type { UnsignedHandler } from "./core/dispatch.ts";
import { listOps, type Op, type OpFolder } from "./core/ops.ts";
import { isObj, readOwnedJson, writeOwnedText, type WriteRules } from "./core/rootfile.ts";
import { dropKey, promoteKey } from "./keys.ts";
import { ROTATE } from "./optypes/keys.ts";

export const ROTATE_APP_MS = 60 * 60_000; // the manifest code's life on GitHub, as connect's
export type AppPhase = "making" | "installing" | "proving" | "switching" | "retiring";
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// What a rotation needs: connect's flow deps, with its own phases.
export type RotateDeps = Omit<FlowDeps, "phase" | "confirmKeeping"> & {
  phase(p: AppPhase, text?: string): void;
  // Once switching is reported, waits for the op's record to show it: past it a cancel is refused.
  confirmSwitching?(): Promise<void>;
  retiredFile: string; // root's retired.json
};

// The flow deps connect's helpers take, with connect's phase names mapped onto the rotation's.
function asFlow(d: RotateDeps): FlowDeps {
  return {
    ...d,
    phase: (p, a) => {
      const mine: AppPhase = p.startsWith("making") ? "making" : "installing";
      const text = a ? ("make" in a ? `make ${a.make} ${a.name}` : `open ${a.open}`) : undefined;
      d.phase(mine, text);
    },
  };
}

// The rotation: 0 when the new App is in use and the old one retired, 1 when it stopped before the
// switch (a line says why, and the old App is still in use).
export async function rotateApp(d: RotateDeps, role: AppRole): Promise<number> {
  try {
    return await rotateOnce(d, role);
  } catch (e) {
    if (!(e instanceof Ended)) throw e;
    d.say("The rotation ended before it switched (its deadline, or op cancel). The old App is still in use.");
    return 1;
  }
}

async function rotateOnce(d: RotateDeps, role: AppRole): Promise<number> {
  const f = asFlow(d);
  const kept = keptApp(d.cfg, role);
  if (!kept?.inBox) return (d.say(`This box keeps no ${ROLE_NAME[role]} of its own yet, so there is no key to rotate. Type taskbox connect github first.`), 1);
  const oldPem = heldKey(d, role, kept.appId);
  if (!oldPem) return (d.say(`${cap(ROLE_NAME[role])} (App ${kept.appId}) has no key with the GitHub key keeper. taskbox connect github makes a new App in its place.`), 1);
  const w = wantsOf(d.cfg);
  // A new App this rotation, or one before it, made and didn't keep: finished, not made again. One
  // that connect left is connect's to finish.
  const pend = readPendingFile(d).apps[role];
  let target: { id: number; slug: string; pem: string } | undefined;
  if (pend) {
    if (pend.replacing !== kept.appId) return (d.say(`A connect left ${ROLE_NAME[role]} ${pend.slug} unfinished. Type taskbox connect github to finish it, or taskbox op cancel to drop it, then rotate.`), 1);
    const pem = heldKey(d, role, pend.appId, true);
    if (pem) {
      d.say(`The new App ${pend.slug} was made by an earlier rotation and isn't in use yet: taskbox finishes it.`);
      const file = readPendingFile(d);
      file.apps[role] = { ...pend, ...(d.op ? { op: d.op } : {}) };
      writePendingFile(d, file);
      target = { id: pend.appId, slug: pend.slug, pem };
    }
  }
  const other = keptApp(d.cfg, role === "runner" ? "source" : "runner")?.appId;
  if (!target) {
    d.say(`${cap(ROLE_NAME[role])} ${kept.slug ?? `App ${kept.appId}`} stays in use until the new App is proved.`);
    target = await makeApp(f, role, other, kept.appId);
    if (!target) return 1;
  }
  // installing: the owner installs the new App on the same repos.
  const app = clientFor(d, target.id, target.pem);
  const first = await proveApp(d, role, app, repoWants(d, role, w));
  if (d.live && !d.live()) throw new Ended("the rotation ended");
  if (fixable(first)) {
    const page = fixPage(f, target.slug, first);
    d.phase("installing", `open ${page}`);
    d.open(page);
    d.say(`On the next page, choose Only select repositories, pick ${repoWants(d, role, w).want.join(" and ")}, and click Install. Waiting up to 10 minutes.`);
  } else d.phase("installing");
  const done = await waitTrue(f, role, app, w, first);
  if (!done.ok) return (d.say(`Not rotated: ${done.why}. The old App is still in use. The new App ${target.slug} is kept for the next try: taskbox key rotate ${role} finishes it, or taskbox op cancel drops it.`), 1);
  d.phase("proving");
  d.event("key.proved", `The new ${ROLE_NAME[role]} ${done.slug} is installed and proved.`, { role, app: target.id, slug: done.slug });
  // switching: from here the op can't be cancelled.
  if (d.live && !d.live()) throw new Ended("the rotation ended");
  d.phase("switching");
  await d.confirmSwitching?.();
  const why = promoteKey(d.keys.dir, role, target.id);
  if (why) return (d.say(`Not switched: ${why}. The old App is still in use; type taskbox key rotate ${role} again.`), 1);
  writeBoxKeys(d, role === "runner" ? { runnerApp: { appId: target.id, app: done.slug } } : { sources: [sourceSettings(target.id, done.slug, w)] });
  const file = readPendingFile(d);
  delete file.apps[role];
  writePendingFile(d, file);
  d.event("key.switched", `${cap(ROLE_NAME[role])} is now ${done.slug}, in place of App ${kept.appId}.`, { role, app: target.id, slug: done.slug, from: kept.appId });
  d.say(`Switched: ${ROLE_NAME[role]} is now ${done.slug}. The loop takes it once no job runs.`);
  // retiring: the old App uninstalled with its own key, then its key goes.
  d.phase("retiring");
  const gone = await uninstallAll(clientFor(d, kept.appId, oldPem)).catch(() => false);
  dropKey(d.keys.dir, role, kept.appId);
  const oldSlug = kept.slug ?? `app-${kept.appId}`;
  addRetired(d.retiredFile, { role, appId: kept.appId, slug: oldSlug, at: d.sys.now() }, { owner: d.rootUid ?? 0, ...(d.chown ? { chown: d.chown } : {}) });
  d.event("key.retired", `The old ${ROLE_NAME[role]} (App ${kept.appId}) is ${gone ? "uninstalled" : "left installed"}, and its key is deleted.`, { role, app: kept.appId, uninstalled: gone });
  d.say(`${gone ? `The old App ${oldSlug} is uninstalled` : `The old App ${oldSlug} couldn't be uninstalled with its key: uninstall it on GitHub`}, and its key is deleted from this box. ${deleteLine(d.cfg.org, oldSlug)}`);
  return 0;
}

// ---- Retired Apps: left on GitHub until the owner deletes them ----
// GitHub can't tell the box when an App is deleted (a private App's page is 404 to the box either
// way), so each is listed for RETIRED_DAYS, then dropped from the list.
export type Retired = { role: AppRole; appId: number; slug: string; at: number };
export const RETIRED_MAX = 20;
export const RETIRED_DAYS = 30;
const SLUG = /^[a-z0-9][a-z0-9-]{0,33}$/;
const retiredOk = (v: unknown): v is Retired => isObj(v) && (v.role === "runner" || v.role === "source") && Number.isSafeInteger(v.appId) && (v.appId as number) > 0 && typeof v.slug === "string" && SLUG.test(v.slug) && Number.isSafeInteger(v.at);

export function readRetired(path: string, rootUid = 0): Retired[] {
  const r = readOwnedJson(path, { owner: rootUid, max: 16 * 1024 }, (v) => (isObj(v) && v.v === 1 && Array.isArray(v.apps) ? (v.apps.filter(retiredOk) as Retired[]) : "not a retired list"));
  return r.kind === "ok" ? r.value : [];
}
export function addRetired(path: string, r: Retired, w: Omit<WriteRules, "mode">): void {
  const apps = [...readRetired(path, w.owner).filter((x) => x.appId !== r.appId), r].slice(-RETIRED_MAX);
  writeOwnedText(path, `${JSON.stringify({ v: 1, apps })}\n`, { ...w, mode: 0o644 });
}
export const retiredPath = (stateDir: string) => join(stateDir, "retired.json");

// ---- The controller's code, through the agent spool ----
// As connect's (connectflow.ts takeConnectCode): the controller makes one 64-hex state, signs only its
// hash into key rotate, and the box keeps the hash on the op. A code is taken only with a state whose
// hash matches, in constant time, while the op is making its App, once per op.
export const KEY_CODE = "key-code";
const OP_ID = /^op_[0-9A-HJKMNP-TV-Z]{26}$/;
const CODE_RE = /^[A-Za-z0-9_-]{1,100}$/;
export const HEX64 = /^[0-9a-f]{64}$/;
export const stateHash = (state: string) => createHash("sha256").update(state).digest("hex");
export type KeyCodeInbox = { v: 1; op: string; code: string };
export const keyCodePath = (stateDir: string) => join(stateDir, "key-code.json");

export function keyCodeProblem(body: Record<string, unknown>): string | undefined {
  if (Object.keys(body).sort().join(",") !== "code,op,state") return "a key code carries its op, its state and its code alone";
  if (typeof body.op !== "string" || !OP_ID.test(body.op)) return "a key code names its op";
  if (typeof body.state !== "string" || !HEX64.test(body.state)) return "a key code carries its op's state";
  return typeof body.code === "string" && CODE_RE.test(body.code) ? undefined : "a key code is one code";
}

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
const appTypes: readonly string[] = [ROTATE.runner, ROTATE.source];

export function takeKeyCode(running: readonly Pick<Op, "id" | "type" | "state" | "phase" | "params">[], inbox: KeyCodeInbox | undefined, req: { op: string; state: string; code: string }): { inbox: KeyCodeInbox } | { why: string } {
  const op = running.find((o) => appTypes.includes(o.type) && o.state === "running" && o.id === req.op);
  if (!op) return { why: "no key rotation by that op is open on this box" };
  if (op.params.from !== "controller" || typeof op.params.stateHash !== "string" || !HEX64.test(op.params.stateHash)) return { why: "that rotation takes its code at the box" };
  if (op.phase !== "making") return { why: "the open rotation isn't making its App now" };
  if (!same(stateHash(req.state), op.params.stateHash)) return { why: "that code doesn't carry this rotation's state" };
  if (inbox && inbox.op === op.id) return { why: "this rotation took its code already" };
  return { inbox: { v: 1, op: op.id, code: req.code } };
}

export function readKeyCode(path: string, rootUid = 0): KeyCodeInbox | undefined {
  const r = readOwnedJson(path, { owner: rootUid, max: 4096 }, (v) => (isObj(v) && v.v === 1 && typeof v.op === "string" && typeof v.code === "string" && CODE_RE.test(v.code) ? (v as unknown as KeyCodeInbox) : "not a key code"));
  return r.kind === "ok" ? r.value : undefined;
}

export const KEY_CODE_HANDLER: UnsignedHandler = {
  kind: KEY_CODE,
  check: keyCodeProblem,
  async apply(c, r) {
    const path = keyCodePath(c.state.dir);
    const t = takeKeyCode(listOps({ dir: c.state.ops, owner: c.rootUid }).ops, readKeyCode(path, c.rootUid), r.body as { op: string; state: string; code: string });
    if ("why" in t) return { ok: false, said: t.why, code: "denied" };
    writeOwnedText(path, `${JSON.stringify(t.inbox)}\n`, { mode: 0o600, owner: c.rootUid, ...(c.chown ? { chown: c.chown } : {}) });
    return { ok: true, said: "The box took the code." };
  },
};

// The child's side: this op's code, once.
export function keyCodeWaiter(d: { sys: Pick<FlowDeps["sys"], "now" | "sleep">; rootUid?: number; live?(): boolean }, path: string, op: string, untilMs: number) {
  return async (): Promise<CodeGot> => {
    for (;;) {
      const c = readKeyCode(path, d.rootUid ?? 0);
      if (c && c.op === op) return { code: c.code };
      if (d.sys.now() >= untilMs || (d.live && !d.live())) return { stop: "No App was made in time. The old App is still in use. Type taskbox key rotate again to start over." };
      await d.sys.sleep(1000);
    }
  };
}

// Whether an op that touches the Apps is running: a connect, or another App rotation.
export function appOpRunning(ops: Pick<OpFolder, "dir" | "owner">): Op | undefined {
  return listOps(ops).ops.find((o) => o.state === "running" && (o.type === "connect" || appTypes.includes(o.type)));
}
