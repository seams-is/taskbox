// taskbox connect github and disconnect github: the steps that talk to GitHub and change the box.
// One op makes both of the box's Apps true, the runner App first: an App that is missing is made by
// GitHub's manifest flow, one that lacks rights or repos sends the owner to the page that fixes it, an
// unfinished connect is finished, and one that passes is left as it is. Root converts the code GitHub
// hands back, checks the App before it keeps anything, hands its key to the GitHub key keeper as a
// pending key, waits for the install, proves it, and only then keeps it. The controller never converts a
// code or holds a key.
//
// Where the code comes from is the caller's: the listener at the box (cmd/connect.ts), or a controller's
// code through the agent spool (takeConnectCode). Everything else is here, so both paths are one
// flow. src/connect.ts has the pure checks, keys.ts the key folder, broker.ts the keeper.
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readBoxFile } from "./boxsettings.ts";
import { type AppRole, appName, appPage, conversionProblem, deleteLine, hookProblem, type InstallFail, installationProblem, installationsOf, installPage, PERMISSIONS, permissionsPage, reposProblem, ROLE_NAME, SLUG } from "./connect.ts";
import type { Config, LoadRepo, SourceSettings } from "./config.ts";
import type { OpType } from "./core/ops.ts";
import { isObj, readOwnedJson, writeOwnedText } from "./core/rootfile.ts";
import { AppClient, apiCall, bodyOf, revokeToken, runnerGroupsOf, tokenCall, tokenRepos } from "./github.ts";
import { dropKey, keyFileName, listKeys, placePending, promoteKey, readAdoptedKey, readHeldKey } from "./keys.ts";
import type { Log } from "./log.ts";
import { runnerAppId, settingsRepoOf } from "./settings/connect.ts";
import { servedRepos, sourceOf } from "./settings/scheduling.ts";
import type { Sys } from "./sys.ts";

export const WAIT_MS = 10 * 60_000;
export const POLL_MS = 5_000;
export const CONNECT_MS = 60 * 60_000;
export const PHASES = ["making-runner", "installing-runner", "making-source", "installing-source", "keeping"] as const;
export type Phase = (typeof PHASES)[number];

// The op as core/ops.ts runs it: cancellable until it keeps, an hour at most, and a restart fails it
// (a pending App is found again by the next connect).
export const CONNECT_OP: OpType = { type: "connect", phases: [...PHASES], pointOfNoReturn: "keeping", cancellable: true, onBoot: () => "fail" };

// What the person at the browser does, as the op's progress says it: a controller reads these words to
// know what to open. make: start the listener for this App. open: open this page.
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

// A code, or why there is none: the person closed the tab, the listener stopped, or time ran out.
export type CodeGot = { code: string } | { stop: string };

export interface FlowDeps {
  sys: Pick<Sys, "fetch" | "timeout" | "now" | "sleep">;
  log: Pick<Log, "secret" | "write">;
  cfg: Config; // the settings in force
  box: string; // this box's name, for the Apps' names
  boxFile: string; // /opt/taskbox-state/box.json
  pendingFile: string; // /opt/taskbox-state/connect-pending.json: root's, 600
  keys: { dir: string; ownerUid: number; ownerGid: number };
  chown?: (path: string, uid: number, gid: number) => void;
  rootUid?: number;
  since: number; // when the op began: an App made before it isn't this connect's
  say(line: string): void;
  phase(p: Phase, ask?: BrowserAsk): void; // the op's phase, and what the browser should do now
  event(type: string, text: string, data?: Record<string, string | number | boolean>): void;
  code(role: AppRole, name: string, state: string): Promise<CodeGot>;
  open(url: string): void;
  rand?: (n: number) => Buffer;
}

type Pending = { appId: number; slug: string; replacing?: number };
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
      if (p && Number.isSafeInteger(p.appId) && (p.appId as number) > 0 && typeof p.slug === "string" && SLUG.test(p.slug)) apps[role] = { appId: p.appId as number, slug: p.slug, ...(Number.isSafeInteger(p.replacing) ? { replacing: p.replacing as number } : {}) };
    }
  }
  return { v: 1, apps };
}

