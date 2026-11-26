// Reaching a paired box. Before any command, the controller checks, in its
// own Tailscale: this controller reads Running; the paired StableNodeID is listed, tagged tag:taskbox,
// not shared in, and Online; and the map's ed25519 host key is the one stored at pairing. Then it
// runs hello with the stored key only and checks role box, the answers' version and the install
// ID. A mismatch stops the command and names the cause; only a person re-pairing at a terminal changes it.
import { type Config, type ConfigRead, findBox, type Home, knownHostsFor, type Paired, readConfig, writeKnownHosts } from "./home.ts";
import type { Runner } from "./run.ts";
import { type Answer, type Hello, type Kind, READS, readAnswer } from "./schema.ts";
import { rememberAnswers } from "./versions.ts";
import { boxCall, type SshFailure, type Target } from "./ssh.ts";
import { type AppKind, type Peer, readTailnet, type StatusRead, tailnetProblem, type TailnetState, whichApp } from "./tailscale.ts";

export interface Deps {
  run: Runner;
  home: Home;
  version: string;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  ask: (prompt: string) => Promise<string>;
  tty: boolean; // stdin is a terminal: the yes prompts take an answer from nothing else
  out: (line: string) => void;
  userHome: string; // for Claude's own files, read by check
  tailscaleApp?: string; // tests: a fake app folder
  sshPath?: string; // tests: a fake ssh
  exists?: (path: string) => boolean;
}

// Why a command stopped: one line, and the next step.
export interface Stop {
  stop: string;
  next: string;
}
export const isStop = (v: unknown): v is Stop => typeof v === "object" && v !== null && "stop" in v;

export const tsDeps = (d: Deps) => ({ run: d.run, app: d.tailscaleApp, exists: d.exists });
export const sshDeps = (d: Deps) => ({ run: d.run, path: d.sshPath });

export function configOrStop(d: Deps): { config: Config } | Stop {
  const r: ConfigRead = readConfig(d.home);
  if (r.ok) return { config: r.config };
  if (r.why === "missing" || r.why === "not-controller") return { stop: "taskbox isn't installed for a controller on this Mac.", next: "Install taskbox for a controller, from its release page." };
  return { stop: `taskbox's config couldn't be read (${d.home.config}).`, next: "Install taskbox for a controller again. Its pairings are lost, so type taskbox box add after." };
}

// The one line said, before any ssh, when this controller's own Tailscale isn't connected.
export const TAILSCALE_OFF = "Tailscale is off on this Mac: open Tailscale and connect, then try again.";

export async function tailnetOrStop(d: Deps): Promise<{ state: TailnetState; app?: AppKind } | Stop> {
  const r: StatusRead = await readTailnet(tsDeps(d));
  if (!r.ok) return { stop: tailnetProblem(r, r.why === "unreadable" ? await whichApp(tsDeps(d)) : "unknown"), next: "Then type taskbox check." };
  if (!r.state.running) return { stop: TAILSCALE_OFF, next: "Open the Tailscale app and connect." };
  return { state: r.state };
}

// The peer the pairing names, checked against the map. Each failure names its cause.
export function peerOrStop(box: Paired, s: TailnetState): { peer: Peer; address: string } | Stop {
  const peer = s.peers.find((p) => p.node === box.node);
  const repair = "This may be another machine: the owner checks the box before pairing it again.";
  if (!peer) return { stop: `Tailscale doesn't list the paired box, ${box.name} (${box.node}).`, next: `It may have left the tailnet. ${repair}` };
  if (peer.shared) return { stop: `${box.name} is shared in from another tailnet, so taskbox won't talk to it.`, next: "Nothing to do here: taskbox only talks to boxes in your own tailnet." };
  if (!peer.tagged) return { stop: `${box.name} no longer carries tag:taskbox in Tailscale.`, next: "Check the box's tags in the Tailscale admin console." };
  if (!peer.online) return { stop: `${box.name} is offline in Tailscale.`, next: "Check the box is on and connected to Tailscale, then try again." };
  if (!peer.hostKeys.includes(box.hostKey)) return { stop: `${box.name}'s host key in Tailscale isn't the one paired.`, next: repair };
  if (!peer.address) return { stop: `Tailscale lists no address for ${box.name}.`, next: "Check the box is connected to Tailscale, then try again." };
  return { peer, address: peer.address };
}

