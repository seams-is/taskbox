// connect github and disconnect github: one op makes both Apps true, the runner App first. Root
// converts the code, checks the App, hands its key to the keeper as pending, proves the install, and
// only then keeps it. The code comes from the listener at the box or from the controller.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { readBoxFile } from "./boxsettings.ts";
import { type AppRole, appName, appPage, conversionProblem, deleteLine, hookProblem, type InstallFail, installationProblem, installationsOf, installPage, PERMISSIONS, permissionsPage, publicProblem, reposProblem, ROLE_NAME, SLUG } from "./connect.ts";
import type { Config, LoadRepo, Paths, SourceSettings } from "./config.ts";
import { jobLabel, leasePath, progressPath, type Report, reporter, reportsPath } from "./core/child.ts";
import { begin, listOps, type Op, type OpFolder, readOp, writeOp } from "./core/ops.ts";
import { opType } from "./optypes/index.ts";
import { isObj, readOwnedJson, writeOwnedText } from "./core/rootfile.ts";
import type { UnsignedHandler } from "./core/dispatch.ts";
import { readRequest, readSpoolFile } from "./core/spool.ts";
import type { Json } from "./core/statement.ts";
import { CLOCK_LIMIT_S, clockOffsetS } from "./ghfail.ts";
import { AppClient, apiCall, bodyOf, revokeToken, runnerGroupsOf, tokenCall, tokenRepos } from "./github.ts";
import { dropKey, keyFileName, listKeys, placePending, placeSourceKey, promoteKey, proveActionsKey, readAdoptedKey, readHeldKey } from "./keys.ts";
import type { Log } from "./log.ts";
import { readActionsKey } from "./queue.ts";
import { runnerAppId, settingsRepoOf } from "./settings/connect.ts";
import { servedRepos, sourceKeyPath, sourceOf } from "./settings/scheduling.ts";
import type { Sys } from "./sys.ts";

export const WAIT_MS = 10 * 60_000;
export const POLL_MS = 5_000;
export const CONNECT_MS = 60 * 60_000;
export const PHASES = ["making-runner", "installing-runner", "making-source", "installing-source", "keeping"] as const;
export type Phase = (typeof PHASES)[number];

// The op's declaration is src/optypes/connect.ts's.
export const CONNECT_OP = { type: "connect" } as const;

// What the browser should do, in the op's progress text, for the controller to read back.
export type BrowserAsk = { make: AppRole; name: string } | { open: string };
const MAKE = /^make (runner|source) ([a-z0-9][a-z0-9-]{0,33})$/;
const OPEN = /^open (https:\/\/github\.com\/[A-Za-z0-9/_.-]{1,100})$/;
export const askText = (a: BrowserAsk) => ("make" in a ? `make ${a.make} ${a.name}` : `open ${a.open}`);
export function parseAsk(text: unknown): BrowserAsk | undefined {
  if (typeof text !== "string") return undefined;
  const m = MAKE.exec(text);
  if (m) return { make: m[1] as AppRole, name: m[2]! };
  const o = OPEN.exec(text);
  return o ? { open: o[1]! } : undefined;
}

// A code, or why there is none.
export type CodeGot = { code: string } | { stop: string };

export interface FlowDeps {
  sys: Pick<Sys, "fetch" | "timeout" | "now" | "sleep">;
  log: Pick<Log, "secret" | "write">;
  cfg: Config;
  box: string; // this box's name, for the Apps' names
  boxFile: string;
  pendingFile: string; // root's, 600
  keys: { dir: string; ownerUid: number; ownerGid: number };
  chown?: (path: string, uid: number, gid: number) => void;
  rootUid?: number;
  since: number; // when the op began
  say(line: string): void;
  phase(p: Phase, ask?: BrowserAsk): void;
  event(type: string, text: string, data?: Record<string, string | number | boolean>): void;
  code(role: AppRole, name: string, state: string): Promise<CodeGot>;
  open(url: string): void;
  // Whether the op is still running. Its deadline or op cancel ends it, and the flow then stops.
  live?(): boolean;
  // v2's key files still on the box (oldKeyFiles): with them, the product file's App is v2's own.
  v2Keys?: readonly string[];
  // v2's Apps, adopted before anything else when box.json doesn't name the runner App yet; then the
  // settings are read again.
  adopt?: { o: AdoptFrom; reload(): Config };
  // This op's ID: a pending App is recorded under it, so only its own op's end drops it.
  op?: string;
  // Once the keeping phase is reported, waits for the op's record to show it: past that point a
  // cancel is refused, so nothing is kept for an op recorded as cancelled.
  confirmKeeping?(): Promise<void>;
  rand?: (n: number) => Buffer;
}

// The op ended under the flow: its deadline, or op cancel.
export class Ended extends Error {}
const check = (d: Pick<FlowDeps, "live">) => {
  if (d.live && !d.live()) throw new Ended("the connect op ended");
};

type Pending = { appId: number; slug: string; replacing?: number; op?: string };
type PendingFile = { v: 1; apps: Partial<Record<AppRole, Pending>> };

const rand = (d: Pick<FlowDeps, "rand">, n: number) => (d.rand ?? randomBytes)(n);
const owner = (d: Pick<FlowDeps, "rootUid">) => d.rootUid ?? 0;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function readPendingFile(d: Pick<FlowDeps, "pendingFile" | "rootUid">): PendingFile {
  const r = readOwnedJson(d.pendingFile, { owner: owner(d), max: 64 * 1024 }, (v) => (isObj(v) && v.v === 1 && isObj(v.apps) ? (v as unknown as PendingFile) : "not a pending connect"));
  const apps: PendingFile["apps"] = {};
  if (r.kind === "ok") {
    for (const role of ["runner", "source"] as const) {
      const p = r.value.apps[role] as Record<string, unknown> | undefined;
      if (p && Number.isSafeInteger(p.appId) && (p.appId as number) > 0 && typeof p.slug === "string" && SLUG.test(p.slug)) apps[role] = { appId: p.appId as number, slug: p.slug, ...(Number.isSafeInteger(p.replacing) ? { replacing: p.replacing as number } : {}), ...(typeof p.op === "string" && OP_ID.test(p.op) ? { op: p.op } : {}) };
    }
  }
  return { v: 1, apps };
}

function writePendingFile(d: Pick<FlowDeps, "pendingFile" | "rootUid" | "chown">, f: PendingFile): void {
  if (!f.apps.runner && !f.apps.source) return void rmSync(d.pendingFile, { force: true });
  writeOwnedText(d.pendingFile, `${JSON.stringify(f)}\n`, { mode: 0o600, owner: owner(d), ...(d.chown ? { chown: d.chown } : {}) });
}

