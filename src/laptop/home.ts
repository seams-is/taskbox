// Where the controller lives: ~/Library/Application Support/taskbox/, the
// user's own, with config.json at mode 0600 holding the role and the pairing. The user can change
// every file here, so the controller is as trusted as the user's account, and the box trusts it no
// more than any other `remote` session.
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readlinkSync, readSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

export interface Paired {
  name: string; // the box's name in Tailscale when it was paired, for screens
  node: string; // its StableNodeID
  installId: string; // from hello
  hostKey: string; // the ed25519 key, base64, from the map at pairing
  pairedAt: number;
}

// The public repo the controller installs and updates from, set at install.
export interface Source {
  owner: string;
  repo: string;
}

export interface Config {
  role: "controller";
  boxes: Paired[]; // each paired box, names and nodes unique
  source: Source | null;
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
}

export function home(userHome: string): Home {
  const dir = join(userHome, "Library", "Application Support", "taskbox");
  return { dir, config: join(dir, "config.json"), knownHostsDir: join(dir, "known_hosts.d"), releases: join(dir, "releases"), current: join(dir, "current"), bin: join(dir, "bin"), updateCheck: join(dir, "update-check.json") };
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
export const INSTALL_ID = /^[0-9a-f]{32}$/;

// An ed25519 public key in the form ssh writes it: the key type as a length-prefixed string, then
// the 32 bytes of the key. 68 characters of base64.
export function isEd25519(b64: string): boolean {
  if (!/^[A-Za-z0-9+/]{68}$/.test(b64)) return false;
  const raw = Buffer.from(b64, "base64");
  if (raw.length !== 51 || raw.readUInt32BE(0) !== 11 || raw.subarray(4, 15).toString("latin1") !== "ssh-ed25519") return false;
  return raw.readUInt32BE(15) === 32;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/;

function paired(v: unknown): Paired | null | undefined {
  if (v === null) return null;
  if (typeof v !== "object" || Array.isArray(v)) return undefined;
  const b = v as Record<string, unknown>;
  const ok =
    typeof b.name === "string" && NAME.test(b.name) &&
    typeof b.node === "string" && NODE.test(b.node) &&
    typeof b.installId === "string" && INSTALL_ID.test(b.installId) &&
    typeof b.hostKey === "string" && isEd25519(b.hostKey) &&
    Number.isSafeInteger(b.pairedAt);
  return ok ? { name: b.name as string, node: b.node as string, installId: b.installId as string, hostKey: b.hostKey as string, pairedAt: b.pairedAt as number } : undefined;
}

export type ConfigRead = { ok: true; config: Config; mode: number } | { ok: false; why: "missing" | "not-a-file" | "unreadable" | "not-controller" };

// The config, read without following a link. A config that isn't a controller's reads as one.
export function readConfig(h: Home): ConfigRead {
  let fd: number;
  try {
    fd = openSync(h.config, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { ok: false, why: code === "ENOENT" ? "missing" : code === "ELOOP" ? "not-a-file" : "unreadable" };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { ok: false, why: "not-a-file" };
    if (st.size > 64_000) return { ok: false, why: "unreadable" };
    const buf = Buffer.alloc(st.size);
    readSync(fd, buf, 0, st.size, 0);
    const v = JSON.parse(buf.toString("utf8")) as Record<string, unknown>;
    if (v?.role !== "controller") return { ok: false, why: "not-controller" };
    // A one-box controller's config has box; it reads as a list of one.
    const list = Object.hasOwn(v, "boxes") ? v.boxes : v.box ? [v.box] : [];
    if (!Array.isArray(list) || list.length > MAX_BOXES) return { ok: false, why: "unreadable" };
    const boxes = list.map(paired);
    const src = source(v.source);
    if (boxes.some((b) => !b) || src === undefined) return { ok: false, why: "unreadable" };
    const ok = boxes as Paired[];
    if (configProblem(ok)) return { ok: false, why: "unreadable" };
    return { ok: true, config: { role: "controller", boxes: ok, source: src }, mode: st.mode & 0o777 };
  } catch {
    return { ok: false, why: "unreadable" };
  } finally {
    closeSync(fd);
  }
}

export const writePrivateFile = (path: string, body: string) => writePrivate(path, body);

function writePrivate(path: string, body: string): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, body, { mode: 0o600, flag: "wx" });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

function ensureDir(h: Home): void {
  mkdirSync(h.dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(h.dir);
  if (!st.isDirectory()) throw new Error(`${h.dir} isn't a folder`);
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
  writePrivate(h.config, `${JSON.stringify({ role: c.role, boxes: c.boxes, source: c.source }, null, 2)}\n`);
}

// The install sets the role once. It never changes a config that is already there, apart from
// filling in the public repo when it has none.
export function setUpController(h: Home, from: Source | null = null): void {
  ensureDir(h);
  const r = readConfig(h);
  if (r.ok) {
    if (!r.config.source && from) writeConfig(h, { ...r.config, source: from });
    return;
  }
  if (r.why !== "missing") throw new Error(`${h.config} is there but isn't a controller's config`);
  writeConfig(h, { role: "controller", boxes: [], source: from });
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
    return /^v\d+\.\d+\.\d+$/.test(name) ? name : "dev";
  } catch {
    return "dev";
  }
}
