// taskbox check on the laptop: which Tailscale app, whether it can be read, the config and the
// Claude tool, each with its fix. Then, for each paired box: its pairing, remote, its release, and
// its own checks as remote sees them.
import { claudeSetup, DENY_RULES } from "./claude.ts";
import { boxChecks, pairedNames } from "./commands.ts";
import { ask as boxAsk, chooseBoxes, type Connected, type Deps, helloStop, isStop, peerOrStop, type Stop, tsDeps } from "./reach.ts";
import { knownHostsFor, type Paired, readConfig, writeKnownHosts } from "./home.ts";
import type { TailnetState } from "./tailscale.ts";
import { ANSWERS, READS } from "./schema.ts";
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

export async function laptopChecks(d: Deps, sel?: string): Promise<{ lines: Line[]; boxes: BoxLines[] } | Stop> {
  const out: Line[] = [];
  const add = (name: string, ok: boolean, detail: string, fix?: string) => out.push({ name, ok, detail, ...(ok ? {} : { fix }) });

  const app = await whichApp(tsDeps(d));
  add("Tailscale app", app === "app-store" || app === "standalone", APP_NAMES[app], app === "none" ? "Install Tailscale from the App Store, then sign in." : "Use Tailscale from the App Store.");

  const cfg = readConfig(d.home);
  const chosen = cfg.ok ? chooseBoxes(cfg.config, sel, true) : [];
  if (sel !== undefined && isStop(chosen)) return chosen;
  const boxes = isStop(chosen) ? [] : chosen;
  if (!cfg.ok) add("Config", false, cfg.why === "missing" || cfg.why === "not-controller" ? "taskbox isn't set up as a controller here" : `${d.home.config} couldn't be read`, "Install taskbox for a laptop again, then type taskbox pair.");
  else add("Config", cfg.mode === 0o600, cfg.mode === 0o600 ? "mode 600" : `mode ${cfg.mode.toString(8)}, open to other users`, `Type chmod 600 "${d.home.config}".`);

  const ts = await readTailnet(tsDeps(d));
  if (!ts.ok) add("Tailscale status", false, "can't be read", tailnetProblem(ts, app));
  else add("Tailscale status", ts.state.running, ts.state.running ? "readable, connected" : `reads ${ts.state.backendState || "nothing"}`, "Open the Tailscale app and connect.");

  const claude = claudeSetup(d.userHome, d.home);
  const toolOk = claude.tool === "ok" && claude.shadowed === 0 && claude.disabled;
  add(
    "Claude tool",
    toolOk,
    claude.tool === "missing" ? "not added" : claude.tool === "other" ? "the user's taskbox entry runs something else" : claude.shadowed ? `${claude.shadowed} project entry named taskbox loads in its place` : !claude.disabled ? "a project's .mcp.json could load another taskbox" : "added for your user",
    "Follow the Claude tool steps in docs/controller.md.",
  );
  add("Claude rules", claude.missingRules.length === 0, claude.missingRules.length ? `${claude.missingRules.length} of ${DENY_RULES.length} deny rules missing` : "every deny rule in place", "Follow the Claude rules step in docs/controller.md.");

  add("Pairing", boxes.length > 0, boxes.length ? `${boxes.length} ${boxes.length === 1 ? "box" : "boxes"}: ${boxes.map((b) => b.name).join(", ")}` : "no box paired", "Type taskbox pair.");
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
  const target = { address: p.address, node: box.node, knownHosts };
  const h = await boxAsk(d, target, box.name, "hello", `hello --json --answers ${READS.join(",")}`, 20_000);
  if (isStop(h)) {
    add("remote", false, h.stop, h.next);
    add("Box release", false, "not checked", SKIP);
    return { box, lines: out };
  }
  const bad = helloStop(box.name, h, box.installId);
  add("remote", !bad, bad ? bad.stop : "answers hello, role box, install ID as paired", bad?.next);
  add("Box release", true, `${h.release ?? "release not known"}, answers version ${h.answers}; this laptop ${d.version}, answers version ${ANSWERS}`);
  return bad ? { box, lines: out } : { box, lines: out, connected: { box, target, hello: h, state } };
}

const lineText = (l: Line) => `${l.ok ? "OK  " : "FAIL"}  ${l.name}: ${l.detail}${l.fix ? `. ${l.fix}` : ""}`.replace(/\.\. /g, ". ");

export async function check(d: Deps, sel?: string): Promise<Screen> {
  const r = await laptopChecks(d, sel);
  if (isStop(r)) return { lines: [header(pairedNames(d), d.version), r.stop, ...footer("Nothing checked.", "Nothing changed.", r.next)], code: 1 };
  const lines = [header(r.boxes.length ? r.boxes.map((b) => b.box.name) : pairedNames(d), d.version), "On this laptop:", ...r.lines.map(lineText)];
  let failed = r.lines.filter((l) => !l.ok).length;
  const own = await Promise.all(r.boxes.map(async (b) => (b.connected ? boxChecks(d, b.connected) : undefined)));
  r.boxes.forEach((b, i) => {
    lines.push("", `On ${b.box.name}:`, ...b.lines.map(lineText));
    failed += b.lines.filter((l) => !l.ok).length;
    const c = own[i];
    if (!c) return;
    if (isStop(c)) {
      lines.push(`FAIL  ${c.stop} ${c.next}`);
      failed++;
    } else {
      lines.push(...c.lines);
      failed += c.failed;
    }
  });
  const now = failed ? `${failed} ${failed === 1 ? "check fails" : "checks fail"}.` : "Every check passes.";
  return { lines: [...lines, ...footer(now, "Ran every check.", failed ? "Fix the first FAIL line: its fix is on it." : "Nothing to do.")], code: failed ? 1 : 0 };
}
