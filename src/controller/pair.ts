// taskbox box add: Tailscale proves which box it is (the StableNodeID and tag in its signed map); the
// controller stores the node, install ID, host key and agent account. Pairing grants nothing: it lets
// the controller notice a swapped or reinstalled box, so a changed key or install ID needs a person.
import { createHash } from "node:crypto";
import { renameSync, rmSync } from "node:fs";
import { agentProblem, type Config, configProblem, findBox, knownHostsFor, MAX_BOXES, type Paired, readConfig, writeConfig, writeKnownHosts } from "./home.ts";
import { appendEvent } from "./events.ts";
import { chooseBoxes, configOrStop, type Deps, helloOf, helloStop, isStop, tailnetOrStop } from "./reach.ts";
import { stopScreen } from "./commands.ts";
import { footer, header, type Screen } from "./screens.ts";
import { AGENT_DEFAULT } from "./ssh.ts";
import { boxes, type Peer } from "./tailscale.ts";

export interface AddAsk {
  name?: string; // the box picked by name, with no list
  agent?: string; // the box's agent account; taskbox-agent when left out
  yes?: boolean; // -y: no typed yes
  jobsRepo?: string; // --jobs-repo: where the notifier keeps this box's hold lease
}

// What box add does after pairing, as box commands the controller runs. Each is in the registry already,
// or is left out until a later release adds it.
export interface AfterPairing {
  phase: "connecting" | "checking";
  argv: string[];
}
export const AFTER: AfterPairing[] = [
  { phase: "connecting", argv: ["connect", "status"] },
  { phase: "checking", argv: ["check", "--away"] },
];

// The list the owner picks from. Two boxes of one name are told apart by their StableNodeID. A box
// already paired says so.
export function choices(list: Peer[], paired: Set<string> = new Set()): string[] {
  const count = new Map<string, number>();
  for (const p of list) count.set(p.name, (count.get(p.name) ?? 0) + 1);
  return list.map((p, i) => `${i + 1}. ${p.name}${count.get(p.name)! > 1 ? ` (${p.node})` : ""}, ${p.online ? "online" : "offline"}${paired.has(p.node) ? ", paired" : ""}`);
}

// A host key's fingerprint, as ssh-keygen -l shows it.
export const keyPrint = (b64: string) => `SHA256:${createHash("sha256").update(Buffer.from(b64, "base64")).digest("base64").replace(/=+$/, "")}`;

