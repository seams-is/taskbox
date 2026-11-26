// taskbox self check: the controller's own rows, Tailscale first, each with its fix. Then, for each paired
// box: its pairing, its agent account and its release. The box's own rows are taskbox check --box.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pairedNames } from "./commands.ts";
import { chooseBoxes, helloOf, type Connected, type Deps, helloStop, isStop, peerOrStop, type Stop, tsDeps } from "./reach.ts";
import { knownHostsFor, type Paired, readConfig, writeKnownHosts } from "./home.ts";
import type { TailnetState } from "./tailscale.ts";
import { ANSWERS } from "./schema.ts";
import { footer, header, type Screen } from "./screens.ts";
import { APP_NAMES, readTailnet, tailnetProblem, whichApp } from "./tailscale.ts";

export interface Line {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

const SKIP = "Fix the line above first.";

export interface BoxLines {
  box: Paired;
  lines: Line[];
  connected?: Connected;
}

export async function controllerChecks(d: Deps): Promise<{ lines: Line[]; boxes: BoxLines[] }> {
  const out: Line[] = [];
  const add = (name: string, ok: boolean, detail: string, fix?: string) => out.push({ name, ok, detail, ...(ok ? {} : { fix }) });

  // Tailscale first: every command that reaches a box stops on it.
  const ts = await readTailnet(tsDeps(d));
  const app = await whichApp(tsDeps(d));
  if (!ts.ok) add("Tailscale", false, "can't be read", tailnetProblem(ts, app));
  else add("Tailscale", ts.state.running, ts.state.running ? "on and connected" : `off: it reads ${ts.state.backendState || "nothing"}`, "Open Tailscale and connect.");
  add("Tailscale app", app === "app-store" || app === "standalone", APP_NAMES[app], app === "none" ? "Install Tailscale from the App Store, then sign in." : "Use Tailscale from the App Store.");

  const cfg = readConfig(d.home);
  const boxes = cfg.ok ? cfg.config.boxes : [];
  if (!cfg.ok) add("Config", false, cfg.why === "missing" || cfg.why === "not-controller" ? "taskbox isn't installed for a controller here" : `${d.home.config} couldn't be read`, "Install taskbox for a controller again, then type taskbox box add.");
  else add("Config", cfg.mode === 0o600, cfg.mode === 0o600 ? "mode 600" : `mode ${cfg.mode.toString(8)}, open to other users`, `Type chmod 600 "${d.home.config}".`);
  const installed = existsSync(join(d.home.bin, "taskbox")) && existsSync(join(d.home.current, "app", "src", "controller", "main.ts"));
  add("Install", installed, installed ? `taskbox ${d.version}, from signed releases` : "no signed release in use", "Install taskbox for a controller again, from its release page.");

  add("Pairing", boxes.length > 0, boxes.length ? `${boxes.length} ${boxes.length === 1 ? "box" : "boxes"}: ${boxes.map((b) => b.name).join(", ")}` : "no box paired", "Type taskbox box add.");
  const state = ts.ok && ts.state.running ? ts.state : undefined;
  return { lines: out, boxes: await Promise.all(boxes.map((b) => boxLines(d, b, state))) };
}

// One box's pairing checks, each a line with its fix. The same checks as every command makes.
async function boxLines(d: Deps, box: Paired, state: TailnetState | undefined): Promise<BoxLines> {
  const out: Line[] = [];
  const add = (name: string, ok: boolean, detail: string, fix?: string) => out.push({ name, ok, detail, ...(ok ? {} : { fix }) });
  if (!state) {
    add("Pairing", false, "unchecked: Tailscale can't be read", SKIP);
    return { box, lines: out };
  }
  const p = peerOrStop(box, state);
  if (isStop(p)) {
    add("Pairing", false, p.stop, p.next);
    return { box, lines: out };
  }
  add("Pairing", true, `${box.name} (${box.node}), tagged, online, host key as paired`);
  const knownHosts = knownHostsFor(d.home, box.node);
  writeKnownHosts(knownHosts, box.node, box.hostKey);
  const target = { address: p.address, node: box.node, knownHosts, user: box.agent };
  const h = await helloOf(d, target, box.name);
  if (isStop(h)) {
    add("Agent account", false, h.stop, h.next);
    add("Box release", false, "not checked", SKIP);
    return { box, lines: out };
  }
  const bad = helloStop(box.name, h, box.installId);
  add("Agent account", !bad, bad ? bad.stop : `${box.agent} answers hello, role box, install ID as paired`, bad?.next);
  add("Box release", true, `${h.release ?? "release not known"}, answers version ${h.answers}; this controller ${d.version}, answers version ${ANSWERS}`);
  return bad ? { box, lines: out } : { box, lines: out, connected: { box, target, hello: h, state } };
}

const lineText = (l: Line) => `${l.ok ? "OK  " : "FAIL"}  ${l.name}: ${l.detail}${l.fix ? `. ${l.fix}` : ""}`.replace(/\.\. /g, ". ");

export async function check(d: Deps): Promise<Screen> {
  const r = await controllerChecks(d);
  const lines = [header(r.boxes.length ? r.boxes.map((b) => b.box.name) : pairedNames(d), d.version), "On this controller:", ...r.lines.map(lineText)];
  let failed = r.lines.filter((l) => !l.ok).length;
  for (const b of r.boxes) {
    lines.push("", `${b.box.name}'s pairing:`, ...b.lines.map(lineText));
    failed += b.lines.filter((l) => !l.ok).length;
  }
  const now = failed ? `${failed} ${failed === 1 ? "check fails" : "checks fail"}.` : "Every check passes.";
  return { lines: [...lines, ...footer(now, "Ran the controller's checks.", failed ? "Fix the first FAIL line: its fix is on it." : "Nothing to do. Each box's own checks: taskbox check --box all.")], code: failed ? 1 : 0 };
}