export function sshStop(name: string, why: SshFailure, limitMs: number): Stop {
  switch (why) {
    case "host-key":
      return { stop: `${name}'s host key doesn't match the one paired.`, next: "This may be another machine: the owner checks the box before pairing it again." };
    case "refused":
      return { stop: `Tailscale refused the agent account on ${name}.`, next: "Check the tailnet policy lets your user reach the agent account on tag:taskbox: taskbox policy show --box all." };
    case "offline":
      return { stop: `Can't reach ${name} over Tailscale.`, next: "Check the box is on and connected to Tailscale, then try again." };
    case "timeout":
      return { stop: `${name} didn't answer within ${Math.round(limitMs / 1000)} s.`, next: "Try again. If it keeps happening, look at the box's screen." };
    case "too-big":
      return { stop: `${name} sent more than taskbox reads, so the command stopped.`, next: "Nothing to do: agents look at the box." };
    default:
      return { stop: `ssh to ${name} failed.`, next: "Type taskbox check." };
  }
}

const versionStop = (name: string, theirs: number): Stop =>
  theirs > Math.max(...READS)
    ? { stop: `${name} answers in version ${theirs}, and this controller reads versions ${READS.join(" and ")}.`, next: "Update taskbox on this controller." }
    : { stop: `${name} answers in version ${theirs}, and this controller reads versions ${READS.join(" and ")}.`, next: "Update taskbox on the box: at the box, as your admin user, type taskbox update." };

// The controller's own Next line for each of the box's error codes: the box's own fix is shown as its
// words, never as the controller's next step.
const NEXT_FOR: Record<string, string> = {
  usage: "Update taskbox on this controller, or on the box.",
  renamed: "Update taskbox on this controller.",
  "refused-over-ssh": "Do it at the box.",
  "needs-confirm": "At the box, type taskbox confirm.",
  denied: "Nothing changed.",
  expired: "Try again.",
};

// The words the controller sends for each read, in the box's answers version: v3's, or v2.6.1's (N-1).
export interface Lines {
  hello: string;
  status: string;
  jobs: (n: number) => string;
  log: string;
  check: string;
}
const LINES: Record<number, Lines> = {
  4: { hello: `hello --json --answers ${READS.join(",")}`, status: "status --json", jobs: (n) => `job list -n ${n} --json`, log: "logs --json", check: "check --json" },
  3: { hello: "hello", status: "status --json", jobs: (n) => `jobs ${n} --json`, log: "log --json", check: "check --json" },
};
export const linesFor = (version: number): Lines => LINES[version] ?? LINES[4]!;

type Got<K extends Kind> = Answer<K> | Stop | { usage: true };