function writePendingFile(d: Pick<FlowDeps, "pendingFile" | "rootUid" | "chown">, f: PendingFile): void {
  if (!f.apps.runner && !f.apps.source) {
    rmSync(d.pendingFile, { force: true });
    return;
  }
  writeOwnedText(d.pendingFile, `${JSON.stringify(f)}\n`, { mode: 0o600, owner: owner(d), ...(d.chown ? { chown: d.chown } : {}) });
}

// box.json with some keys set, the rest as it was, by one rename.
export function writeBoxKeys(d: Pick<FlowDeps, "boxFile" | "rootUid" | "chown">, set: Record<string, unknown>): void {
  const now = readBoxFile(d.boxFile, owner(d)).settings ?? {};
  const next: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(now)) if (!(k in set)) next[k] = v;
  for (const [k, v] of Object.entries(set)) if (v !== undefined) next[k] = v;
  writeOwnedText(d.boxFile, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o644, owner: owner(d), ...(d.chown ? { chown: d.chown } : {}) });
}

// The App each role keeps today: its ID and slug, from box.json or the product file.
export function keptApp(cfg: Config, role: AppRole): { appId: number; slug?: string } | undefined {
  if (role === "runner") return { appId: runnerAppId(cfg), ...(cfg.runnerApp ? { slug: cfg.runnerApp.app } : {}) };
  const s = sourceOf(cfg);
  return s.type === "github-actions" ? { appId: s.appId, ...(s.app ? { slug: s.app } : {}) } : undefined;
}

// The repos the source App must be on. jobs: the jobs repo (by --jobs, or the settings). load: the
// test repo, or off.
export type Wants = { jobs: string; load?: LoadRepo };
export function wantsOf(cfg: Config, o: { jobs?: string; load?: LoadRepo | "off" } = {}): Wants {
  const s = sourceOf(cfg);
  const kept = s.type === "github-actions" ? s.repos.find((r): r is LoadRepo => typeof r === "object") : undefined;
  const load = o.load === "off" ? undefined : (o.load ?? kept);
  return { jobs: o.jobs ?? servedRepos(cfg)[0]!.name, ...(load ? { load } : {}) };
}
// The runner App: the settings repo only, and the v2 release repo while a v2 install may read it.
const repoWants = (d: Pick<FlowDeps, "cfg">, role: AppRole, w: Wants): { want: string[]; may: string[] } =>
  role === "runner" ? { want: [settingsRepoOf(d.cfg)], may: d.cfg.releaseRepo ? [`${d.cfg.org}/${d.cfg.releaseRepo}`] : [] } : { want: [w.jobs, ...(w.load ? [w.load.name] : [])], may: [] };

// Why an App, as its key signs, isn't true for its role: its own rights and events, its webhook, its
// one installation, and the repos that installation reaches. A token is made to list the repos, and
// revoked after. key: GitHub refuses the key. fewer: the App lacks a right its manifest has.
export type Proof = { ok: true; slug: string; installation: number } | (InstallFail & { ok: false; key?: true; fewer?: true });

