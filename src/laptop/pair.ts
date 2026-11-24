// taskbox pair (owner answer 11): no code. Tailscale proves which box it is: the
// StableNodeID and tag in the map its servers sign, and the tunnel to that node. The owner picks the
// box by name and confirms. The controller runs hello over the key the map lists, checks role box,
// the tag and the node, and stores the StableNodeID, the install ID and the ed25519 host key. There
// is no step at the box. Pairing grants nothing: it lets the controller notice a swapped or
// reinstalled box.
import { renameSync, rmSync } from "node:fs";
import { ask as boxAsk, chooseBoxes, configOrStop, type Deps, helloStop, isStop, tailnetOrStop } from "./reach.ts";
import { type Config, configProblem, knownHostsFor, MAX_BOXES, readConfig, writeConfig, writeKnownHosts } from "./home.ts";
import { stopScreen } from "./commands.ts";
import { footer, header, type Screen } from "./screens.ts";
import { boxes, type Peer } from "./tailscale.ts";

// The list the owner picks from. Two boxes of one name are told apart by their StableNodeID. A box
// already paired says so.
export function choices(list: Peer[], paired: Set<string> = new Set()): string[] {
  const count = new Map<string, number>();
  for (const p of list) count.set(p.name, (count.get(p.name) ?? 0) + 1);
  return list.map((p, i) => `${i + 1}. ${p.name}${count.get(p.name)! > 1 ? ` (${p.node})` : ""}, ${p.online ? "online" : "offline"}${paired.has(p.node) ? ", paired" : ""}`);
}