// box.json with some keys set, the rest as it was, by one rename. A box.json taskbox set aside is
// written anew, and the line says so.
export function writeBoxKeys(d: Pick<FlowDeps, "boxFile" | "rootUid" | "chown"> & { say?: (l: string) => void }, set: Record<string, unknown>): void {
  const b = readBoxFile(d.boxFile, owner(d));
  if (b.problem) d.say?.(`box.json was set aside (${b.problem}), so it is written anew with only what connect keeps.`);
  const next: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(b.settings ?? {})) if (!(k in set)) next[k] = v;
  for (const [k, v] of Object.entries(set)) if (v !== undefined) next[k] = v;
  writeOwnedText(d.boxFile, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o644, owner: owner(d), ...(d.chown ? { chown: d.chown } : {}) });
}

// The App each role keeps today. inBox: box.json names it, so it is v3's; else it is v2's, from the
// product file, which the move to v3 adopts.
export function keptApp(cfg: Config, role: AppRole): { appId: number; slug?: string; inBox: boolean } | undefined {
  if (role === "runner") return { appId: runnerAppId(cfg), ...(cfg.runnerApp ? { slug: cfg.runnerApp.app } : {}), inBox: !!cfg.runnerApp };
  const s = sourceOf(cfg);
  return s.type === "github-actions" ? { appId: s.appId, ...(s.app ? { slug: s.app } : {}), inBox: !!cfg.boxKeys?.includes("sources") } : undefined;
}

export type Wants = { jobs: string; load?: LoadRepo };
export function wantsOf(cfg: Config, o: { jobs?: string; load?: LoadRepo | "off" } = {}): Wants {
  const s = sourceOf(cfg);
  const kept = s.type === "github-actions" ? s.repos.find((r): r is LoadRepo => typeof r === "object") : undefined;
  const load = o.load === "off" ? undefined : (o.load ?? kept);
  return { jobs: o.jobs ?? servedRepos(cfg)[0]!.name, ...(load ? { load } : {}) };
}
// The runner App: the settings repo, and the v2 release repo while a v2 install may read it.
const repoWants = (d: Pick<FlowDeps, "cfg">, role: AppRole, w: Wants): { want: string[]; may: string[] } =>
  role === "runner" ? { want: [settingsRepoOf(d.cfg)], may: d.cfg.releaseRepo ? [`${d.cfg.org}/${d.cfg.releaseRepo}`] : [] } : { want: [w.jobs, ...(w.load ? [w.load.name] : [])], may: [] };

// key: GitHub refuses the key. clock: it refuses because the box's clock is off. fewer: the App lacks
// a right its manifest has.
export type Proof = { ok: true; slug: string; installation: number } | (InstallFail & { ok: false; key?: true; clock?: true; fewer?: true });
const fixable = (p: Proof) => !p.ok && (p.grew || p.waiting === true || p.fewer === true);

// The clock guard from v2: a clock far off gets a 401 for every key, a good one too.
function refused(r: Response, now: number): Proof {
  const off = clockOffsetS(r, now);
  if (off !== null && Math.abs(off) > CLOCK_LIMIT_S) return { ok: false, why: `the box's clock is ${off} s off GitHub's, so GitHub refuses every key. Set the clock right (System Settings, General, Date & Time), then type taskbox connect github again`, grew: false, clock: true };
  return { ok: false, why: "GitHub refuses the App's key (401): the App was deleted, or its key revoked", grew: false, key: true };
}

export async function proveApp(d: Pick<FlowDeps, "sys" | "log" | "cfg">, role: AppRole, app: AppClient, w: { want: string[]; may: string[] }): Promise<Proof> {
  const fail = (why: string, more: { grew?: boolean; fewer?: true; waiting?: true; where?: InstallFail["where"] } = {}): Proof => ({ ok: false, why, grew: false, ...more });
  const a = await app.call("GET", "/app").catch(() => undefined);
  if (!a) return fail("GitHub couldn't be reached");
  if (a.status === 401) return refused(a, d.sys.now());
  if (!a.ok) return fail(`GitHub answered ${a.status} for the App`);
  const b = ((await bodyOf(a)) ?? {}) as Record<string, unknown>;
  if (b.id !== app.appId) return fail("the key signs as another App", { grew: true });
  const slug = typeof b.slug === "string" && SLUG.test(b.slug) ? b.slug : `app-${app.appId}`;
  const want: Record<string, string> = PERMISSIONS[role];
  const got = (isObj(b.permissions) ? b.permissions : {}) as Record<string, unknown>;
  if (Object.keys(got).some((k) => want[k] !== got[k])) return fail(`the App has other rights than its own. On its Permissions page, leave only ${Object.entries(want).map(([k, v]) => `${k} ${v}`).join(", ")}`, { grew: true, where: "permissions" });
  const lacks = Object.keys(want).filter((k) => got[k] !== want[k]);
  if (lacks.length) return fail(`the App lacks ${lacks.map((k) => `${k} ${want[k]}`).join(" and ")}. On its Permissions page, add it, then approve it on its Configure page`, { fewer: true, waiting: true, where: "permissions" });
  if (Array.isArray(b.events) && b.events.length) return fail("the App subscribes to webhook events. Turn its webhook off", { grew: true });
  const hook = await app.call("GET", "/app/hook/config").catch(() => undefined);
  const hookWhy = hook ? hookProblem(hook.status, await bodyOf(hook), d.cfg.org) : "GitHub couldn't be reached";
  if (hookWhy) return fail(hookWhy, { grew: hookWhy === "the App has a webhook" });
  const list = await app.installations().catch(() => undefined);
  if (!list?.ok) return fail(`GitHub answered ${list?.status ?? "nothing"} for the App's installations`);
  const inst = installationsOf(await bodyOf(list));
  if (!inst) return fail("GitHub's list of the App's installations had none");
  const one = installationProblem(inst, { role, org: d.cfg.org });
  if (!("id" in one)) return { ok: false, ...one };
  const t = await app.token(one.id, { permissions: { metadata: "read" } }).catch(() => ({ status: 0 }));
  if ("status" in t) return fail(`GitHub answered ${t.status || "nothing"} for a token`);
  try {
    const names = await tokenRepos(d.sys, t.token).catch(() => ({ status: 0 }));
    if (!Array.isArray(names)) return fail(`GitHub answered ${names.status || "nothing"} for the App's repositories`);
    const r = reposProblem(names, w.want, w.may);
    if (r) return { ok: false, ...r };
  } finally {
    await revokeToken(d.sys, t.token);
  }
  return { ok: true, slug, installation: one.id };
}

const heldKey = (d: Pick<FlowDeps, "keys">, role: AppRole, id: number, pending = false) => readHeldKey(d.keys.dir, d.keys.ownerUid, role, id, pending);
const clientFor = (d: Pick<FlowDeps, "sys" | "log">, id: number, pem: string) => {
  d.log.secret(pem);
  return new AppClient(d.sys, d.log, id, pem);
};

