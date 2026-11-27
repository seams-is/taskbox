// taskbox notify: one run of the notifier. It reads each paired box, leaves a poll in its agent spool,
// keeps the hold lease the box names this controller to write, and returns what to post. launchd
// runs it every 30 s with --post; what it keeps between runs is notify.json, 0600.
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { cleanLine } from "../envelope.ts";
import { endLease, type Gh, type LeaseMemory, leaseDone, leaseStep, REPO_NAME, writeLease } from "../hold.ts";
import { type Home, type Paired, readSmall, writePrivateFile } from "./home.ts";
import { configOrStop, connectBox, type Deps, isStop, sshDeps, tailnetOrStop } from "./reach.ts";
import { readAnswer } from "./schema.ts";
import { boxCall, remoteLine } from "./ssh.ts";

export const OFFLINE_MS = 5 * 60_000;
export const LABEL = "local.taskbox.notify";
const ID = /^[0-9a-f]{16}$/;
const BAD = new Set(["Failing", "Needs you"]);

export interface Note {
  box: string;
  title: string;
  body: string;
}

interface BoxMemory {
  state?: string | null; // the state word last read
  offlineSince?: number;
  told?: boolean; // offline was said
  lease?: LeaseMemory;
}
export interface Memory {
  v: 1;
  id: string; // this controller's id, which its polls carry
  boxes: Record<string, BoxMemory>;
}

export function readMemory(h: Home): Memory {
  const f = readSmall(h.notify, 64_000);
  try {
    const v = "text" in f ? (JSON.parse(f.text) as Memory) : undefined;
    if (v && v.v === 1 && typeof v.id === "string" && ID.test(v.id) && v.boxes && typeof v.boxes === "object" && !Array.isArray(v.boxes)) return v;
  } catch {}
  return { v: 1, id: randomBytes(8).toString("hex"), boxes: {} };
}

export interface NotifyDeps extends Deps {
  gh?: Gh; // the owner's own gh, for the hold lease
}

// The hold the box reports in its status, and whether it names this controller as the lease's writer.
// A box that says neither has no hold for the lease, so nothing is written for it.
export function holdOf(result: Record<string, unknown>, id: string) {
  const h = result.hold && typeof result.hold === "object" ? (result.hold as Record<string, unknown>) : undefined;
  const hold = h && Number.isSafeInteger(h.since) && typeof h.why === "string" ? { since: h.since as number, why: h.why } : undefined;
  return { hold, writer: h?.writer === id, repo: typeof result.jobsRepo === "string" && REPO_NAME.test(result.jobsRepo) ? result.jobsRepo : undefined, requestWaiting: result.requestWaiting === true };
}

async function oneBox(d: NotifyDeps, box: Paired, m: BoxMemory, id: string, state: Parameters<typeof connectBox>[2] | undefined, notes: Note[]): Promise<void> {
  const now = d.now();
  const name = box.name;
  const c = state ? await connectBox(d, box, state) : undefined;
  let result: Record<string, unknown> | undefined;
  if (c && !isStop(c) && c.hello.answers >= 4) {
    // The poll first: the box knows this controller watches, whatever status says.
    await boxCall(sshDeps(d), c.target, remoteLine(["poll", id, "--json", "--answers", String(c.hello.answers)]), 30_000).catch(() => undefined);
    const r = await boxCall(sshDeps(d), c.target, remoteLine(["status", "--json", "--answers", String(c.hello.answers)]), 30_000).catch(() => undefined);
    const a = r?.ok ? readAnswer("status", r.stdout, box.installId, 4) : undefined;
    if (a?.ok) result = a.answer as unknown as Record<string, unknown>;
  }
  if (!result) {
    m.offlineSince ??= now;
    if (!m.told && now - m.offlineSince >= OFFLINE_MS) {
      notes.push({ box: name, title: `${name} is offline`, body: `The controller hasn't reached ${name} for 5 minutes. A box that lost power waits for its FileVault password.` });
      m.told = true;
    }
  } else {
    if (m.told) notes.push({ box: name, title: `${name} is back`, body: `${name} answers again.` });
    delete m.offlineSince;
    delete m.told;
    const word = typeof result.state === "string" ? result.state : null;
    if (word && BAD.has(word) && word !== m.state) notes.push({ box: name, title: `${name}: ${word}`, body: `Open taskbox to see why: taskbox status --box ${name}.` });
    m.state = word;
  }
  // The hold lease, when the box names this controller as its writer.
  const v = result ? holdOf(result, id) : { hold: undefined, writer: false, repo: undefined, requestWaiting: false };
  m.lease ??= {};
  const step = leaseStep(name.toLowerCase(), { answered: !!result, hold: v.hold, requestWaiting: v.requestWaiting }, m.lease, now, v.writer);
  if (step.do !== "none" && d.gh && v.repo) {
    const why = step.do === "write" ? await writeLease(d.gh, v.repo, step.lease) : await endLease(d.gh, v.repo, name.toLowerCase());
    if (!why) leaseDone(m.lease, step, now);
  }
}

// One run: what to post. Nothing is posted here.
export async function notifyOnce(d: NotifyDeps): Promise<Note[]> {
  const mem = readMemory(d.home);
  const cfg = configOrStop(d);
  if (isStop(cfg)) return [];
  const ts = await tailnetOrStop(d);
  const state = isStop(ts) ? undefined : ts.state;
  const notes: Note[] = [];
  const kept: Record<string, BoxMemory> = {};
  await Promise.all(
    cfg.config.boxes.map(async (b) => {
      const m = mem.boxes[b.node] ?? {};
      kept[b.node] = m;
      await oneBox(d, b, m, mem.id, state, notes);
    }),
  );
  writePrivateFile(d.home.notify, `${JSON.stringify({ v: 1, id: mem.id, boxes: kept })}\n`);
  return notes.map((n) => ({ box: n.box, title: cleanLine(n.title).slice(0, 80), body: cleanLine(n.body) }));
}

export const OSASCRIPT = "/usr/bin/osascript";
// osascript's line for one note: the text goes as arguments, never into the script.
export const postArgv = (n: Note) => [OSASCRIPT, "-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", n.title, n.body];

// The owner's LaunchAgent, in the owner's own domain: taskbox notify --post every 30 s.
export function agentPlist(taskbox: string): string {
  if (!taskbox.startsWith("/") || /[<>&"]/.test(taskbox)) throw new Error("not a path for a plist");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${taskbox}</string><string>notify</string><string>--post</string></array>
  <key>StartInterval</key><integer>30</integer>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
`;
}

// The owner's gh, at the paths Homebrew puts it, run with the controller's fixed environment.
export const GH_PATHS = ["/opt/homebrew/bin/gh", "/usr/local/bin/gh"];
export const ghAt = (exists: (p: string) => boolean = existsSync) => GH_PATHS.find(exists);