// box add's first two phases. It returns the box paired, or the screen that stopped it.
export async function pair(d: Deps, a: AddAsk = {}): Promise<{ box: Paired; fresh: boolean } | Screen> {
  const c = configOrStop(d);
  if (isStop(c)) return stopScreen(d, c, null);
  const names = c.config.boxes.map((b) => b.name);
  const agent = a.agent ?? AGENT_DEFAULT;
  const top = header(names, d.version);
  const pairedNow = names.length ? `Paired with ${names.join(", ")}.` : "Not paired.";
  const none = (stop: string, next: string): Screen => ({ lines: [top, stop, ...footer(pairedNow, "Nothing changed.", next)], code: 1 });
  const badAgent = agentProblem(agent);
  if (badAgent) return none(`--agent ${agent.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 32)} ${badAgent}.`, "Type taskbox box add with the box's agent account, such as taskbox-agent.");
  if (!d.tty && (!a.yes || a.name === undefined)) return stopScreen(d, { stop: "taskbox box add asks you to pick a box and type yes, so it runs in your own terminal, or with a box's name and -y.", next: "Type taskbox box add in Terminal." }, names);
  d.out(top);
  d.out("finding: the boxes tagged tag:taskbox in this controller's Tailscale.");
  const ts = await tailnetOrStop(d);
  if (isStop(ts)) return none(ts.stop, ts.next);
  const found = boxes(ts.state).sort((x, y) => x.name.localeCompare(y.name) || x.node.localeCompare(y.node));
  const ignored = ts.state.peers.filter((p) => p.tagged && p.shared).length;
  if (!found.length) return none(`Tailscale lists no box tagged tag:taskbox${ignored ? `, apart from ${ignored} shared in from another tailnet, which taskbox won't use` : ""}.`, "Check the box is signed in to your tailnet with tag:taskbox: taskbox policy show --box all.");

  let peer: Peer | undefined;
  if (a.name !== undefined) {
    const named = found.filter((p) => p.name.toLowerCase() === a.name!.toLowerCase() || p.node === a.name);
    if (named.length !== 1) return none(named.length ? `Two boxes are named ${a.name}: type taskbox box add and pick one from the list.` : `Tailscale lists no box named ${a.name.replace(/[^A-Za-z0-9-]/g, "").slice(0, 64)} tagged tag:taskbox.`, "Type taskbox box add to see the list.");
    peer = named[0];
  } else {
    d.out("Boxes in your tailnet:");
    for (const l of choices(found, new Set(c.config.boxes.map((b) => b.node)))) d.out(l);
    if (ignored) d.out(`${ignored} shared in from another tailnet ${ignored === 1 ? "is" : "are"} left out.`);
    const pick = (await d.ask(found.length === 1 ? "Type 1 to pick it: " : `Type the number of the box, 1 to ${found.length}: `)).trim();
    const n = /^\d{1,4}$/.test(pick) ? Number(pick) : 0;
    peer = found[n - 1];
  }
  if (!peer) return none("No box picked.", "Type taskbox box add to try again.");
  if (!peer.online) return none(`${peer.name} is offline in Tailscale.`, "Check the box is on and connected to Tailscale, then type taskbox box add.");
  if (!peer.address) return none(`Tailscale lists no address for ${peer.name}.`, "Check the box is connected to Tailscale, then type taskbox box add.");
  if (peer.hostKeys.length !== 1) return none(`Tailscale lists ${peer.hostKeys.length ? "more than one" : "no"} ed25519 host key for ${peer.name}.`, "Check Tailscale SSH is on at the box, then type taskbox box add.");
  // Two paired boxes can't share a name, so --box always means one.
  const clash = c.config.boxes.find((b) => b.node !== peer!.node && b.name.toLowerCase() === peer!.name.toLowerCase());
  if (clash) return none(`Another paired box, ${clash.node}, is named ${peer.name} too.`, "Rename one of them in the Tailscale admin console, then type taskbox box add.");
  const before = c.config.boxes.find((b) => b.node === peer!.node);
  if (!before && c.config.boxes.length >= MAX_BOXES) return none(`taskbox keeps at most ${MAX_BOXES} boxes, and ${MAX_BOXES} are paired.`, "Type taskbox box remove and a name, then taskbox box add.");
  if (c.config.boxes.some((b) => b.node !== peer!.node && b.node.toLowerCase() === peer!.name.toLowerCase())) return none(`${peer.name} is named after another paired box's Tailscale ID.`, "Rename it in the Tailscale admin console, then type taskbox box add.");

  d.out(`pairing: ${peer.name} (${peer.node}) as ${agent}.`);
  // The one connection that takes the key from the map, in a file of its own until it's paired.
  const own = knownHostsFor(d.home, peer.node);
  const trial = `${own}.pairing`;
  writeKnownHosts(trial, peer.node, peer.hostKeys[0]!);
  try {
    const h = await helloOf(d, { address: peer.address, node: peer.node, knownHosts: trial, user: agent }, peer.name);
    if (isStop(h)) return none(h.stop, h.next);
    const bad = helloStop(peer.name, h, null);
    if (bad) return none(bad.stop, bad.next);
    // Re-run on a box paired the same way: nothing to pair, and the later phases run again.
    if (before && before.hostKey === peer.hostKeys[0] && before.installId === h.installId && before.agent === agent && (a.jobsRepo === undefined || a.jobsRepo === before.jobsRepo)) {
      d.out(`${peer.name} is paired already, as ${agent}.`);
      return { box: before, fresh: false };
    }
    // A changed host key or install ID may be another machine: only a person at a terminal, who reads
    // the old and new values and types the box's name, pairs it again. -y never covers it.
    if (before && (before.hostKey !== peer.hostKeys[0] || before.installId !== h.installId)) {
      if (!d.tty) return none(`${peer.name}'s host key or install ID changed since it was paired, so it wasn't paired again.`, "Check the box, then pair it again at your own terminal.");
      d.out(`${peer.name} changed since it was paired. If you didn't reinstall it, stop here and look at the box.`);
      d.out(`  Host key:   ${keyPrint(before.hostKey)} then, ${keyPrint(peer.hostKeys[0]!)} now`);
      d.out(`  Install ID: ${before.installId} then, ${h.installId} now`);
      const typed = (await d.ask(`To pair it again, type its name, ${peer.name}: `)).trim();
      if (typed.toLowerCase() !== peer.name.toLowerCase()) return none("Not paired: the name typed isn't the box's.", "Nothing to do.");
    } else if (!a.yes) {
      const yes = (await d.ask(`${before ? "Pair this controller with" : "Add"} ${peer.name} (${peer.node})${before ? " again" : ""}, as ${agent}? Type yes: `)).trim().toLowerCase();
      if (yes !== "yes") return none("Not paired: you didn't type yes.", "Nothing to do.");
    }
    const jobsRepo = a.jobsRepo ?? before?.jobsRepo;
    const entry: Paired = { name: peer.name, node: peer.node, installId: h.installId!, hostKey: peer.hostKeys[0]!, agent, pairedAt: d.now(), ...(jobsRepo ? { jobsRepo } : {}) };
    // The config is read again here: another box add or box remove may have changed it during the prompts.
    const now = readConfig(d.home);
    if (!now.ok) return none("taskbox's config changed during pairing and can't be read.", "Type taskbox self check.");
    const config: Config = { ...now.config, boxes: [...now.config.boxes.filter((b) => b.node !== peer!.node), entry] };
    const why = configProblem(config.boxes);
    if (why) return none(`Not paired: ${why}.`, "Type taskbox box list to see the paired boxes, then taskbox box add.");
    writeConfig(d.home, config);
    renameSync(trial, own);
    appendEvent(d.home, d.now(), "box.paired", `Paired with ${peer.name} as ${agent}.`, { node: peer.node, installId: entry.installId });
    const rel = h.release ? `It runs ${h.release}${h.release !== d.version ? `, and this controller ${d.version}` : ""}.` : "";
    d.out(`Paired with ${peer.name} (${peer.node}). ${rel}`.trim());
    return { box: entry, fresh: true };
  } finally {
    rmSync(trial, { force: true });
  }
}

// taskbox box remove NAME: forgets one box, its entry and its known-hosts file. Nothing changes on
// the box. It drops a pinned key, so it needs a person at a terminal who types the box's name: no -y,
// so a remove then an add can't pin a changed box unattended.
export async function boxRemove(d: Deps, sel: string): Promise<Screen> {
  const c = configOrStop(d);
  if (isStop(c)) return stopScreen(d, c, null);
  const shown = sel.replace(/[^A-Za-z0-9-]/g, "").slice(0, 64);
  const box = findBox(c.config, sel);
  if (!box) return stopScreen(d, { stop: `No paired box is named ${shown}.`, next: "Type taskbox box list to see them." });
  if (!d.tty) return stopScreen(d, { stop: "taskbox box remove forgets a box's pinned key, so it asks for the box's name to be typed, in your own terminal.", next: "Type it in Terminal yourself." });
  const typed = (await d.ask(`Forget ${box.name}? Nothing changes on the box. Type its name: `)).trim();
  if (typed.toLowerCase() !== box.name.toLowerCase()) return stopScreen(d, { stop: "Not forgotten: the name typed isn't the box's.", next: "Nothing to do." });
  const rest = c.config.boxes.filter((b) => b.node !== box.node);
  writeConfig(d.home, { ...c.config, boxes: rest, default: c.config.default === box.node ? null : c.config.default });
  rmSync(knownHostsFor(d.home, box.node), { force: true });
  appendEvent(d.home, d.now(), "box.removed", `Forgot ${box.name}.`, { node: box.node });
  const names = rest.map((b) => b.name);
  return { lines: [header(names, d.version), `Forgot ${box.name} (${box.node}). Nothing changed on the box.`, ...footer(names.length ? `Paired with ${names.join(", ")}.` : "Not paired.", `Forgot ${box.name}.`, names.length ? "Nothing to do." : "Type taskbox box add.")], code: 0 };
}

// taskbox box use NAME: the box a command goes to when it names none.
export function boxUse(d: Deps, sel: string): Screen {
  const c = configOrStop(d);
  if (isStop(c)) return stopScreen(d, c, null);
  const chosen = chooseBoxes(c.config, sel, false);
  if (isStop(chosen) || sel === "all") return stopScreen(d, isStop(chosen) ? chosen : { stop: "taskbox box use takes one box's name.", next: "Type taskbox box list to see them." });
  const box = chosen[0]!;
  writeConfig(d.home, { ...c.config, default: box.node });
  appendEvent(d.home, d.now(), "box.default", `Commands with no --box go to ${box.name}.`, { node: box.node });
  return { lines: [header(box.name, d.version), `Commands with no --box go to ${box.name}.`, ...footer(`Default box: ${box.name}.`, `Set the default box to ${box.name}.`, "Nothing to do.")], code: 0 };
}
