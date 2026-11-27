// The controller's folder, ~/Library/Application Support/taskbox/ at 0700, and config.json at 0600:
// the role, the pairings, the default box and the channel. A box trusts the controller no more than
// any other session of its agent account.
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readlinkSync, readSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { realClock } from "../clock.ts";
import { INSTALL_ID } from "../answers.ts";
import { RELEASE_TAG as RELEASE_FOLDER } from "../github.ts";

export interface Paired {
  name: string; // the box's name in Tailscale when it was paired, for screens
  node: string; // its StableNodeID
  installId: string; // from hello
  hostKey: string; // the ed25519 key, base64, from the map at pairing
  agent: string; // the box's agent account, which every command reaches it as
  pairedAt: number;
}

// The public repo the controller installs and updates from, set at install.
export interface Source {
  owner: string;
  repo: string;
}

export type Channel = "stable" | "beta";

export interface Config {
  role: "controller";
  boxes: Paired[]; // each paired box, names and nodes unique
  source: Source | null;
  default: string | null; // the StableNodeID box use set
  channel: Channel;
  // self.auto: the controller installs newer releases on its channel by itself, once a day.
  auto?: boolean;
}

export const MAX_BOXES = 32;

export interface Home {
  dir: string;
  config: string;
  knownHostsDir: string; // known_hosts.d/<StableNodeID>, one file a box
  releases: string; // releases/<tag>/, each with app/ and bun
  current: string; // a link to the release in use
  bin: string; // bin/taskbox and bin/bun
  updateCheck: string; // when taskbox last looked for a newer release
  events: string; // the controller's own event log, one file a day
  status: string; // the last status read of each box, for the status line
}

export function home(userHome: string): Home {
  const dir = join(userHome, "Library", "Application Support", "taskbox");
  return { dir, config: join(dir, "config.json"), knownHostsDir: join(dir, "known_hosts.d"), releases: join(dir, "releases"), current: join(dir, "current"), bin: join(dir, "bin"), updateCheck: join(dir, "update-check.json"), events: join(dir, "events"), status: join(dir, "status.json") };
}

// A GitHub owner or repo name.
export const GITHUB_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/;

function source(v: unknown): Source | null | undefined {
  if (v === null || v === undefined) return null;
  if (typeof v !== "object" || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  return typeof o.owner === "string" && GITHUB_NAME.test(o.owner) && typeof o.repo === "string" && GITHUB_NAME.test(o.repo) && !o.repo.includes("..") ? { owner: o.owner, repo: o.repo } : undefined;
}

export const NODE = /^[A-Za-z0-9]{2,64}$/;
export { INSTALL_ID };

// An ed25519 public key in the form ssh writes it: the key type as a length-prefixed string, then
// the 32 bytes of the key. 68 characters of base64.
export function isEd25519(b64: string): boolean {
  if (!/^[A-Za-z0-9+/]{68}$/.test(b64)) return false;
  const raw = Buffer.from(b64, "base64");
  if (raw.length !== 51 || raw.readUInt32BE(0) !== 11 || raw.subarray(4, 15).toString("latin1") !== "ssh-ed25519") return false;
  return raw.readUInt32BE(15) === 32;
}

// A box's name: a MagicDNS label. The one pattern for it; --box all matches it too.
export const NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/;
// A macOS account name, as the box's agent account is named.
export const ACCOUNT = /^[A-Za-z_][A-Za-z0-9._-]{0,31}$/;
// Accounts that are never a box's agent account: root, macOS's own, and names starting with _.
export const RESERVED = new Set(["root", "daemon", "nobody", "admin", "administrator", "guest", "Shared"]);
export const agentProblem = (a: string): string | undefined => (!ACCOUNT.test(a) ? "isn't an account name" : RESERVED.has(a) || a.startsWith("_") ? "is a name taskbox never uses for an agent account" : undefined);

// A small file of the owner's own, read without following a link: its text, or why not.
export function readSmall(path: string, max: number): { text: string; mode: number } | { why: "missing" | "not-a-file" | "unreadable" } {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { why: code === "ENOENT" ? "missing" : code === "ELOOP" ? "not-a-file" : "unreadable" };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { why: "not-a-file" };
    if (st.size > max || st.uid !== process.getuid?.()) return { why: "unreadable" };
    const buf = Buffer.alloc(st.size);
    readSync(fd, buf, 0, st.size, 0);
    return { text: buf.toString("utf8"), mode: st.mode & 0o777 };
  } catch {
    return { why: "unreadable" };
  } finally {
    closeSync(fd);
  }
}

function paired(v: unknown): Paired | null | undefined {
  if (v === null) return null;
  if (typeof v !== "object" || Array.isArray(v)) return undefined;
  const b = v as Record<string, unknown>;
  const ok =
    typeof b.name === "string" && NAME.test(b.name) &&
    typeof b.node === "string" && NODE.test(b.node) &&
    typeof b.installId === "string" && INSTALL_ID.test(b.installId) &&
    typeof b.hostKey === "string" && isEd25519(b.hostKey) &&
    typeof b.agent === "string" && agentProblem(b.agent) === undefined &&
    Number.isSafeInteger(b.pairedAt);
  return ok ? { name: b.name as string, node: b.node as string, installId: b.installId as string, hostKey: b.hostKey as string, agent: b.agent as string, pairedAt: b.pairedAt as number } : undefined;
}

export type ConfigRead = { ok: true; config: Config; mode: number } | { ok: false; why: "missing" | "not-a-file" | "unreadable" | "not-controller" };