export async function pair(d: Deps): Promise<Screen> {
  const c = configOrStop(d);
  if (isStop(c)) return stopScreen(d, c, null);
  const names = c.config.boxes.map((b) => b.name);
  if (!d.tty) return stopScreen(d, { stop: "taskbox pair asks you to pick a box and type yes, so it runs only in your own terminal.", next: "Type taskbox pair in Terminal." }, names);
  const ts = await tailnetOrStop(d);
  if (isStop(ts)) return stopScreen(d, ts, names);
  const found = boxes(ts.state).sort((a, b) => a.name.localeCompare(b.name) || a.node.localeCompare(b.node));
  const ignored = ts.state.peers.filter((p) => p.tagged && p.shared).length;
  const top = header(names, d.version);
  const pairedNow = names.length ? `Paired with ${names.join(", ")}.` : "Not paired.";
  const none = (stop: string, next: string): Screen => ({ lines: [top, stop, ...footer(pairedNow, "Nothing changed.", next)], code: 1 });
  if (!found.length) return none(`Tailscale lists no box tagged tag:taskbox${ignored ? `, apart from ${ignored} shared in from another tailnet, which taskbox won't use` : ""}.`, "Check the box is signed in to your tailnet with tag:taskbox (docs/tailnet-policy.md).");

  d.out(top);
  d.out("Boxes in your tailnet:");
  for (const l of choices(found, new Set(c.config.boxes.map((b) => b.node)))) d.out(l);
  if (ignored) d.out(`${ignored} shared in from another tailnet ${ignored === 1 ? "is" : "are"} left out.`);
  const pick = (await d.ask(found.length === 1 ? "Type 1 to pick it: " : `Type the number of the box, 1 to ${found.length}: `)).trim();
  const n = /^\d{1,4}$/.test(pick) ? Number(pick) : 0;
  const peer = found[n - 1];
  if (!peer) return none("No box picked.", "Type taskbox pair to try again.");
  if (!peer.online) return none(`${peer.name} is offline in Tailscale.`, "Check the box is on and connected to Tailscale, then type taskbox pair.");
  if (!peer.address) return none(`Tailscale lists no address for ${peer.name}.`, "Check the box is connected to Tailscale, then type taskbox pair.");
  if (peer.hostKeys.length !== 1) return none(`Tailscale lists ${peer.hostKeys.length ? "more than one" : "no"} ed25519 host key for ${peer.name}.`, "Check Tailscale SSH is on at the box, then type taskbox pair.");
  // Two paired boxes can't share a name, so --box always means one.
  const clash = c.config.boxes.find((b) => b.node !== peer.node && b.name.toLowerCase() === peer.name.toLowerCase());
  if (clash) return none(`Another paired box, ${clash.node}, is named ${peer.name} too.`, "Rename one of them in the Tailscale admin console, then type taskbox pair.");
  const again = c.config.boxes.some((b) => b.node === peer.node);
  if (!again && c.config.boxes.length >= MAX_BOXES) return none(`taskbox keeps at most ${MAX_BOXES} boxes, and ${MAX_BOXES} are paired.`, "Type taskbox unpair --box and a name, then taskbox pair.");
  if (c.config.boxes.some((b) => b.node !== peer.node && b.node.toLowerCase() === peer.name.toLowerCase())) return none(`${peer.name} is named after another paired box's Tailscale ID.`, "Rename it in the Tailscale admin console, then type taskbox pair.");
  const yes = (await d.ask(`${again ? "Pair this laptop with" : "Add"} ${peer.name} (${peer.node})${again ? " again" : ""}? Type yes: `)).trim().toLowerCase();
  if (yes !== "yes") return none("Not paired: you didn't type yes.", "Nothing to do.");

  // The one connection that takes the key from the map, in a file of its own until it's paired.
  const own = knownHostsFor(d.home, peer.node);
  const trial = `${own}.pairing`;
  writeKnownHosts(trial, peer.node, peer.hostKeys[0]!);
  try {
    const h = await boxAsk(d, { address: peer.address, node: peer.node, knownHosts: trial }, peer.name, "hello", "hello", 20_000);
    if (isStop(h)) return none(h.stop, h.next);
    const bad = helloStop(peer.name, h, null);
    if (bad) return none(bad.stop, bad.next);
    const entry = { name: peer.name, node: peer.node, installId: h.installId!, hostKey: peer.hostKeys[0]!, pairedAt: d.now() };
    // The config is read again here: another pair or unpair may have changed it during the prompts.
    const now = readConfig(d.home);
    if (!now.ok) return none("taskbox's config changed during pairing and can't be read.", "Type taskbox check.");
    const config: Config = { ...now.config, boxes: [...now.config.boxes.filter((b) => b.node !== peer.node), entry] };
    const why = configProblem(config.boxes);
    if (why) return none(`Not paired: ${why}.`, "Type taskbox status to see the paired boxes, then taskbox pair.");
    writeConfig(d.home, config);
    renameSync(trial, own);
    const rel = h.release ? `It runs ${h.release}${h.release !== d.version ? `, and this laptop ${d.version}` : ""}.` : "";
    const all = config.boxes.map((b) => b.name);
    return { lines: [header(all, d.version), `Paired with ${peer.name} (${peer.node}). ${rel}`.trim(), ...footer(`Paired with ${all.join(", ")}.`, `Paired with ${peer.name}.`, "Type taskbox status.")], code: 0 };
  } finally {
    rmSync(trial, { force: true });
  }
}

// taskbox unpair --box <name>: forgets one box, its entry and its known-hosts file. Nothing changes
// on the box.
export function unpair(d: Deps, sel: string): Screen {
  const c = configOrStop(d);
  if (isStop(c)) return stopScreen(d, c, null);
  if (!d.tty) return stopScreen(d, { stop: "taskbox unpair runs only in your own terminal.", next: `Type taskbox unpair --box ${sel.replace(/[^A-Za-z0-9-]/g, "").slice(0, 64)} in Terminal.` });
  const chosen = chooseBoxes(c.config, sel, false);
  if (isStop(chosen)) return stopScreen(d, chosen);
  const box = chosen[0]!;
  const rest = c.config.boxes.filter((b) => b.node !== box.node);
  writeConfig(d.home, { ...c.config, boxes: rest });
  rmSync(knownHostsFor(d.home, box.node), { force: true });
  const names = rest.map((b) => b.name);
  return { lines: [header(names, d.version), `Forgot ${box.name} (${box.node}). Nothing changed on the box.`, ...footer(names.length ? `Paired with ${names.join(", ")}.` : "Not paired.", `Forgot ${box.name}.`, names.length ? "Nothing to do." : "Type taskbox pair.")], code: 0 };
}