async function slugOf(app: AppClient): Promise<string | undefined> {
  const r = await app.call("GET", "/app").catch(() => undefined);
  const s = r?.ok ? ((await bodyOf(r)) as { slug?: unknown } | undefined)?.slug : undefined;
  return typeof s === "string" && SLUG.test(s) ? s : undefined;
}

// Waits while the owner can fix it on GitHub; each new reason is said once. A refused key ends it.
async function waitTrue(d: FlowDeps, role: AppRole, app: AppClient, w: Wants, first: Proof): Promise<Proof> {
  const until = d.sys.now() + WAIT_MS;
  let said = "";
  let p = first;
  for (;;) {
    if (p.ok || p.key || p.clock) return p;
    if (p.why !== said) {
      said = p.why;
      d.say(`Not yet: ${p.why}.`);
    }
    if (d.sys.now() >= until) return p;
    await d.sys.sleep(POLL_MS);
    check(d);
    p = await proveApp(d, role, app, repoWants(d, role, w));
  }
}

function fixPage(d: FlowDeps, slug: string, p: Proof): string {
  if (p.ok || p.where === "install" || p.where === undefined) return installPage(slug);
  return p.where === "permissions" ? permissionsPage(d.cfg.org, slug) : `${appPage(d.cfg.org, slug)}/installations`;
}

const repoLine = (d: FlowDeps, role: AppRole, w: Wants) => repoWants(d, role, w).want.join(" and ");

// Making one App: the manifest, the code, the conversion and its checks, then the pending record and
// the key handed over. A code GitHub doesn't take is passed over when another may come.
async function makeApp(d: FlowDeps, role: AppRole, other: number | undefined, replacing?: number): Promise<{ id: number; slug: string; pem: string } | undefined> {
  const phase = role === "runner" ? "making-runner" : "making-source";
  const name = appName(d.cfg.org, d.box, role, rand(d, 2).toString("hex"));
  const state = rand(d, 32).toString("hex");
  check(d);
  d.phase(phase, { make: role, name });
  d.say(`You need to be an owner of ${d.cfg.org}. Your browser opens GitHub to make ${ROLE_NAME[role]}, ${name}: click Create GitHub App.`);
  const appsUrl = `https://github.com/organizations/${d.cfg.org}/settings/apps`;
  const got = await d.code(role, name, state);
  check(d);
  if ("stop" in got) return void d.say(got.stop);
  d.log.secret(got.code);
  // One conversion per App per op.
  const res = await apiCall(d.sys, "POST", `/app-manifests/${encodeURIComponent(got.code)}/conversions`).catch(() => undefined);
  if (!res?.ok) {
    // A code taken first by someone else converts once, and the box's conversion then fails.
    d.say(`GitHub didn't give the box the App (${res ? `it answered ${res.status}` : "it couldn't be reached"}). If ${name} is listed at ${appsUrl}, delete it there: whoever converted its code first holds its key, and it was never installed. Then type taskbox connect github again.`);
    d.event("connect.refused", `The box's conversion of ${name}'s code failed.`, { role, name });
    return undefined;
  }
  const raw = (await bodyOf(res)) as Record<string, unknown> | undefined;
  for (const k of ["pem", "client_secret", "webhook_secret", "client_id"]) if (typeof raw?.[k] === "string") d.log.secret(raw[k] as string);
  const conv = conversionProblem(raw, { role, org: d.cfg.org, since: d.since, ...(other !== undefined ? { other } : {}) });
  const refuse = (why: string, slug?: string) => {
    d.say(`GitHub made something the box won't use: ${why}. Nothing was kept.${slug ? ` ${deleteLine(d.cfg.org, slug)}` : ""}`);
    d.event("connect.refused", `An App was refused: ${why}.`, { role, ...(slug ? { slug } : {}) });
    return undefined;
  };
  if ("why" in conv) return refuse(conv.why, conv.made);
  const app = clientFor(d, conv.id, conv.pem);
  const hook = await app.call("GET", "/app/hook/config").catch(() => undefined);
  const hookWhy = hook ? hookProblem(hook.status, await bodyOf(hook), d.cfg.org) : "GitHub couldn't be reached for the App's webhook";
  if (hookWhy) return refuse(hookWhy, conv.slug);
  // Only a definite private answer passes; GitHub is asked again a few times first.
  let pubWhy: string | undefined = "GitHub couldn't be asked whether the App is private";
  for (let i = 0; i < 3 && pubWhy; i++) {
    if (i) await d.sys.sleep(2000);
    const pub = await apiCall(d.sys, "GET", `/apps/${conv.slug}`).catch(() => undefined);
    pubWhy = publicProblem(pub ? pub.status : 0);
  }
  if (pubWhy) return refuse(`${pubWhy}. Delete it, then type taskbox connect github again`, conv.slug);
  // The record first, then the key, so a stop from here on is found again by the next connect.
  const f = readPendingFile(d);
  f.apps[role] = { appId: conv.id, slug: conv.slug, ...(replacing !== undefined && replacing !== conv.id ? { replacing } : {}), ...(d.op ? { op: d.op } : {}) };
  writePendingFile(d, f);
  const why = placePending(d.keys, role, conv.id, conv.pem);
  if (why) {
    delete f.apps[role];
    writePendingFile(d, f);
    d.say(`The App ${conv.slug} is made, but its key couldn't be handed to the GitHub key keeper: ${why}. ${deleteLine(d.cfg.org, conv.slug)}`);
    return undefined;
  }
  d.event("connect.made", `Made ${ROLE_NAME[role]} ${conv.slug}.`, { role, slug: conv.slug, app: conv.id });
  d.say(`Made the App ${conv.slug}.`);
  return { id: conv.id, slug: conv.slug, pem: conv.pem };
}

type Ready = { role: AppRole; id: number; slug: string; installation: number; pending: boolean; replacing?: number };