async function read<K extends Kind>(d: Deps, t: Target, name: string, kind: K, line: string, limitMs: number, o: { installId?: string | null; version?: number }): Promise<Got<K>> {
  const r = await boxCall(sshDeps(d), t, line, limitMs);
  if (!r.ok) return sshStop(name, r.why, limitMs);
  const a = readAnswer(kind, r.stdout, o.installId, o.version);
  if (a.ok) return a.answer;
  if (a.why === "version") return versionStop(name, a.theirs);
  if (a.why === "box-error") {
    if (a.error.code === "usage" && kind === "hello") return { usage: true };
    return { stop: `${name} says: ${a.error.message}${a.error.fix ? ` The box's own words for the fix: ${a.error.fix}` : ""}`, next: NEXT_FOR[a.error.code] ?? "Nothing to do: agents fix it on the box." };
  }
  return { stop: `${name}'s answer to ${kind} doesn't match what taskbox reads (${a.detail}), so the command stopped.`, next: "Update taskbox on this controller and on the box. If they match, agents look." };
}

// One of the box's answers, read against the schema. Anything that doesn't match stops the command.
// installId and version: the pairing's install and the version hello agreed, checked on every read.
export async function ask<K extends Kind>(d: Deps, t: Target, name: string, kind: K, line: string, limitMs: number, o: { installId?: string | null; version?: number } = {}): Promise<Answer<K> | Stop> {
  const a = await read(d, t, name, kind, line, limitMs, o);
  return "usage" in a ? { stop: `${name} didn't take ${kind}.`, next: NEXT_FOR.usage! } : a;
}

// hello, in v3's words first; a box on v2.6.1 refuses any word after hello, so then its own bare hello.
export async function helloOf(d: Deps, t: Target, name: string): Promise<Hello | Stop> {
  const h = await read(d, t, name, "hello", linesFor(4).hello, 20_000, {});
  if (!("usage" in h)) return h;
  return ask(d, t, name, "hello", linesFor(3).hello, 20_000);
}

// hello's answer against the pairing: role box (the schema), and the same install ID.
export function helloStop(name: string, h: Hello, installId: string | null): Stop | undefined {
  if (h.installId === null) return { stop: `${name} has no install ID, so it can't be paired.`, next: "Update taskbox on the box to v2.0.0 or later: at the box, as your admin user, type taskbox update." };
  if (installId !== null && h.installId !== installId) return { stop: `${name}'s install ID isn't the one paired: the box was reinstalled.`, next: "This may be another machine: the owner checks the box before pairing it again." };
  return undefined;
}

export interface Connected {
  box: Paired;
  target: Target;
  hello: Hello;
  state: TailnetState;
}

// The boxes a command runs on. A name or Tailscale ID picks one, and all picks every one. With
// none: every box when the command covers them all, else the box use default, else the one box.
export function chooseBoxes(c: Config, sel: string | undefined, all: boolean): Paired[] | Stop {
  const names = c.boxes.map((b) => b.name).join(", ");
  if (!c.boxes.length) return { stop: "No box is paired with this controller.", next: "Type taskbox box add." };
  if (sel === "all") return c.boxes;
  if (sel !== undefined) {
    const b = findBox(c, sel);
    if (!b) return { stop: `No paired box is named ${sel.replace(/[^\x20-\x7e]/g, "").slice(0, 64)}. Paired: ${names}.`, next: "Type taskbox box list to see them." };
    return [b];
  }
  if (all) return c.boxes;
  const def = c.default !== null ? c.boxes.find((b) => b.node === c.default) : undefined;
  if (def) return [def];
  if (c.boxes.length === 1) return c.boxes;
  return { stop: `More than one box is paired: ${names}.`, next: `Add --box and a name, such as --box ${c.boxes[0]!.name}, or type taskbox box use ${c.boxes[0]!.name}.` };
}

// Every pairing check for one box, against this controller's Tailscale: the peer by its StableNodeID,
// its tag, not shared in, online, the host key as paired; then hello over that key alone, with
// role box, the answers' version and the install ID as paired.
export async function connectBox(d: Deps, box: Paired, state: TailnetState): Promise<Connected | Stop> {
  const p = peerOrStop(box, state);
  if (isStop(p)) return p;
  // Each box's known-hosts file is written from the config before each call, and holds that box's key alone.
  const knownHosts = knownHostsFor(d.home, box.node);
  writeKnownHosts(knownHosts, box.node, box.hostKey);
  const target: Target = { address: p.address, node: box.node, knownHosts, user: box.agent };
  const h = await helloOf(d, target, box.name);
  if (isStop(h)) return h;
  const bad = helloStop(box.name, h, box.installId);
  if (bad) return bad;
  // A box that drops to an older answers version is said once (a rollback, or a box to look at).
  const dropped = rememberAnswers(d.home, box.node, box.name, h.answers, h.release);
  if (dropped) d.out(dropped);
  return { box, target, hello: h, state };
}
