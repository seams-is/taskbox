// taskbox connect github and taskbox disconnect github: the steps that talk to GitHub and change the
// box. src/connect.ts has the pure parts, and
// src/listen.ts the listener, run as the admin.
import { createHash, createPrivateKey, createPublicKey, randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { placeDownloadedKey, placeSourceKey, proveActionsKey, takeDownloadedKey } from "./actionskey.ts";
import { readBoxFile } from "./boxsettings.ts";
import { checkScheduling, type Config, type LoadRepo, type Paths, readStateJson, type SourceSettings, sourceKeyPath, sourceOf } from "./config.ts";
import { appName, conversionProblem } from "./connect.ts";
import { appJwt } from "./github.ts";
import type { ListenEvent, ListenSetup } from "./listen.ts";
import type { Log } from "./log.ts";
import { readActionsKey } from "./queue.ts";
import type { Sys } from "./sys.ts";

const API = "https://api.github.com";
// How long the install wait and the --new-key watch last. The listener lasts the code's own hour.
export const WAIT_MS = 10 * 60_000;
export const POLL_MS = 5_000;
export const LISTEN_MINUTES = 60;

export type Listener = { kill(): void; exited?: Promise<unknown> };

export interface ConnectDeps {
  sys: Sys;
  log: Log;
  paths: Paths;
  cfg: Config; // the settings as loaded, the box's own over the release's
  say(line: string): void;
  ask(prompt: string): Promise<string>;
  chown(path: string, uid: number, gid: number): void;
  rootUid?: number;
  serviceUid: number;
  admin: { name: string; uid: number; home: string };
  // Runs the listener as the admin; each JSON line it writes comes to onEvent.
  listen(setup: ListenSetup, onEvent: (e: ListenEvent) => void): Listener;
  // Opens a URL in the admin's own session, as the admin.
  open(url: string): void;
  // Called once the App is made, so Ctrl-C can say what is left on GitHub.
  onMade?(lines: string[]): void;
}

type Pending = { appId: number; slug: string; at: number; replacing?: number };

// Every file holding an App's key: its own, and the key from before when that is the same App's
// (Tart run of #34: disconnect left actions-key.pem on an adopted box).
function dropKeyFiles(d: ConnectDeps, appId: number): void {
  const named = namedKey(d.paths, appId);
  const legacy = join(d.paths.actionsKeyDir, "actions-key.pem");
  const ours = readActionsKey(d.paths.actionsKeyDir, named, d.serviceUid, d.rootUid ?? 0);
  const old = readActionsKey(d.paths.actionsKeyDir, legacy, d.serviceUid, d.rootUid ?? 0);
  // The key from before is this App's when it is the same key, or when it is what the source used.
  if (old && (old === ours || sourceKeyPath(d.paths, appId) === legacy)) rmSync(legacy, { force: true });
  rmSync(named, { force: true });
}

// An App's own key file, by its ID. Never the key from before: that is the source in use's alone.
const namedKey = (p: Paths, appId: number) => join(p.actionsKeyDir, `actions-${appId}.pem`);
// The repos a source writes: jobsFrom, and the box's test repo as it is (v2.6.0), so taskbox load keeps it.
const reposOf = (cfg: Config): (string | LoadRepo)[] => {
  const s = sourceOf(cfg);
  return [cfg.jobsFrom, ...(s.type === "github-actions" ? s.repos.filter((r): r is LoadRepo => typeof r === "object") : [])];
};
const pendingPath = (p: Paths) => join(dirname(p.boxSettings), "connect-pending.json");
const appUrl = (org: string, slug: string) => `https://github.com/organizations/${org}/settings/apps/${slug}`;
const deleteLine = (org: string, slug: string) => `GitHub keeps the App ${slug} until you delete it: ${appUrl(org, slug)}/advanced, Delete GitHub App.`;

async function api(d: Pick<ConnectDeps, "sys">, method: string, path: string, auth?: string, body?: unknown): Promise<Response> {
  return d.sys.fetch(API + path, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "taskbox",
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "error",
    signal: d.sys.timeout(15_000),
  });
}