// One App made true: a pending one finished, a kept one proved and sent to what it lacks, or a new one
// made. undefined, with a line said, when it can't be.
async function trueApp(d: FlowDeps, role: AppRole, w: Wants, other?: number): Promise<Ready | undefined> {
  const installing = role === "runner" ? "installing-runner" : "installing-source";
  const pend = readPendingFile(d).apps[role];
  let target: { id: number; slug: string; pem: string; pending: boolean; replacing?: number } | undefined;
  if (pend) {
    const pem = heldKey(d, role, pend.appId, true) ?? heldKey(d, role, pend.appId);
    if (pem) {
      d.say(`The App ${pend.slug} was made before and isn't kept yet: taskbox finishes it.`);
      if (d.op && pend.op !== d.op) {
        const f = readPendingFile(d);
        f.apps[role] = { ...pend, op: d.op };
        writePendingFile(d, f);
      }
      target = { id: pend.appId, slug: pend.slug, pem, pending: true, ...(pend.replacing !== undefined ? { replacing: pend.replacing } : {}) };
    } else {
      const f = readPendingFile(d);
      delete f.apps[role];
      writePendingFile(d, f);
      d.say(`The App ${pend.slug} was made before, but its key is gone, so it is dropped. ${deleteLine(d.cfg.org, pend.slug)}`);
    }
  }
  const kept = keptApp(d.cfg, role);
  let replacing: number | undefined;
  if (!target && kept) {
    const pem = heldKey(d, role, kept.appId);
    // v2's App, not adopted yet: v2.6.1 still uses it, so no App is made beside it.
    if (!pem && !kept.inBox && d.v2Keys?.length) return void d.say(`${cap(ROLE_NAME[role])} (App ${kept.appId}) is v2's, and the move to v3 adopts it with its key: as your admin user, type taskbox update. connect github makes no App beside it.`);
    if (pem) {
      const app = clientFor(d, kept.appId, pem);
      const p = await proveApp(d, role, app, repoWants(d, role, w));
      if (p.ok) {
        d.say(`${cap(ROLE_NAME[role])} ${p.slug} passes: on ${repoLine(d, role, w)}, with its own rights and no more.`);
        return { role, id: kept.appId, slug: p.slug, installation: p.installation, pending: false };
      }
      if (p.clock) return void d.say(`Not connected: ${p.why}.`);
      if (!p.key) {
        if (!fixable(p)) return void d.say(`${cap(ROLE_NAME[role])} couldn't be checked: ${p.why}. Nothing changed; type taskbox connect github again.`);
        const slug = kept.slug ?? (await slugOf(app)) ?? `app-${kept.appId}`;
        const page = fixPage(d, slug, p);
        check(d);
        d.phase(installing, { open: page });
        d.open(page);
        d.say(`${cap(ROLE_NAME[role])} ${slug}: ${p.why}. Your browser opens the page that fixes it. Waiting up to 10 minutes.`);
        const done = await waitTrue(d, role, app, w, p);
        if (!done.ok) return void d.say(`Not connected: ${done.why}. Type taskbox connect github again once it is fixed.`);
        return { role, id: kept.appId, slug: done.slug, installation: done.installation, pending: false };
      }
      d.say(`${cap(ROLE_NAME[role])} ${kept.slug ?? `App ${kept.appId}`}: ${p.why}. taskbox makes a new App in its place.`);
      replacing = kept.appId;
    } else if (kept.inBox) {
      d.say(`${cap(ROLE_NAME[role])} (App ${kept.appId}) has no key with the GitHub key keeper. taskbox makes a new App in its place.`);
      replacing = kept.appId;
    }
  }
  if (!target) {
    const made = await makeApp(d, role, other, replacing);
    if (!made) return undefined;
    target = { ...made, pending: true, ...(replacing !== undefined && replacing !== made.id ? { replacing } : {}) };
  }
  const app = clientFor(d, target.id, target.pem);
  const first = await proveApp(d, role, app, repoWants(d, role, w));
  check(d);
  if (fixable(first)) {
    const page = fixPage(d, target.slug, first);
    d.phase(installing, { open: page });
    d.open(page);
    d.say(`On the next page, choose Only select repositories, pick ${repoLine(d, role, w)}, and click Install. Waiting up to 10 minutes.`);
  } else d.phase(installing);
  const done = await waitTrue(d, role, app, w, first);
  if (!done.ok) return void d.say(`Not connected: ${done.why}. The App ${target.slug} is kept for the next try: type taskbox connect github to finish it, or taskbox op cancel to drop it.`);
  d.event("connect.installed", `${cap(ROLE_NAME[role])} ${done.slug} is installed and proved.`, { role, slug: done.slug, app: target.id });
  return { role, id: target.id, slug: done.slug, installation: done.installation, pending: target.pending, ...(target.replacing !== undefined ? { replacing: target.replacing } : {}) };
}

// Uninstalls an App with its own key. Whether every installation went.
async function uninstallAll(app: AppClient): Promise<boolean> {
  const r = await app.installations().catch(() => undefined);
  if (!r?.ok) return false;
  let all = true;
  for (const i of installationsOf(await bodyOf(r)) ?? []) {
    const del = await app.uninstall(i.id).catch(() => undefined);
    if (!del || (del.status !== 204 && del.status !== 404)) all = false;
  }
  return all;
}

const sourceSettings = (id: number, slug: string, w: Wants): SourceSettings => ({ type: "github-actions", appId: id, app: slug, repos: [w.jobs, ...(w.load ? [w.load] : [])] });
const sameSource = (a: SourceSettings, b: SourceSettings) =>
  a.type === "github-actions" && b.type === "github-actions" && a.appId === b.appId && a.app === b.app && JSON.stringify(a.repos.map((r) => (typeof r === "string" ? r : [r.name, r.runnerGroup]))) === JSON.stringify(b.repos.map((r) => (typeof r === "string" ? r : [r.name, r.runnerGroup])));

// Keeping, once both are proved: pending keys renamed, box.json written, then each replaced App's key
// goes. A replaced App's key was refused, so it can't uninstall itself: the line gives its delete link.
async function keep(d: FlowDeps, ready: Ready[], w: Wants): Promise<boolean> {
  check(d);
  d.phase("keeping");
  await d.confirmKeeping?.();
  for (const r of ready) {
    const why = r.pending ? promoteKey(d.keys.dir, r.role, r.id) : undefined;
    if (why) return (d.say(`Not connected: ${why}. Nothing in box.json changed; type taskbox connect github again.`), false);
  }
  const runner = ready.find((r) => r.role === "runner");
  const source = ready.find((r) => r.role === "source");
  writeBoxKeys(d, { ...(runner ? { runnerApp: { appId: runner.id, app: runner.slug } } : {}), ...(source ? { sources: [sourceSettings(source.id, source.slug, w)] } : {}) });
  writePendingFile(d, { v: 1, apps: {} });
  for (const r of ready) {
    if (r.replacing === undefined || r.replacing === r.id) continue;
    d.say(`The App it replaces (App ${r.replacing}) can't be reached with its key: uninstall and delete it on GitHub, ${d.cfg.org}'s Settings, GitHub Apps.`);
    dropKey(d.keys.dir, r.role, r.replacing);
  }
  for (const r of ready) d.event("connect.kept", `${cap(ROLE_NAME[r.role])} ${r.slug} is kept.`, { role: r.role, slug: r.slug, app: r.id });
  return true;
}

export type ConnectOpts = { jobs?: string; load?: LoadRepo | "off" };