export async function proveApp(d: Pick<FlowDeps, "sys" | "log" | "cfg">, role: AppRole, app: AppClient, w: { want: string[]; may: string[] }): Promise<Proof> {
  const fail = (why: string, more: { grew?: boolean; key?: true; fewer?: true; waiting?: true } = {}): Proof => ({ ok: false, why, grew: false, ...more });
  const a = await app.call("GET", "/app").catch(() => undefined);
  if (!a) return fail("GitHub couldn't be reached");
  if (a.status === 401) return fail("GitHub refuses the App's key (401): the App was deleted, or its key revoked", { key: true });
  if (!a.ok) return fail(`GitHub answered ${a.status} for the App`);
  const b = ((await bodyOf(a)) ?? {}) as Record<string, unknown>;
  if (b.id !== app.appId) return fail("the key signs as another App", { grew: true });
  const slug = typeof b.slug === "string" && SLUG.test(b.slug) ? b.slug : `app-${app.appId}`;
  const want: Record<string, string> = PERMISSIONS[role];
  const got = (isObj(b.permissions) ? b.permissions : {}) as Record<string, unknown>;
  if (Object.keys(got).some((k) => want[k] !== got[k])) return fail(`the App has other rights than its own. On its Permissions page, leave only ${Object.entries(want).map(([k, v]) => `${k} ${v}`).join(", ")}`, { grew: true });
  const lacks = Object.keys(want).filter((k) => got[k] !== want[k]);
  if (lacks.length) return fail(`the App lacks ${lacks.map((k) => `${k} ${want[k]}`).join(" and ")}. On its Permissions page, add it, then approve it on its Configure page`, { fewer: true, waiting: true });
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

// Waits for an App to be true: each poll proves it, a new reason is said once, and the wait goes on
// while the owner can fix it on GitHub. A refused key ends it.
async function waitTrue(d: FlowDeps, role: AppRole, app: AppClient, w: Wants, first: Proof): Promise<Proof> {
  const until = d.sys.now() + WAIT_MS;
  let said = "";
  let p = first;
  for (;;) {
    if (p.ok || p.key) return p;
    if (p.why !== said) {
      said = p.why;
      d.say(`Not yet: ${p.why}.`);
    }
    if (d.sys.now() >= until) return p;
    await d.sys.sleep(POLL_MS);
    p = await proveApp(d, role, app, repoWants(d, role, w));
  }
}

// The page that fixes what the proof named: the install page for a missing installation or repo, the
// permissions page for a missing right, else the App's installations.
function fixPage(d: FlowDeps, slug: string, p: Proof): string {
  if (p.ok) return installPage(slug);
  if (p.fewer) return permissionsPage(d.cfg.org, slug);
  if (/isn't installed yet|isn't on .* yet/.test(p.why)) return installPage(slug);
  return `${appPage(d.cfg.org, slug)}/installations`;
}

const repoLine = (d: FlowDeps, role: AppRole, w: Wants) => repoWants(d, role, w).want.join(" and ");

// Making one App: the manifest, the code, the conversion and its checks, the webhook check, then the
// pending record and the key handed to the keeper as pending. The new App, or undefined with a line.
async function makeApp(d: FlowDeps, role: AppRole, replacing?: number): Promise<{ id: number; slug: string; pem: string } | undefined> {
  const phase = role === "runner" ? "making-runner" : "making-source";
  const name = appName(d.cfg.org, d.box, role, rand(d, 2).toString("hex"));
  const state = rand(d, 32).toString("hex");
  d.phase(phase, { make: role, name });
  d.say(`You need to be an owner of ${d.cfg.org}. Your browser opens GitHub to make ${ROLE_NAME[role]}, ${name}: click Create GitHub App.`);
  const got = await d.code(role, name, state);
  if ("stop" in got) return void d.say(got.stop);
  d.log.secret(got.code);
  const appsUrl = `https://github.com/organizations/${d.cfg.org}/settings/apps`;
  const res = await apiCall(d.sys, "POST", `/app-manifests/${encodeURIComponent(got.code)}/conversions`).catch(() => undefined);
  if (!res?.ok) {
    // A code taken first by someone else converts once, and the box's conversion then fails.
    d.say(`GitHub didn't give the box the App (${res ? `it answered ${res.status}` : "it couldn't be reached"}). If ${name} is listed at ${appsUrl}, delete it there: whoever converted its code first holds its key, and it was never installed. Then type taskbox connect github again.`);
    d.event("connect.refused", `The box's conversion of ${name}'s code failed.`, { role, name });
    return undefined;
  }
  const raw = (await bodyOf(res)) as Record<string, unknown> | undefined;
  for (const k of ["pem", "client_secret", "webhook_secret", "client_id"]) if (typeof raw?.[k] === "string") d.log.secret(raw[k] as string);
  const other = keptApp(d.cfg, role === "runner" ? "source" : "runner")?.appId;
  const conv = conversionProblem(raw, { role, org: d.cfg.org, since: d.since, ...(other !== undefined ? { other } : {}) });
  if ("why" in conv) {
    d.say(`GitHub made something the box won't use: ${conv.why}. Nothing was kept.${conv.made ? ` ${deleteLine(d.cfg.org, conv.made)}` : ""}`);
    d.event("connect.refused", `An App was refused: ${conv.why}.`, { role, ...(conv.made ? { slug: conv.made } : {}) });
    return undefined;
  }
  const app = clientFor(d, conv.id, conv.pem);
  const hook = await app.call("GET", "/app/hook/config").catch(() => undefined);
  const hookWhy = hook ? hookProblem(hook.status, await bodyOf(hook), d.cfg.org) : "GitHub couldn't be reached for the App's webhook";
  if (hookWhy) {
    d.say(`GitHub made something the box won't use: ${hookWhy}. Nothing was kept. ${deleteLine(d.cfg.org, conv.slug)}`);
    d.event("connect.refused", `An App was refused: ${hookWhy}.`, { role, slug: conv.slug, app: conv.id });
    return undefined;
  }
  // The record first, then the key, so a stop from here on is found again by the next connect.
  const f = readPendingFile(d);
  f.apps[role] = { appId: conv.id, slug: conv.slug, ...(replacing !== undefined && replacing !== conv.id ? { replacing } : {}) };
  writePendingFile(d, f);
  const why = placePending({ ...d.keys, chown: d.chown ?? (() => {}) }, role, conv.id, conv.pem);
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

// One App, made true: finish a pending one, prove the kept one and send the owner to what it lacks,
// or make it. What keeping needs, or undefined with a line said.
type Ready = { role: AppRole; id: number; slug: string; installation: number; pending: boolean; replacing?: number };

async function trueApp(d: FlowDeps, role: AppRole, w: Wants): Promise<Ready | undefined> {
  const installing = role === "runner" ? "installing-runner" : "installing-source";
  const pend = readPendingFile(d).apps[role];
  let target: { id: number; slug: string; pem: string; pending: boolean; replacing?: number } | undefined;
  if (pend) {
    const pem = heldKey(d, role, pend.appId, true);
    if (pem) {
      d.say(`The App ${pend.slug} was made before and isn't kept yet: taskbox finishes it.`);
      target = { id: pend.appId, slug: pend.slug, pem, pending: true, ...(pend.replacing !== undefined ? { replacing: pend.replacing } : {}) };
    } else {
      const f = readPendingFile(d);
      delete f.apps[role];
      writePendingFile(d, f);
      d.say(`The App ${pend.slug} was made before, but its key is gone, so it is dropped. ${deleteLine(d.cfg.org, pend.slug)}`);
    }
  }
  const kept = keptApp(d.cfg, role);
  if (!target && kept) {
    const pem = heldKey(d, role, kept.appId);
    if (pem) {
      const app = clientFor(d, kept.appId, pem);
      const p = await proveApp(d, role, app, repoWants(d, role, w));
      if (p.ok) {
        d.say(`${cap(ROLE_NAME[role])} ${p.slug} passes: on ${repoLine(d, role, w)}, with its own rights and no more.`);
        return { role, id: kept.appId, slug: p.slug, installation: p.installation, pending: false };
      }
      if (p.key) d.say(`${cap(ROLE_NAME[role])} ${kept.slug ?? `App ${kept.appId}`}: ${p.why}. taskbox makes a new App in its place.`);
      else {
        const slug = kept.slug ?? (await slugOf(app)) ?? `app-${kept.appId}`;
        const page = fixPage(d, slug, p);
        d.phase(installing, { open: page });
        d.open(page);
        d.say(`${cap(ROLE_NAME[role])} ${slug}: ${p.why}. Your browser opens the page that fixes it. Waiting up to 10 minutes.`);
        const done = await waitTrue(d, role, app, w, p);
        if (!done.ok) return void d.say(`Not connected: ${done.why}. Type taskbox connect github again once it is fixed.`);
        return { role, id: kept.appId, slug: done.slug, installation: done.installation, pending: false };
      }
    }
  }
  if (!target) {
    const made = await makeApp(d, role, kept?.appId);
    if (!made) return undefined;
    target = { ...made, pending: true, ...(kept && kept.appId !== made.id ? { replacing: kept.appId } : {}) };
  }
  const app = clientFor(d, target.id, target.pem);
  const first = await proveApp(d, role, app, repoWants(d, role, w));
  if (!first.ok) {
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

// Uninstalls an App with its own key, so a copied key reads nothing. Whether every installation went.
async function uninstallAll(app: AppClient): Promise<boolean> {
  const r = await app.installations().catch(() => undefined);
  if (!r?.ok) return false;
  const list = installationsOf(await bodyOf(r)) ?? [];
  let all = true;
  for (const i of list) {
    const del = await app.uninstall(i.id).catch(() => undefined);
    if (!del || (del.status !== 204 && del.status !== 404)) all = false;
  }
  return all;
}

const sourceSettings = (id: number, slug: string, w: Wants): SourceSettings => ({ type: "github-actions", appId: id, app: slug, repos: [w.jobs, ...(w.load ? [w.load] : [])] });

// Keeping, once both Apps are proved: each pending key becomes the App's key, box.json names the Apps
// by one rename, then each App replaced is uninstalled with its own key and its key file goes.
async function keep(d: FlowDeps, ready: Ready[], w: Wants): Promise<void> {
  d.phase("keeping");
  for (const r of ready) if (r.pending) promoteKey(d.keys.dir, r.role, r.id);
  const runner = ready.find((r) => r.role === "runner");
  const source = ready.find((r) => r.role === "source");
  writeBoxKeys(d, {
    ...(runner ? { runnerApp: { appId: runner.id, app: runner.slug } } : {}),
    ...(source ? { sources: [sourceSettings(source.id, source.slug, w)] } : {}),
  });
  writePendingFile(d, { v: 1, apps: {} });
  for (const r of ready) {
    if (r.replacing === undefined || r.replacing === r.id) continue;
    const old = heldKey(d, r.role, r.replacing);
    if (old) {
      const app = clientFor(d, r.replacing, old);
      const slug = await slugOf(app);
      d.say((await uninstallAll(app)) ? `Uninstalled the App it replaces (App ${r.replacing}), so its key reads nothing.` : `The App it replaces (App ${r.replacing}) couldn't be uninstalled. Uninstall it on GitHub.`);
      if (slug) d.say(deleteLine(d.cfg.org, slug));
    } else d.say(`The App it replaces (App ${r.replacing}) has no key on this box, so taskbox can't uninstall it. Uninstall it on GitHub, and delete it.`);
    dropKey(d.keys.dir, r.role, r.replacing);
  }
  for (const r of ready) d.event("connect.kept", `${cap(ROLE_NAME[r.role])} ${r.slug} is kept.`, { role: r.role, slug: r.slug, app: r.id });
}

export type ConnectOpts = { jobs?: string; load?: LoadRepo | "off" };

// taskbox connect github: both Apps made true, the runner App first, then kept together. 0 when both
// pass, 1 when one couldn't be made true (a line says why and what to do).
export async function connectGithub(d: FlowDeps, o: ConnectOpts = {}): Promise<number> {
  const w = wantsOf(d.cfg, o);
  const jobsOwner = w.jobs.split("/")[0]!;
  if (jobsOwner.toLowerCase() !== d.cfg.org.toLowerCase()) return (d.say(`The jobs repo, ${w.jobs}, is in ${jobsOwner}, and this box's org is ${d.cfg.org}. The job source App installs only in its own org. Nothing changed.`), 1);
  if (w.load && w.load.runnerGroup === d.cfg.runnerGroup) return (d.say(`The test repo's runner group must be its own, never ${d.cfg.runnerGroup}. Nothing changed.`), 1);
  if (o.load === "off") return loadOff(d, w);
  const ready: Ready[] = [];
  for (const role of ["runner", "source"] as const) {
    const r = await trueApp(d, role, w);
    if (!r) return 1;
    ready.push(r);
  }
  if (w.load) {
    const why = await loadGroupProblem(d, ready[0]!, w.load);
    if (why) return (d.say(`Not connected: ${why}. Nothing changed.`), 1);
  }
  const src = ready[1]!;
  const changed = ready.some((r) => r.pending) || d.cfg.runnerApp?.appId !== ready[0]!.id || !d.cfg.boxKeys?.includes("sources") || JSON.stringify(sourceOf(d.cfg)) !== JSON.stringify(sourceSettings(src.id, src.slug, w));
  if (!changed) return (d.say("Both Apps pass. Nothing changed."), 0);
  await keep(d, ready, w);
  d.say(`Connected: ${ready.map((r) => `${ROLE_NAME[r.role]} ${r.slug}`).join(" and ")}. The loop takes them once no job runs. taskbox check shows them.`);
  if (o.jobs && o.jobs !== servedRepos(d.cfg)[0]!.name) d.say(`The jobs repo ${o.jobs} also needs jobsFrom and its workflows in runnerGroup.workflows in the settings (a settings PR), and its templates (taskbox template apply).`);
  return 0;
}

// The test repo's runner group, through the runner App: there, and not the box's own group.
async function loadGroupProblem(d: FlowDeps, runner: Ready, load: LoadRepo): Promise<string | undefined> {
  const pem = heldKey(d, "runner", runner.id, runner.pending);
  if (!pem) return "the runner App's key isn't with the GitHub key keeper";
  const app = clientFor(d, runner.id, pem);
  const t = await app.token(runner.installation, { permissions: { organization_self_hosted_runners: "write" } }).catch(() => ({ status: 0 }));
  if ("status" in t) return `GitHub answered ${t.status || "nothing"} for the runner App's token`;
  try {
    const r = await tokenCall(d.sys, t.token, "GET", `/orgs/${d.cfg.org}/actions/runner-groups?per_page=100`);
    if (!r.ok) return `GitHub answered ${r.status} for the runner groups`;
    if (!runnerGroupsOf(await bodyOf(r)).some((x) => x.name === load.runnerGroup)) return `there is no runner group named ${load.runnerGroup}`;
    return undefined;
  } finally {
    await revokeToken(d.sys, t.token);
  }
}

// --load off: the owner takes the App off the test repo first, then the box's source drops it, so the
// App is never on a repo the box's settings don't name.
async function loadOff(d: FlowDeps, w: Wants): Promise<number> {
  const kept = keptApp(d.cfg, "source");
  const pem = kept ? heldKey(d, "source", kept.appId) : undefined;
  if (!kept || !pem) return (d.say("This box has no job source App yet. Type taskbox connect github first."), 1);
  const app = clientFor(d, kept.appId, pem);
  const only = { want: [w.jobs], may: [] };
  let done = await proveApp(d, "source", app, only);
  if (!done.ok && !done.key) {
    const slug = kept.slug ?? (await slugOf(app)) ?? `app-${kept.appId}`;
    const page = `${appPage(d.cfg.org, slug)}/installations`;
    d.phase("installing-source", { open: page });
    d.open(page);
    d.say(`Take the App ${slug} off the test repo: on its Configure page, under Only select repositories, remove it. Waiting up to 10 minutes.`);
    const until = d.sys.now() + WAIT_MS;
    while (!done.ok && !done.key && d.sys.now() < until) {
      await d.sys.sleep(POLL_MS);
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

// taskbox disconnect github: the source App is uninstalled with its own key, box.json keeps "none" as
// the source, and its key goes.
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

// op cancel on a connect: a pending App is uninstalled with its own key if it was installed, its key
// and record go, and the lines give each one's delete link.
export async function cancelConnect(d: Omit<NoCode, "say" | "event">): Promise<string[]> {
  const f = readPendingFile(d);
  const lines: string[] = [];
  for (const role of ["runner", "source"] as const) {
    const p = f.apps[role];
    if (!p) continue;
    const pem = heldKey(d, role, p.appId, true);
    if (pem) await uninstallAll(clientFor(d, p.appId, pem));
    dropKey(d.keys.dir, role, p.appId);
    lines.push(`Dropped the App ${p.slug} from this box. ${deleteLine(d.cfg.org, p.slug)}`);
  }
  writePendingFile(d, { v: 1, apps: {} });
  return lines;
}

// ---- The controller's code, through the agent spool ----
// The code is unsigned: GitHub's conversion needs no authentication, so whoever holds a code converts
// it first, and a signature over it would add nothing. The box takes one code per App, once, and only
// while a connect op is open and making that App. It says nothing about who sent it.
export const CODE_KIND = "connect-code";
export function codeRequestProblem(body: Record<string, unknown>): string | undefined {
  if (!Object.keys(body).every((k) => k === "code")) return "a connect code carries its code alone";
  return typeof body.code === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(body.code) ? undefined : "a connect code is one code";
}

export type CodeInbox = { v: 1; op: string; role: AppRole; code: string; at: number };

// The guard takes a code for the open connect op. running: the ops running now. The inbox to write, or
// why the code is refused. A code already taken for this op and App refuses any other.
export function takeConnectCode(running: readonly { id: string; type: string; state: string; phase: string }[], inbox: CodeInbox | undefined, code: string, now: number): { inbox: CodeInbox } | { why: string } {
  const op = running.find((o) => o.type === CONNECT_OP.type && o.state === "running");
  if (!op) return { why: "no connect is open on this box" };
  const role: AppRole | undefined = op.phase === "making-runner" ? "runner" : op.phase === "making-source" ? "source" : undefined;
  if (!role) return { why: "the open connect isn't making an App now" };
  if (inbox && inbox.op === op.id && inbox.role === role) return { why: "this connect took a code for that App already" };
  return { inbox: { v: 1, op: op.id, role, code, at: now } };
}

export function readCodeInbox(path: string, rootUid = 0): CodeInbox | undefined {
  const r = readOwnedJson(path, { owner: rootUid, max: 4096 }, (v) => (isObj(v) && v.v === 1 && typeof v.op === "string" && (v.role === "runner" || v.role === "source") && typeof v.code === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(v.code) && Number.isSafeInteger(v.at) ? (v as unknown as CodeInbox) : "not a code"));
  return r.kind === "ok" ? r.value : undefined;
}

// The child's side: waits for the guard to put this op's code for this App in the inbox.
export async function waitForCode(d: Pick<FlowDeps, "sys" | "rootUid">, path: string, op: string, role: AppRole, untilMs: number): Promise<CodeGot> {
  for (;;) {
    const c = readCodeInbox(path, d.rootUid ?? 0);
    if (c && c.op === op && c.role === role) return { code: c.code };
    if (d.sys.now() >= untilMs) return { stop: "No App was made within the hour. Nothing changed. Type taskbox connect github to start again." };
    await d.sys.sleep(1000);
  }
}

// ---- Adoption from v2.6.0 ----
// taskbox-1's two Apps are kept with no new App and no click: each key is read once (no link followed,
// owner, type and size checked), proved, and handed to the keeper; box.json names them. The old files
// stay while the v2.6.1 install is kept, since it reads only those.
export async function adoptV2(d: NoCode, o: { runnerKey: string; sourceKey?: string; owners: readonly number[] }): Promise<string[]> {
  const lines: string[] = [];
  const set: Record<string, unknown> = {};
  const w = wantsOf(d.cfg);
  const take = async (role: AppRole, id: number, path: string): Promise<string | undefined> => {
    if (existsSync(join(d.keys.dir, keyFileName(role, id)))) {
      const held = heldKey(d, role, id);
      return held ? ((await slugOf(clientFor(d, id, held))) ?? `app-${id}`) : undefined;
    }
    const pem = readAdoptedKey(path, o.owners);
    if (!pem) return void lines.push(`${cap(ROLE_NAME[role])}'s key at ${path} can't be read as a key file of its own, so it wasn't adopted.`);
    const p = await proveApp(d, role, clientFor(d, id, pem), repoWants(d, role, w));
    if (!p.ok) return void lines.push(`${cap(ROLE_NAME[role])} (App ${id}) wasn't adopted: ${p.why}.`);
    const why = placePending({ ...d.keys, chown: d.chown ?? (() => {}) }, role, id, pem) ?? promoteKey(d.keys.dir, role, id);
    if (why) return void lines.push(`${cap(ROLE_NAME[role])} (App ${id}) wasn't adopted: ${why}.`);
    lines.push(`Adopted ${ROLE_NAME[role]} ${p.slug}.`);
    return p.slug;
  };
  const rslug = await take("runner", d.cfg.appId, o.runnerKey);
  if (rslug) set.runnerApp = { appId: d.cfg.appId, app: rslug };
  const s = sourceOf(d.cfg);
  if (s.type === "github-actions" && o.sourceKey) {
    const sslug = await take("source", s.appId, o.sourceKey);
    if (sslug) set.sources = [sourceSettings(s.appId, sslug, w)];
  }
  if (Object.keys(set).length) writeBoxKeys(d, set);
  return lines;
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
// An update by v2's install code (install.ts) keeps a release's source in box.json before the new
// release, which may drop it, is used. It reads the key where v2 placed it. The v3 update and the
// migration use adoptV2 above instead.
export interface ReleaseSourceDeps {
  sys: Sys;
  log: Log;
  paths: import("./config.ts").Paths;
  cfg: Config;
  chown(path: string, uid: number, gid: number): void;
  rootUid?: number;
  serviceUid: number;
}

export async function adoptSource(d: ReleaseSourceDeps, cfg: Config = d.cfg): Promise<{ slug: string } | { why: string }> {
  const { proveActionsKey, placeSourceKey } = await import("./keys.ts");
  const { readActionsKey } = await import("./queue.ts");
  const { sourceKeyPath } = await import("./settings/scheduling.ts");
  const box = readBoxFile(d.paths.boxSettings, d.rootUid ?? 0);
  if (box.settings && "sources" in box.settings) return { why: "this box keeps its own source already" };
  const src = sourceOf(d.cfg);
  if (src.type !== "github-actions") return { why: "the release names no job source App" };
  const pem = readActionsKey(d.paths.actionsKeyDir, sourceKeyPath(d.paths, src.appId), d.serviceUid, d.rootUid ?? 0);
  if (!pem) return { why: "the job source App's key isn't on this box" };
  const proof = await proveActionsKey(d, cfg, pem, src.appId);
  if (proof) return { why: proof.why };
  const slug = (await slugOf(clientFor(d, src.appId, pem))) ?? `app-${src.appId}`;
  // The key from before is also written under its App's ID. The old file stays, so an undo to an
  // older release, which reads only actions-key.pem, keeps its source.
  const named = join(d.paths.actionsKeyDir, `actions-${src.appId}.pem`);
  if (sourceKeyPath(d.paths, src.appId) !== named) {
    const why = await placeSourceKey(d, pem, src.appId, d.serviceUid);
    if (why) return { why };
  }
  const s = sourceOf(cfg);
  const load = s.type === "github-actions" ? s.repos.filter((r): r is LoadRepo => typeof r === "object") : [];
  writeOwnedText(d.paths.boxSettings, `${JSON.stringify({ sources: [{ type: "github-actions", appId: src.appId, repos: [cfg.jobsFrom, ...load], app: slug }] }, null, 2)}\n`, { mode: 0o644, owner: d.rootUid ?? 0, chown: d.chown });
  return { slug };
}

// ---- The op, run at the box ----
// At the box, the admin's command runs the flow itself, with the listener in the admin's session. It
// writes the op's first record, holds the op's lease, and sends every later change as a report, so the
// guard (core/child.ts follow) stays the only writer of the record after that: it applies the reports,
// ends the op at its deadline, and fails it once the lease is free because the command stopped.
export async function openConnectOp(o: { ops: import("./core/ops.ts").OpFolder; now: number; boot: string; actor: string; params: Record<string, import("./core/statement.ts").Json> }): Promise<{ op: import("./core/ops.ts").Op; send: (r: import("./core/child.ts").Report) => void } | { why: string }> {
  const { begin, listOps, writeOp } = await import("./core/ops.ts");
  const { jobLabel, leasePath, progressPath, reporter, reportsPath } = await import("./core/child.ts");
  const b = begin(listOps(o.ops).ops, CONNECT_OP, { subject: "box", params: o.params, actor: o.actor, deadline: o.now + CONNECT_MS }, o.now);
  if (b.kind !== "start") return { why: b.kind === "busy" ? b.why : `A connect (${b.op.id}) is running already. taskbox op show ${b.op.id} -w follows it.` };
  const op = { ...b.op, child: { label: jobLabel(b.op.id), boot: o.boot, spawnedAt: o.now, applied: 0, events: ["connect."], limitMs: CONNECT_MS } };
  writeOp(o.ops, op);
  const r = reporter({ op: op.id, reports: reportsPath(o.ops, op.id), progress: progressPath(o.ops, op.id), lease: leasePath(o.ops, op.id), exit: (c) => process.exit(c) });
  return { op, send: (x) => r.send(x) };
}