// Root's file, written whole with O_EXCL and renamed into place, then the folder flushed.
function writeRootFile(d: Pick<ConnectDeps, "chown" | "rootUid">, path: string, text: string, mode: number): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  const next = `${path}.new`;
  rmSync(next, { force: true });
  const fd = openSync(next, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try {
    const buf = Buffer.from(text, "utf8");
    for (let off = 0; off < buf.length; ) off += writeSync(fd, buf, off, buf.length - off);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  d.chown(next, d.rootUid ?? 0, 0);
  chmodSync(next, mode);
  renameSync(next, path);
}

// The box file: its sources, and nothing else, so a file taskbox set aside is cleared in one step.
export function writeBoxSources(d: Pick<ConnectDeps, "paths" | "chown" | "rootUid">, sources: SourceSettings[]): void {
  writeRootFile(d, d.paths.boxSettings, `${JSON.stringify({ sources }, null, 2)}\n`, 0o644);
}

function readPending(p: Paths): Pending | undefined {
  const r = readStateJson<Partial<Pending>>(pendingPath(p));
  if (!r || !Number.isInteger(r.appId) || r.appId! <= 0 || typeof r.slug !== "string" || !/^[a-z0-9-]{1,64}$/.test(r.slug)) return undefined;
  return { appId: r.appId!, slug: r.slug, at: Number(r.at) || 0, ...(Number.isInteger(r.replacing) ? { replacing: r.replacing! } : {}) };
}

// The key's fingerprint as GitHub's page lists it: SHA-256 of the public key in DER, base64 (read:
// GitHub's "Verifying private keys").
export function fingerprint(pem: string): string {
  const der = createPublicKey(createPrivateKey(pem)).export({ type: "spki", format: "der" });
  return `SHA256:${createHash("sha256").update(der).digest("base64")}`;
}

// The source in use, if it is a github-actions one, with its key as held, or undefined.
function inUse(d: ConnectDeps): { src: Extract<SourceSettings, { type: "github-actions" }>; pem?: string } | undefined {
  const src = sourceOf(d.cfg);
  if (src.type !== "github-actions") return undefined;
  const pem = readActionsKey(d.paths.actionsKeyDir, sourceKeyPath(d.paths, src.appId), d.serviceUid, d.rootUid ?? 0);
  return { src, ...(pem ? { pem } : {}) };
}

async function slugOf(d: ConnectDeps, appId: number, pem: string): Promise<string | undefined> {
  const jwt = appJwt(appId, pem, d.sys.now());
  d.log.secret(jwt);
  const r = await api(d, "GET", "/app", jwt).catch(() => undefined);
  if (!r?.ok) return undefined;
  const slug = ((await r.json()) as { slug?: unknown }).slug;
  return typeof slug === "string" && /^[a-z0-9-]{1,64}$/.test(slug) ? slug : undefined;
}

// Uninstalls an App with its own key, so a copied key reads nothing. Says what it did.
async function uninstall(d: ConnectDeps, appId: number, pem: string): Promise<boolean> {
  const jwt = appJwt(appId, pem, d.sys.now());
  d.log.secret(jwt);
  const r = await api(d, "GET", "/app/installations?per_page=100", jwt).catch(() => undefined);
  if (!r?.ok) return false;
  const list = (await r.json()) as { id?: unknown }[];
  let all = true;
  for (const i of Array.isArray(list) ? list : []) {
    if (!Number.isInteger(i.id)) continue;
    const del = await api(d, "DELETE", `/app/installations/${i.id}`, jwt).catch(() => undefined);
    if (!del || (del.status !== 204 && del.status !== 404)) all = false;
  }
  return all;
}

// Section 4a: a release's source with its key in place, kept in the box's own settings. Used by the
// update and by connect. Returns the slug, or why it wasn't adopted.
// cfg: the settings to prove and keep, d.cfg unless --load changes the test repo.
export async function adoptSource(d: ConnectDeps, cfg: Config = d.cfg): Promise<{ slug: string } | { why: string }> {
  const box = readBoxFile(d.paths.boxSettings, d.rootUid ?? 0);
  if (box.settings && "sources" in box.settings) return { why: "this box keeps its own source already" };
  const u = inUse(d);
  if (!u) return { why: "the release names no job source App" };
  if (!u.pem) return { why: "the job source App's key isn't on this box" };
  const proof = await proveActionsKey(d, cfg, u.pem, u.src.appId);
  if (proof) return { why: proof.why };
  const slug = (await slugOf(d, u.src.appId, u.pem)) ?? `app-${u.src.appId}`;
  // The key from before is also written under its App's ID. The old file stays, so an undo to an
  // older release, which reads only actions-key.pem, keeps its source.
  if (sourceKeyPath(d.paths, u.src.appId) !== namedKey(d.paths, u.src.appId)) {
    const why = await placeSourceKey(d, u.pem, u.src.appId, d.serviceUid);
    if (why) return { why };
  }
  writeBoxSources(d, [{ type: "github-actions", appId: u.src.appId, repos: reposOf(cfg), app: slug }]);
  return { slug };
}

// Waits for the App's installation, proving it each time, until it passes or the wait ends.
async function waitForInstall(d: ConnectDeps, appId: number, slug: string, pem: string): Promise<string | undefined> {
  d.open(`https://github.com/apps/${slug}/installations/new`);
  d.say(`On the next page, choose Only select repositories, pick ${d.cfg.jobsFrom}, and click Install. Waiting up to 10 minutes.`);
  const until = d.sys.now() + WAIT_MS;
  let said = "";
  for (;;) {
    const proof = await proveActionsKey(d, d.cfg, pem, appId);
    if (!proof) return undefined;
    if (proof.why !== "that App isn't installed anywhere" && proof.why !== said) {
      said = proof.why;
      // GitHub not answering is GitHub's, never the owner's to change.
      if (/^GitHub (answered|refused)|answer .* had no/.test(proof.why) && !proof.grew) d.say(`GitHub didn't answer this time (${proof.why}); taskbox tries again.`);
      else d.say(`Not yet: ${proof.why}. Change it on GitHub (${d.cfg.org}'s Settings, GitHub Apps, ${slug}, Configure), and taskbox carries on.`);
    }
    if (d.sys.now() >= until) {
      return `the App isn't installed on ${d.cfg.jobsFrom} yet: Install wasn't clicked, or it waits for an owner of ${d.cfg.org} to approve it`;
    }
    await d.sys.sleep(POLL_MS);
  }
}

// After the installation passes: the box's source moves to the new App, then the App it replaces is
// uninstalled and its key goes. The new key was written under its own App's ID before this.
async function keep(d: ConnectDeps, appId: number, slug: string, old?: { appId: number; pem?: string }): Promise<void> {
  writeBoxSources(d, [{ type: "github-actions", appId, repos: reposOf(d.cfg), app: slug }]);
  rmSync(pendingPath(d.paths), { force: true });
  if (old && old.appId !== appId) {
    const oldSlug = old.pem ? await slugOf(d, old.appId, old.pem) : undefined;
    if (old.pem) d.say((await uninstall(d, old.appId, old.pem)) ? `Uninstalled the App it replaces (App ${old.appId}), so its key reads nothing.` : `The App it replaces (App ${old.appId}) couldn't be uninstalled. Uninstall it on GitHub.`);
    if (oldSlug) d.say(deleteLine(d.cfg.org, oldSlug));
    dropKeyFiles(d, old.appId);
  }
}

// Steps 1 and 2: a new App by manifest, its key placed under its own ID, then its install.
async function makeApp(d: ConnectDeps, replacing?: { appId: number; pem?: string }): Promise<number> {
  const owner = d.cfg.jobsFrom.split("/")[0]!;
  if (owner.toLowerCase() !== d.cfg.org.toLowerCase()) {
    d.say(`taskbox.json's jobsFrom, ${d.cfg.jobsFrom}, is in ${owner}, and its org is ${d.cfg.org}. A job source App installs only in its own organisation. Nothing changed.`);
    return 1;
  }
  const state = randomBytes(32).toString("hex");
  const pageToken = randomBytes(32).toString("hex");
  // Always a suffix: GitHub keeps an old App's name until it is deleted, so a second connect never clashes.
  const name = appName(d.cfg.org, d.cfg.runnerNamePrefix, randomBytes(2).toString("hex"));
  const since = d.sys.now();
  let port = 0;
  let got: { code: string } | "timeout" | undefined;
  let wake: () => void = () => {};
  const event = new Promise<void>((r) => (wake = r));
  let ended = false;
  const l = d.listen({ org: d.cfg.org, appName: name, state, pageToken, minutes: LISTEN_MINUTES, open: true }, (e) => {
    if ("port" in e) port = e.port;
    else if ("timeout" in e) got = "timeout";
    else if (e.state === state) got = { code: e.code };
    wake();
  });
  void l.exited?.then(() => {
    ended = true;
    wake();
  });
  try {
    await event;
    if (!port) {
      d.say("taskbox's page for GitHub couldn't start, so nothing was made. Nothing changed. Type taskbox connect github to try again.");
      return 1;
    }
    const url = `http://127.0.0.1:${port}/start/${pageToken}`;
    d.say(`You need to be an owner of ${d.cfg.org}. Your browser opens at the box. Sign in to GitHub there as an owner of ${d.cfg.org} if it asks, then click Create GitHub App.`);
    d.say(`If it doesn't open, open this address in it: ${url}`);
    while (got === undefined && !ended) await new Promise<void>((r) => (wake = r));
  } finally {
    l.kill();
  }
  if (got === undefined) {
    d.say("taskbox's page for GitHub stopped before GitHub sent the App back. Nothing changed. Type taskbox connect github to try again.");
    return 1;
  }
  if (got === "timeout") {
    d.say("No App was made within the hour. Nothing changed. Type taskbox connect github to start again.");
    return 1;
  }
  d.log.secret(got.code);
  const appsUrl = `https://github.com/organizations/${d.cfg.org}/settings/apps`;
  d.onMade?.([`GitHub may have made the App ${name}. If it is listed at ${appsUrl}, delete it there, then type taskbox connect github again.`]);
  const res = await api(d, "POST", `/app-manifests/${encodeURIComponent(got.code)}/conversions`).catch(() => undefined);
  if (!res?.ok) {
    d.say(`GitHub didn't give taskbox the App (${res ? `it answered ${res.status}` : "it couldn't be reached"}), so nothing changed on this box. GitHub may have made the App ${name}: if it is listed at ${appsUrl}, delete it there. Then type taskbox connect github again.`);
    return 1;
  }
  const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  for (const k of ["pem", "client_secret", "webhook_secret"]) if (typeof raw[k] === "string") d.log.secret(raw[k] as string);
  const conv = conversionProblem(raw, d.cfg.org, d.cfg.appId, since);
  if ("why" in conv) {
    d.say(`GitHub made something taskbox won't use: ${conv.why}. Nothing was kept.${conv.made ? ` Delete ${conv.made} on GitHub: ${d.cfg.org}'s Settings, GitHub Apps.` : ""}`);
    return 1;
  }
  // Recorded at once, then the key under its own App's ID, so a stop from here on is found again.
  writeRootFile(d, pendingPath(d.paths), JSON.stringify({ appId: conv.id, slug: conv.slug, at: d.sys.now(), ...(replacing ? { replacing: replacing.appId } : {}) }), 0o600);
  const why = await placeSourceKey(d, conv.pem, conv.id, d.serviceUid);
  if (why) {
    rmSync(pendingPath(d.paths), { force: true });
    d.say(`The App ${conv.slug} is made, but ${why}. ${deleteLine(d.cfg.org, conv.slug)}`);
    return 1;
  }
  d.onMade?.([`The App ${conv.slug} is made and waits for its install. Type taskbox connect github to finish, or delete it on GitHub: ${appUrl(d.cfg.org, conv.slug)}/advanced.`]);
  d.say(`Made the App ${conv.slug}.`);
  return finish(d, conv.id, conv.slug, conv.pem, replacing);
}

async function finish(d: ConnectDeps, appId: number, slug: string, pem: string, replacing?: { appId: number; pem?: string }): Promise<number> {
  const why = await waitForInstall(d, appId, slug, pem);
  if (why) {
    d.say(`Not connected: ${why}. The App ${slug} is kept for the next try: type taskbox connect github to finish it.`);
    return 1;
  }
  await keep(d, appId, slug, replacing);
  d.say(`Connected: the App ${slug} reads the queue of ${d.cfg.jobsFrom}. The loop takes it once no job runs. taskbox check shows it.`);
  d.say("Sign out of GitHub in that browser window now: your picture, top right, Sign out.");
  return 0;
}

// taskbox connect github --load <org/repo> --group <runner group>, or --load off: the box's test repo for
// taskbox load (v2.6.0), checked and proved with the App before it is written.
async function setLoad(d: ConnectDeps, load: LoadRepo | "off"): Promise<number> {
  const u = inUse(d);
  if (!u?.pem) return (d.say("This box has no job source App yet. Type taskbox connect github first."), 1);
  const next: Config = { ...d.cfg, sources: [{ ...u.src, repos: [d.cfg.jobsFrom, ...(load === "off" ? [] : [load])] }] };
  try {
    checkScheduling(next);
  } catch (e) {
    return (d.say(`Nothing changed: ${(e as Error).message.replace(/^taskbox\.json: /, "")}.`), 1);
  }
  const off = load === "off" ? " Take the App off the test repo on GitHub first, then type this again." : "";
  if (!d.cfg.boxKeys?.includes("sources")) {
    const a = await adoptSource(d, next);
    if ("why" in a) return (d.say(`Nothing changed: ${a.why}.${off}`), 1);
  } else {
    const proof = await proveActionsKey(d, next, u.pem, u.src.appId);
    if (proof) return (d.say(`Nothing changed: ${proof.why}.${off}`), 1);
    writeBoxSources(d, next.sources!);
  }
  if (load === "off") return (d.say("The test repo is out of this box's settings. The loop takes it once no job runs."), 0);
  const slug = u.src.app ?? (await slugOf(d, u.src.appId, u.pem)) ?? `App ${u.src.appId}`;
  d.say(`The test repo ${load.name}, in the runner group ${load.runnerGroup}, is in this box's settings. The loop takes it once no job runs.`);
  d.say(`If the App ${slug} isn't on ${load.name} yet, add it: ${d.cfg.org}'s Settings, GitHub Apps, ${slug}, Configure, Repository access. Then taskbox check's Test repo row shows it.`);
  return 0;
}

// taskbox connect github [--new-key | --load <org/repo> --group <runner group> | --load off]
export async function connectGithub(d: ConnectDeps, opts: { newKey?: boolean; load?: LoadRepo | "off" } = {}): Promise<number> {
  if (opts.load) return setLoad(d, opts.load);
  // An App made before and not yet installed (connect-github design).
  const pending = readPending(d.paths);
  if (pending) {
    const a = (await d.ask(`The App ${pending.slug} was made and isn't installed yet. Type finish to wait for its install, or delete to drop it here: `)).trim().toLowerCase();
    const pem = readActionsKey(d.paths.actionsKeyDir, namedKey(d.paths, pending.appId), d.serviceUid, d.rootUid ?? 0);
    if (a === "finish" && pem) {
      const old = inUse(d);
      return finish(d, pending.appId, pending.slug, pem, old && old.src.appId !== pending.appId ? { appId: old.src.appId, ...(old.pem ? { pem: old.pem } : {}) } : undefined);
    }
    if (a === "delete" || (a === "finish" && !pem)) {
      // Installed after the wait ended: uninstalled with its own key first, so the key reads nothing.
      if (pem) await uninstall(d, pending.appId, pem);
      rmSync(namedKey(d.paths, pending.appId), { force: true });
      rmSync(pendingPath(d.paths), { force: true });
      d.say(`Dropped the App ${pending.slug} from this box. ${deleteLine(d.cfg.org, pending.slug)}`);
      return a === "delete" ? 0 : 1;
    }
    d.say("Nothing changed.");
    return 1;
  }
  const u = inUse(d);
  if (opts.newKey) return u?.pem ? newKey(d, u.src.appId, u.src.app ?? (await slugOf(d, u.src.appId, u.pem)) ?? "", u.pem) : (d.say("This box has no job source App yet. Type taskbox connect github."), 1);
  if (u?.pem) {
    const proof = await proveActionsKey(d, d.cfg, u.pem, u.src.appId);
    const slug = u.src.app ?? (await slugOf(d, u.src.appId, u.pem)) ?? `App ${u.src.appId}`;
    if (!proof) {
      if (!d.cfg.boxKeys?.includes("sources")) {
        const adopted = await adoptSource(d);
        if ("slug" in adopted) {
          d.say(`Connected: the App ${adopted.slug} you already had, now kept in this box's own settings. The loop takes it once no job runs.`);
          return 0;
        }
      }
      const a = (await d.ask(`This box is connected to the App ${slug}, and it passes. Type replace to make a new App and drop this one, or anything else to keep it: `)).trim().toLowerCase();
      if (a !== "replace") return (d.say("Kept. Nothing changed."), 0);
    } else {
      d.say(`The App ${slug} in use doesn't pass: ${proof.why}.`);
      const a = (await d.ask("Type replace to make a new App in its place, or anything else to leave it: ")).trim().toLowerCase();
      if (a !== "replace") return (d.say("Nothing changed."), 1);
    }
    return makeApp(d, { appId: u.src.appId, pem: u.pem });
  }
  return makeApp(d, u ? { appId: u.src.appId } : undefined);
}

// Section 4b: a new key for the same App, taken from Downloads as soon as it is saved.
async function newKey(d: ConnectDeps, appId: number, slug: string, oldPem: string): Promise<number> {
  const since = d.sys.now();
  d.open(slug ? appUrl(d.cfg.org, slug) : `https://github.com/organizations/${d.cfg.org}/settings/apps`);
  d.say("Your browser opens the App's settings. Sign in to GitHub there as an owner if it asks. Open Credentials, then Key pairs, and generate a new private key. taskbox takes the file as soon as it's saved. macOS may ask Terminal for access to Downloads: allow it.");
  const dl = join(d.admin.home, "Downloads");
  const until = since + WAIT_MS;
  let saidWhy = false;
  for (;;) {
    // The same proof as the update's: a key for either of the box's Apps is taken (P3).
    const got = await takeDownloadedKey(d, d.cfg, dl, { again: "taskbox connect github --new-key", source: true, since });
    if ("stop" in got) return (d.say(got.stop), 1);
    if ("pem" in got) {
      const line = await placeDownloadedKey(d, got, d.cfg, d.serviceUid).catch((e: Error) => e);
      if (line instanceof Error) return (d.say(`${line.message} Nothing changed.`), 1);
      if (got.app === "runner") return (d.say(`${line} The loop takes it once no job runs. On the runner App's page, delete its old key: Credentials, Key pairs.`), 0);
      // The key from before goes once the new one is in place under its App's ID.
      rmSync(join(d.paths.actionsKeyDir, "actions-key.pem"), { force: true });
      d.say(`${line} The loop takes it once no job runs.`);
      const oldJwt = appJwt(appId, oldPem, d.sys.now());
      d.log.secret(oldJwt);
      const still = await api(d, "GET", "/app", oldJwt).then((r) => r.ok, () => false);
      d.say(still ? `On the same page, delete the old key now: Credentials, Key pairs, the one with the fingerprint ${fingerprint(oldPem)}, Delete. It still works until you do.` : "The old key no longer works on GitHub.");
      d.say("Then sign out of GitHub in that browser window: your picture, top right, Sign out.");
      return 0;
    }
    if (got.none && !saidWhy) {
      saidWhy = true;
      d.say(`${got.none}. taskbox keeps watching.`);
    }
    if (d.sys.now() >= until) return (d.say("No new key came in 10 minutes. Nothing changed, and the key in use stays."), 1);
    await d.sys.sleep(1000);
  }
}

// taskbox disconnect github: the App is uninstalled with its own key, the box keeps "none" as its
// source (so the release's never comes back), and the key goes.
export async function disconnectGithub(d: ConnectDeps): Promise<number> {
  const u = inUse(d);
  if (!u) return (d.say("This box has no job source App. Nothing changed."), 0);
  const slug = u.src.app ?? (u.pem ? await slugOf(d, u.src.appId, u.pem) : undefined);
  const named = slug ?? `App ${u.src.appId}`;
  if ((await d.ask(`This disconnects the App ${named}: it is uninstalled from ${d.cfg.jobsFrom}, and its key leaves the box. The box then follows the jobs its VMs take. Type yes to disconnect it: `)).trim().toLowerCase() !== "yes") return (d.say("Nothing changed."), 1);
  const gone = u.pem ? await uninstall(d, u.src.appId, u.pem) : false;
  writeBoxSources(d, [{ type: "none" }]);
  dropKeyFiles(d, u.src.appId);
  const uninstalled = gone ? ` The App ${named} is uninstalled.` : ` Uninstall the App ${named} on GitHub: ${d.cfg.org}'s Settings, GitHub Apps, ${named}, Configure.`;
  const left = slug ? deleteLine(d.cfg.org, slug) : `GitHub keeps the App until you delete it: ${d.cfg.org}'s Settings, GitHub Apps.`;
  d.say(`Disconnected. The box follows the jobs its VMs take.${uninstalled} ${left}`);
  return 0;
}