// taskbox connect github: 0 when both pass, 1 when one couldn't be made true (a line says why). An op
// that ends under it (its deadline, op cancel) drops what it left pending, as op cancel does.
export async function connectGithub(d: FlowDeps, o: ConnectOpts = {}): Promise<number> {
  try {
    if (d.adopt && !d.cfg.runnerApp && d.adopt.o.retire.length) {
      for (const l of await adoptV2(d, d.adopt.o)) d.say(l);
      d.cfg = d.adopt.reload();
    }
    return await connectOnce(d, o);
  } catch (e) {
    if (!(e instanceof Ended)) throw e;
    d.say("The connect ended before it kept anything (its deadline, or op cancel).");
    for (const l of await cancelConnect(d, d.op)) d.say(l);
    return 1;
  }
}

async function connectOnce(d: FlowDeps, o: ConnectOpts): Promise<number> {
  const w = wantsOf(d.cfg, o);
  const jobsOwner = w.jobs.split("/")[0]!;
  if (jobsOwner.toLowerCase() !== d.cfg.org.toLowerCase()) return (d.say(`The jobs repo, ${w.jobs}, is in ${jobsOwner}, and this box's org is ${d.cfg.org}. The job source App installs only in its own org. Nothing changed.`), 1);
  if (w.load && w.load.runnerGroup === d.cfg.runnerGroup) return (d.say(`The test repo's runner group must be its own, never ${d.cfg.runnerGroup}. Nothing changed.`), 1);
  if (o.load === "off") return loadOff(d, w);
  const runner = await trueApp(d, "runner", w, keptApp(d.cfg, "source")?.appId);
  if (!runner) return 1;
  const source = await trueApp(d, "source", w, runner.id);
  if (!source) return 1;
  const ready = [runner, source];
  if (w.load) {
    const why = await loadGroupProblem(d, runner, w.load);
    if (why) return (d.say(`Not connected: ${why}. Nothing changed.`), 1);
  }
  const kept = sourceOf(d.cfg);
  const changed = ready.some((r) => r.pending) || d.cfg.runnerApp?.appId !== runner.id || !d.cfg.boxKeys?.includes("sources") || !sameSource(kept, sourceSettings(source.id, source.slug, w));
  if (!changed) return (d.say("Both Apps pass. Nothing changed."), 0);
  if (!(await keep(d, ready, w))) return 1;
  d.say(`Connected: ${ready.map((r) => `${ROLE_NAME[r.role]} ${r.slug}`).join(" and ")}. The loop takes them once no job runs. taskbox check shows them.`);
  if (o.jobs && o.jobs !== servedRepos(d.cfg)[0]!.name) d.say(`The jobs repo ${o.jobs} also needs jobsFrom and its workflows in the settings (a settings PR), and its templates (taskbox template apply).`);
  return 0;
}

async function loadGroupProblem(d: FlowDeps, runner: Ready, load: LoadRepo): Promise<string | undefined> {
  const pem = heldKey(d, "runner", runner.id, runner.pending);
  if (!pem) return "the runner App's key isn't with the GitHub key keeper";
  const t = await clientFor(d, runner.id, pem).token(runner.installation, { permissions: { organization_self_hosted_runners: "write" } }).catch(() => ({ status: 0 }));
  if ("status" in t) return `GitHub answered ${t.status || "nothing"} for the runner App's token`;
  try {
    const r = await tokenCall(d.sys, t.token, "GET", `/orgs/${d.cfg.org}/actions/runner-groups?per_page=100`);
    if (!r.ok) return `GitHub answered ${r.status} for the runner groups`;
    return runnerGroupsOf(await bodyOf(r)).some((x) => x.name === load.runnerGroup) ? undefined : `there is no runner group named ${load.runnerGroup}`;
  } finally {
    await revokeToken(d.sys, t.token);
  }
}

// --load off: the owner takes the App off the test repo first, then box.json drops it.
async function loadOff(d: FlowDeps, w: Wants): Promise<number> {
  const kept = keptApp(d.cfg, "source");
  const pem = kept ? heldKey(d, "source", kept.appId) : undefined;
  if (!kept || !pem) return (d.say("This box has no job source App yet. Type taskbox connect github first."), 1);
  const app = clientFor(d, kept.appId, pem);
  const only = { want: [w.jobs], may: [] };
  let done = await proveApp(d, "source", app, only);
  if (!done.ok && fixable(done)) {
    const slug = kept.slug ?? (await slugOf(app)) ?? `app-${kept.appId}`;
    const page = `${appPage(d.cfg.org, slug)}/installations`;
    d.phase("installing-source", { open: page });
    d.open(page);
    d.say(`Take the App ${slug} off the test repo: on its Configure page, under Only select repositories, remove it. Waiting up to 10 minutes.`);
    const until = d.sys.now() + WAIT_MS;
    while (!done.ok && fixable(done) && d.sys.now() < until) {
      await d.sys.sleep(POLL_MS);
      check(d);
      done = await proveApp(d, "source", app, only);
    }
  }
  if (!done.ok) return (d.say(`Nothing changed: ${done.why}.`), 1);
  d.phase("keeping");
  writeBoxKeys(d, { sources: [sourceSettings(kept.appId, done.slug, w)] });
  d.event("connect.kept", `The test repo is out of the job source App ${done.slug}.`, { role: "source", slug: done.slug, app: kept.appId });
  d.say("The test repo is out of this box's settings. The loop takes it once no job runs.");
  return 0;
}

type NoCode = Omit<FlowDeps, "code" | "phase" | "since" | "box" | "open">;