// The config, read without following a link, strictly: anything not in the controller's shape reads as unreadable.
export function readConfig(h: Home): ConfigRead {
  const f = readSmall(h.config, 64_000);
  if ("why" in f) return { ok: false, why: f.why };
  try {
    const v = JSON.parse(f.text) as Record<string, unknown>;
    if (v?.role !== "controller") return { ok: false, why: "not-controller" };
    const list = v.boxes ?? [];
    if (!Array.isArray(list) || list.length > MAX_BOXES) return { ok: false, why: "unreadable" };
    const boxes = list.map(paired);
    const src = source(v.source);
    if (boxes.some((b) => !b) || src === undefined) return { ok: false, why: "unreadable" };
    const ok = boxes as Paired[];
    if (configProblem(ok)) return { ok: false, why: "unreadable" };
    const def = v.default ?? null;
    if (def !== null && (typeof def !== "string" || !ok.some((b) => b.node === def))) return { ok: false, why: "unreadable" };
    const channel = v.channel ?? "stable";
    if (channel !== "stable" && channel !== "beta") return { ok: false, why: "unreadable" };
    const self = (v.self ?? {}) as Record<string, unknown>;
    if (typeof self !== "object" || Array.isArray(self) || (self.auto !== undefined && typeof self.auto !== "boolean")) return { ok: false, why: "unreadable" };
    return { ok: true, config: { role: "controller", boxes: ok, source: src, default: def as string | null, channel, ...(self.auto === false ? { auto: false } : {}) }, mode: f.mode };
  } catch {
    return { ok: false, why: "unreadable" };
  }
}

export const writePrivateFile = (path: string, body: string) => writePrivate(path, body);

function writePrivate(path: string, body: string): void {
  const tmp = `${path}.${process.pid}.${realClock.now()}.tmp`;
  writeFileSync(tmp, body, { mode: 0o600, flag: "wx" });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export function ensureDir(h: Home): void {
  mkdirSync(h.dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(h.dir);
  if (!st.isDirectory()) throw new Error(`${h.dir} isn't a folder`);
  if ((st.mode & 0o777) !== 0o700) chmodSync(h.dir, 0o700);
}

// Why a list of boxes can't be kept, or undefined. Names and Tailscale IDs are compared ignoring
// case, since APFS names each box's known-hosts file by its ID; and no name may be another box's
// ID, so --box always means one box.
export function configProblem(boxes: Paired[]): string | undefined {
  if (boxes.length > MAX_BOXES) return `taskbox keeps at most ${MAX_BOXES} boxes`;
  const names = boxes.map((b) => b.name.toLowerCase());
  const nodes = boxes.map((b) => b.node.toLowerCase());
  if (new Set(names).size !== boxes.length || new Set(nodes).size !== boxes.length) return "two boxes share a name or a Tailscale ID";
  if (names.some((n, i) => nodes.some((id, j) => i !== j && n === id))) return "a box's name is another box's Tailscale ID";
  return undefined;
}

export function writeConfig(h: Home, c: Config): void {
  const why = configProblem(c.boxes);
  if (why) throw new Error(why);
  ensureDir(h);
  // A default that names a box no longer paired goes with it.
  const def = c.default !== null && c.boxes.some((b) => b.node === c.default) ? c.default : null;
  writePrivate(h.config, `${JSON.stringify({ role: c.role, boxes: c.boxes, source: c.source, default: def, channel: c.channel, ...(c.auto === false ? { self: { auto: false } } : {}) }, null, 2)}\n`);
}

// The install sets the role once. It never changes a config that is already there, apart from
// filling in the public repo when it has none.
export function setUpController(h: Home, from: Source | null = null, channel: Channel = "stable"): void {
  ensureDir(h);
  const r = readConfig(h);
  if (r.ok) {
    if (!r.config.source && from) writeConfig(h, { ...r.config, source: from });
    return;
  }
  if (r.why !== "missing") throw new Error(`${h.config} is there but isn't the controller's config`);
  writeConfig(h, { role: "controller", boxes: [], source: from, default: null, channel });
}

// The one line ssh reads the box's key from: the StableNodeID, standing in for the host by
// HostKeyAlias, and the ed25519 key.
export const knownHostsLine = (node: string, hostKey: string) => `${node} ssh-ed25519 ${hostKey}\n`;

// A box's own known-hosts file. ssh reads only this one for that box.
export function knownHostsFor(h: Home, node: string): string {
  if (!NODE.test(node)) throw new Error("not a StableNodeID");
  mkdirSync(h.knownHostsDir, { recursive: true, mode: 0o700 });
  if (!lstatSync(h.knownHostsDir).isDirectory()) throw new Error(`${h.knownHostsDir} isn't a folder`);
  return join(h.knownHostsDir, node);
}

// The box a name or a StableNodeID names, among the paired ones. Names are compared ignoring case.
export function findBox(c: Config, sel: string): Paired | undefined {
  return c.boxes.find((b) => b.node === sel) ?? c.boxes.find((b) => b.name.toLowerCase() === sel.toLowerCase());
}

export function writeKnownHosts(path: string, node: string, hostKey: string): void {
  if (!NODE.test(node) || !isEd25519(hostKey)) throw new Error("not a node and key ssh can use");
  writePrivate(path, knownHostsLine(node, hostKey));
}

// The controller's own release, from the `current` link's folder name. A copy run from anywhere
// else says dev.
export function ownVersion(h: Home): string {
  try {
    const name = basename(readlinkSync(h.current));
    return RELEASE_FOLDER.test(name) ? name : "dev";
  } catch {
    return "dev";
  }
}