// taskbox disconnect github: the source App uninstalled with its own key, none kept, its key gone.
export async function disconnectGithub(d: NoCode): Promise<number> {
  const kept = keptApp(d.cfg, "source");
  if (!kept) return (d.say("This box has no job source App. Nothing changed."), 0);
  const pem = heldKey(d, "source", kept.appId);
  const app = pem ? clientFor(d, kept.appId, pem) : undefined;
  const slug = kept.slug ?? (app ? await slugOf(app) : undefined);
  const named = slug ?? `App ${kept.appId}`;
  const gone = app ? await uninstallAll(app) : false;
  writeBoxKeys(d, { sources: [{ type: "none" }] });
  dropKey(d.keys.dir, "source", kept.appId);
  d.event("connect.disconnected", `The job source App ${named} is disconnected.`, { role: "source", app: kept.appId });
  const uninstalled = gone ? ` The App ${named} is uninstalled.` : ` Uninstall the App ${named} on GitHub: ${d.cfg.org}'s Settings, GitHub Apps, ${named}, Configure.`;
  d.say(`Disconnected. The box follows the jobs its VMs take.${uninstalled} ${slug ? deleteLine(d.cfg.org, slug) : `GitHub keeps the App until you delete it: ${d.cfg.org}'s Settings, GitHub Apps.`}`);
  return 0;
}

// op cancel's hook, and the flow's own at its deadline: a pending App is uninstalled with its own key,
// its key and record go, and the line gives its delete link. A failed uninstall is said.
// op: only that op's pending Apps; undefined drops every one.
export async function cancelConnect(d: Pick<FlowDeps, "sys" | "log" | "cfg" | "keys" | "pendingFile" | "rootUid" | "chown">, op?: string): Promise<string[]> {
  const f = readPendingFile(d);
  const lines: string[] = [];
  for (const role of ["runner", "source"] as const) {
    const p = f.apps[role];
    if (!p || (op !== undefined && p.op !== op)) continue;
    delete f.apps[role];
    const pem = heldKey(d, role, p.appId, true) ?? heldKey(d, role, p.appId);
    const gone = pem ? await uninstallAll(clientFor(d, p.appId, pem)) : true;
    dropKey(d.keys.dir, role, p.appId);
    lines.push(gone ? `Dropped the App ${p.slug} from this box. ${deleteLine(d.cfg.org, p.slug)}` : `Dropped the App ${p.slug}'s key from this box, but it couldn't be uninstalled: uninstall it on GitHub. ${deleteLine(d.cfg.org, p.slug)}`);
  }
  writePendingFile(d, f);
  return lines;
}

// op cancel's cleanup, from the guard's handler context (src/optypes/connect.ts): the op's own pending
// Apps, with the keeper's keys.
export async function cancelPending(c: Pick<import("./core/dispatch.ts").HandlerCtx, "sys" | "cfg" | "p" | "state" | "rootUid" | "chown">, op: string): Promise<string[]> {
  const { uidOf } = await import("./accounts.ts");
  const { BROKER_ACCOUNT, brokerPathsOf } = await import("./keys.ts");
  const { Log } = await import("./log.ts");
  const uid = await uidOf(c.sys, BROKER_ACCOUNT);
  if (uid === undefined) return [];
  return cancelConnect({ sys: c.sys, log: new Log(), cfg: c.cfg, keys: { dir: brokerPathsOf(c.p).keys, ownerUid: uid, ownerGid: 0 }, pendingFile: join(c.state.dir, "connect-pending.json"), rootUid: c.rootUid, ...(c.chown ? { chown: c.chown } : {}) }, op);
}

// ---- The controller's code, through the agent spool ----
// Unsigned, so anyone with the agent account can send one. The controller makes one 64-hex state per
// App and signs only their SHA-256 hashes into its connect github; the box keeps the hashes on the op
// and never holds or hands out a state. A code is taken only with a state whose hash matches,
// compared in constant time; any other is refused here, with no GitHub call. The first code that
// matches is the one conversion that App gets in this op.
export const CODE_KIND = "connect-code";
const OP_ID = /^op_[0-9A-HJKMNP-TV-Z]{26}$/;
const CODE_RE = /^[A-Za-z0-9_-]{1,100}$/;
const HEX64 = /^[0-9a-f]{64}$/;
export function codeRequestProblem(body: Record<string, unknown>): string | undefined {
  if (!Object.keys(body).every((k) => k === "code" || k === "op" || k === "state")) return "a connect code carries its op, its state and its code alone";
  if (typeof body.op !== "string" || !OP_ID.test(body.op)) return "a connect code names its op";
  if (typeof body.state !== "string" || !HEX64.test(body.state)) return "a connect code carries its op's state";
  return typeof body.code === "string" && CODE_RE.test(body.code) ? undefined : "a connect code is one code";
}

// The hashes the signed request carries, as the op keeps them in its params.
export type StateHashes = { runner: string; source: string };
export const stateHash = (state: string) => createHash("sha256").update(state).digest("hex");
export function stateHashesProblem(v: unknown): string | undefined {
  return isObj(v) && Object.keys(v).length === 2 && typeof v.runner === "string" && HEX64.test(v.runner) && typeof v.source === "string" && HEX64.test(v.source) && v.runner !== v.source ? undefined : "a controller's connect carries one state hash per App";
}

export type CodeInbox = { v: 1; op: string; role: AppRole; code: string };

const sameState = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export function takeConnectCode(running: readonly Pick<Op, "id" | "type" | "state" | "phase" | "params">[], inbox: CodeInbox | undefined, req: { op: string; state: string; code: string }): { inbox: CodeInbox } | { why: string } {
  const op = running.find((o) => o.type === CONNECT_OP.type && o.state === "running" && o.id === req.op);
  if (!op) return { why: "no connect by that op is open on this box" };
  if (op.params.from !== "controller") return { why: "that connect takes its code at the box" };
  const role: AppRole | undefined = op.phase === "making-runner" ? "runner" : op.phase === "making-source" ? "source" : undefined;
  if (!role) return { why: "the open connect isn't making an App now" };
  const hashes = op.params.stateHashes as Record<string, unknown> | undefined;
  if (stateHashesProblem(hashes) || !sameState(stateHash(req.state), hashes![role] as string)) return { why: "that code doesn't carry this connect's state" };
  if (inbox && inbox.op === op.id && inbox.role === role) return { why: "this connect took a code for that App already" };
  return { inbox: { v: 1, op: op.id, role, code: req.code } };
}

export function readCodeInbox(path: string, rootUid = 0): CodeInbox | undefined {
  const r = readOwnedJson(path, { owner: rootUid, max: 4096 }, (v) => (isObj(v) && v.v === 1 && typeof v.op === "string" && (v.role === "runner" || v.role === "source") && typeof v.code === "string" && CODE_RE.test(v.code) ? (v as unknown as CodeInbox) : "not a code inbox"));
  return r.kind === "ok" ? r.value : undefined;
}

// The child's side: this op's code for this App, once.
export function codeWaiter(d: Pick<FlowDeps, "sys" | "rootUid" | "live">, path: string, op: string, untilMs: number) {
  return async (role: AppRole): Promise<CodeGot> => {
    for (;;) {
      const c = readCodeInbox(path, d.rootUid ?? 0);
      if (c && c.op === op && c.role === role) return { code: c.code };
      if (d.sys.now() >= untilMs || (d.live && !d.live())) return { stop: "No App was made in time. Nothing changed. Type taskbox connect github to start again." };
      await d.sys.sleep(1000);
    }
  };
}

// ---- The move from v2.6.0 ----
// Each v2 key is read once, proved and handed to the keeper; box.json names the Apps. Then the old
// files move to root's attic, so the service account can no longer read them; a rollback to v2 puts
// them back from there.
export type AdoptFrom = { runnerKey: string; sourceKey?: string; serviceUid: number; attic: string; retire: readonly string[] };
export async function adoptV2(d: NoCode, o: AdoptFrom): Promise<string[]> {
  const lines: string[] = [];
  const set: Record<string, unknown> = {};
  const w = wantsOf(d.cfg);
  const take = async (role: AppRole, id: number, path: string): Promise<string | undefined> => {
    if (existsSync(join(d.keys.dir, keyFileName(role, id)))) {
      const held = heldKey(d, role, id);
      return held ? ((await slugOf(clientFor(d, id, held))) ?? `app-${id}`) : undefined;
    }
    const pem = readAdoptedKey(path, o.serviceUid);
    if (!pem) return void lines.push(`${cap(ROLE_NAME[role])}'s key at ${path} isn't a key file of the service account's own, so it wasn't adopted.`);
    const p = await proveApp(d, role, clientFor(d, id, pem), repoWants(d, role, w));
    if (!p.ok) return void lines.push(`${cap(ROLE_NAME[role])} (App ${id}) wasn't adopted: ${p.why}.`);
    const why = placePending(d.keys, role, id, pem) ?? promoteKey(d.keys.dir, role, id);
    if (why) return void lines.push(`${cap(ROLE_NAME[role])} (App ${id}) wasn't adopted: ${why}.`);
    lines.push(`Adopted ${ROLE_NAME[role]} ${p.slug}.`);
    return p.slug;
  };
  const rslug = await take("runner", d.cfg.appId, o.runnerKey);
  if (rslug) set.runnerApp = { appId: d.cfg.appId, app: rslug };
  const s = sourceOf(d.cfg);
  const sslug = s.type === "github-actions" && o.sourceKey ? await take("source", s.appId, o.sourceKey) : undefined;
  if (s.type === "github-actions" && sslug) set.sources = [sourceSettings(s.appId, sslug, w)];
  if (Object.keys(set).length) writeBoxKeys(d, set);
  // Only once every App is with the keeper: the loop then reads no old file.
  if (rslug && (s.type !== "github-actions" || sslug)) {
    mkdirSync(o.attic, { recursive: true, mode: 0o700 });
    const st = lstatSync(o.attic);
    if (st.isSymbolicLink() || !st.isDirectory() || st.uid !== owner(d) || (st.mode & 0o077) !== 0) return [...lines, `${o.attic} isn't root's alone, so the old key files stay where they are.`];
    for (const f of o.retire) {
      try {
        if (!lstatSync(f).isFile()) continue;
        renameSync(f, join(o.attic, basename(f)));
        lines.push(`Moved the old key file ${f} out of the service account's reach.`);
      } catch {}
    }
  }
  return lines;
}

// The old key files the service account can read, for the move and the "Old App keys" row.
export function oldKeyFiles(p: Pick<Paths, "key" | "oldKey" | "actionsKeyDir">): string[] {
  let names: string[] = [];
  try {
    names = readdirSync(p.actionsKeyDir).filter((n) => /^(actions-.*|runner)\.pem$/.test(n));
  } catch {}
  return [...new Set([p.key, p.oldKey, ...names.map((n) => join(p.actionsKeyDir, n))])].filter((f) => {
    try {
      return lstatSync(f).isFile();
    } catch {
      return false;
    }
  });
}

// ---- taskbox connect status ----
export type AppStatus = { role: AppRole; appId?: number; slug?: string; key: "held" | "missing" | "pending" | "unseen"; keyAgeDays?: number; pending?: { appId: number; slug: string } };
export function connectStatus(d: Pick<FlowDeps, "cfg" | "keys" | "pendingFile" | "rootUid"> & { sys: Pick<Sys, "now"> }): { apps: AppStatus[]; unfinished: boolean } {
  const f = readPendingFile(d);
  const held = listKeys(d.keys.dir);
  let seen = true;
  try {
    readdirSync(d.keys.dir);
  } catch {
    seen = false;
  }
  const apps = (["runner", "source"] as const).map((role): AppStatus => {
    const k = keptApp(d.cfg, role);
    const file = k ? held.find((h) => h.role === role && h.id === k.appId && !h.pending) : undefined;
    let age: number | undefined;
    if (file) {
      try {
        age = Math.max(0, Math.floor((d.sys.now() - lstatSync(join(d.keys.dir, file.name)).mtimeMs) / 86_400_000));
      } catch {}
    }
    const p = f.apps[role];
    return { role, ...(k ? { appId: k.appId } : {}), ...(k?.slug ? { slug: k.slug } : {}), key: file ? "held" : !seen ? "unseen" : p ? "pending" : "missing", ...(age !== undefined ? { keyAgeDays: age } : {}), ...(p ? { pending: { appId: p.appId, slug: p.slug } } : {}) };
  });
  return { apps, unfinished: !!(f.apps.runner || f.apps.source) };
}

// ---- v2's update path ----
// v2's install code keeps a release's source in box.json before the new release, which may drop it, is
// used. It reads the key where v2 placed it.
export interface ReleaseSourceDeps {
  sys: Sys;
  log: Log;
  paths: Paths;
  cfg: Config;
  chown(path: string, uid: number, gid: number): void;
  rootUid?: number;
  serviceUid: number;
}

export async function adoptSource(d: ReleaseSourceDeps, cfg: Config = d.cfg): Promise<{ slug: string } | { why: string }> {
  const box = readBoxFile(d.paths.boxSettings, d.rootUid ?? 0);
  if (box.settings && "sources" in box.settings) return { why: "this box keeps its own source already" };
  const src = sourceOf(d.cfg);
  if (src.type !== "github-actions") return { why: "the release names no job source App" };
  const pem = readActionsKey(d.paths.actionsKeyDir, sourceKeyPath(d.paths, src.appId), d.serviceUid, d.rootUid ?? 0);
  if (!pem) return { why: "the job source App's key isn't on this box" };
  const proof = await proveActionsKey(d, cfg, pem, src.appId);
  if (proof) return { why: proof.why };
  const slug = (await slugOf(clientFor(d, src.appId, pem))) ?? `app-${src.appId}`;
  // Also under its App's ID; the old file stays for an undo to a release that reads only it.
  if (sourceKeyPath(d.paths, src.appId) !== join(d.paths.actionsKeyDir, `actions-${src.appId}.pem`)) {
    const why = await placeSourceKey(d, pem, src.appId, d.serviceUid);
    if (why) return { why };
  }
  const s = sourceOf(cfg);
  const load = s.type === "github-actions" ? s.repos.filter((r): r is LoadRepo => typeof r === "object") : [];
  writeOwnedText(d.paths.boxSettings, `${JSON.stringify({ sources: [{ type: "github-actions", appId: src.appId, app: slug, repos: [cfg.jobsFrom, ...load] }] }, null, 2)}\n`, { mode: 0o644, owner: d.rootUid ?? 0, chown: d.chown });
  return { slug };
}

// ---- The op ----
// At the box the admin's command runs the flow and writes the op's first record; from then on it holds
// the lease and sends reports, and the guard's follow is the record's only writer. from: "box" or
// "controller", which says where the code comes from.
export function openConnectOp(o: { ops: OpFolder; now: number; boot: string; actor: string; params: Record<string, Json> }): { op: Op; send: (r: Report) => void } | { why: string } {
  const b = begin(listOps(o.ops).ops, opType(CONNECT_OP.type), { subject: "box", params: o.params, actor: o.actor, deadline: o.now + CONNECT_MS }, o.now);
  if (b.kind !== "start") return { why: b.kind === "busy" ? b.why : `A connect (${b.op.id}) is running already. taskbox op show ${b.op.id} -w follows it.` };
  const op = { ...b.op, child: { label: jobLabel(b.op.id), boot: o.boot, spawnedAt: o.now, applied: 0, events: ["connect."], limitMs: CONNECT_MS } };
  writeOp(o.ops, op);
  const r = reporter({ op: op.id, reports: reportsPath(o.ops, op.id), progress: progressPath(o.ops, op.id), lease: leasePath(o.ops, op.id), exit: (c) => process.exit(c) });
  return { op, send: (x) => r.send(x) };
}

// Whether a connect op is running: disconnect waits for it.
export const connectRunning = (ops: Pick<OpFolder, "dir" | "owner">) => listOps(ops).ops.find((x) => x.type === CONNECT_OP.type && x.state === "running");

// The guard's side, for the shared request dispatcher: one connect-code request applied to the inbox
// (root's, 600). The outcome's why, or undefined when the code was kept.
export function applyCodeRequest(o: { inbox: string; ops: Pick<OpFolder, "dir" | "owner">; rootUid?: number; chown?: (p: string, u: number, g: number) => void }, body: Record<string, unknown>): string | undefined {
  const why = codeRequestProblem(body);
  if (why) return why;
  const t = takeConnectCode(listOps(o.ops).ops, readCodeInbox(o.inbox, o.rootUid ?? 0), { op: body.op as string, state: body.state as string, code: body.code as string });
  if ("why" in t) return t.why;
  writeOwnedText(o.inbox, `${JSON.stringify(t.inbox)}\n`, { mode: 0o600, owner: o.rootUid ?? 0, ...(o.chown ? { chown: o.chown } : {}) });
  return undefined;
}

// The agent spool's connect-code handler, in the shape of the shared dispatcher's unsigned handlers
// (core/dispatch.ts on its branch): its handlers list adds this one line once it lands.
// The requests pass writes one summary of refused codes a pass; the handler writes none.
export const CONNECT_CODE_HANDLER: UnsignedHandler = {
  kind: CODE_KIND,
  check: codeRequestProblem,
  async apply(c, r) {
    const why = applyCodeRequest({ inbox: join(c.state.dir, "connect-code.json"), ops: { dir: c.state.ops, owner: c.rootUid }, rootUid: c.rootUid, ...(c.chown ? { chown: c.chown } : {}) }, r.body);
    return why ? { ok: false, said: why, code: "denied" } : { ok: true, said: "The box took the code." };
  },
};

// The spool's screen for connect-code files, made once a pass: the running controller connects and
// their state hashes are read once, then each file costs one small read and a hash. A file that
// can't be one the open connect takes is dropped before the cut.
export function connectCodeScreen(o: { ops: Pick<OpFolder, "dir" | "owner">; spool: string; agent: number; now: number }): (name: string) => boolean {
  let open: Pick<Op, "id" | "type" | "state" | "phase" | "params">[] | undefined;
  return (name) => {
    open ??= listOps(o.ops).ops.filter((x) => x.type === CONNECT_OP.type && x.state === "running" && x.params.from === "controller");
    if (!open.length) return false;
    const f = readSpoolFile(join(o.spool, name), o.agent);
    const rr = f ? readRequest(name, f, { owner: o.agent, now: o.now, kinds: { [CODE_KIND]: codeRequestProblem } }) : undefined;
    if (!rr?.ok) return false;
    const b = rr.request.body;
    return "inbox" in takeConnectCode(open, undefined, { op: b.op as string, state: b.state as string, code: b.code as string });
  };
}

// A controller's connect, opened by the guard for its signed connect github: the op's record, with
// the state hashes its statement carried. The guard then starts the child (connectchild.ts) through
// runChild. Nothing secret comes back.
export function openControllerConnect(o: { ops: OpFolder; now: number; actor: string; params: Record<string, Json>; stateHashes: unknown }): { op: Op } | { why: string } {
  const why = stateHashesProblem(o.stateHashes);
  if (why) return { why };
  const h = o.stateHashes as StateHashes;
  const b = begin(listOps(o.ops).ops, opType(CONNECT_OP.type), { subject: "box", params: { ...o.params, from: "controller", stateHashes: { runner: h.runner, source: h.source } }, actor: o.actor, deadline: o.now + CONNECT_MS }, o.now);
  if (b.kind !== "start") return { why: b.kind === "busy" ? b.why : `A connect (${b.op.id}) is running already. taskbox op show ${b.op.id} -w follows it.` };
  writeOp(o.ops, b.op);
  return { op: b.op };
}

// Waits for the op's record to show the keeping phase, at most a minute: the guard applies reports
// each tick. An op that ended stops the flow.
export async function confirmPhase(d: { sys: Pick<Sys, "sleep" | "now">; read(): Op | undefined }, phase: Phase): Promise<void> {
  const until = d.sys.now() + 60_000;
  for (;;) {
    const op = d.read();
    if (!op || op.state !== "running") throw new Ended("the connect op ended");
    if (op.phase === phase) return;
    if (d.sys.now() >= until) throw new Ended("the guard didn't record the keeping phase");
    await d.sys.sleep(1000);
  }
}

// The guard's cleanup: a pending App whose op was cancelled or passed its deadline is dropped, as op
// cancel does, whichever process ran the op. A connect that failed on its own keeps its App for the
// next connect to finish.
export async function cleanEndedConnects(d: Pick<FlowDeps, "sys" | "log" | "cfg" | "keys" | "pendingFile" | "rootUid" | "chown">, ops: Pick<OpFolder, "dir" | "owner">): Promise<string[]> {
  const f = readPendingFile(d);
  const lines: string[] = [];
  for (const id of new Set([f.apps.runner?.op, f.apps.source?.op].filter((x): x is string => !!x))) {
    const r = readOp(ops, id);
    const ended = r.kind === "ok" && (r.value.state === "cancelled" || (r.value.state === "failed" && r.value.why === "it passed its deadline"));
    if (ended) lines.push(...(await cancelConnect(d, id)));
  }
  return lines;
}

// Where v2 put its keys, for the move: the runner key in root's folder (v2.8.0) or the service's
// home, the source key under its App's ID, and every old file to move once both are kept.
export function v2AdoptFrom(p: Paths, cfg: Config, serviceUid: number): AdoptFrom {
  const s = sourceOf(cfg);
  return {
    runnerKey: existsSync(p.key) ? p.key : p.oldKey,
    ...(s.type === "github-actions" ? { sourceKey: sourceKeyPath(p, s.appId) } : {}),
    serviceUid,
    attic: join(dirname(p.installId), "v2-keys"),
    retire: oldKeyFiles(p),
  };
}
