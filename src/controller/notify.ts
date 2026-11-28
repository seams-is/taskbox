// taskbox notify: one run of the notifier. It reads each paired box, leaves a poll in its agent spool,
// keeps the hold lease the box names this controller to write, and returns what to post. launchd
// runs it every 30 s with --post; what it keeps between runs is notify.json, 0600.
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { cleanLine } from "../envelope.ts";
import { endLease, type Gh, type LeaseMemory, leaseDone, leaseStep, writeLease } from "../hold.ts";
import { parseStatement } from "../release.ts";
import { type Home, type Paired, readSmall, type Source, writePrivateFile } from "./home.ts";
import { API, type Fetch, get, MAX, RELEASE_TAG, STATEMENT } from "./releases.ts";
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
  offline?: boolean; // offline was said
  told?: Record<string, { at: number; held?: number }>; // each cause's last note
  lease?: LeaseMemory;
}
export interface Memory {
  v: 1;
  id: string; // this controller's id, which its polls carry, kept in a file of its own
  boxes: Record<string, BoxMemory>;
  self?: BoxMemory; // notes about this Mac itself
  releases?: ReleaseMemory;
}
// The public repo's published releases, as last read: each tag seen, and when the list was read.
interface ReleaseMemory {
  repo: string;
  seen: string[];
  readAt: number;
}

// This controller's id, made once and kept apart from the notes' memory, so a lost notify.json
// doesn't change it (the box names its hold's writer by it).
export function controllerId(h: Home): string {
  const f = readSmall(h.controllerId, 100);
  const have = "text" in f ? f.text.trim() : "";
  if (ID.test(have)) return have;
  const id = randomBytes(8).toString("hex");
  writePrivateFile(h.controllerId, `${id}\n`);
  return id;
}

export function readMemory(h: Home): Memory {
  const id = controllerId(h);
  const f = readSmall(h.notify, 64_000);
  try {
    const v = "text" in f ? (JSON.parse(f.text) as Memory) : undefined;
    if (v && v.v === 1 && v.boxes && typeof v.boxes === "object" && !Array.isArray(v.boxes)) return { ...v, id };
  } catch {}
  return { v: 1, id, boxes: {} };
}

export interface NotifyDeps extends Deps {
  gh?: Gh; // the owner's own gh, for the hold lease
  fetch?: Fetch; // GitHub's public API, for the releases
}

// Each release published on the repo this controller updates from is said once, with the commit its
// statement names, so a release nobody here meant to publish is seen before the boxes take it. The
// list is read once an hour, inside GitHub's limit for a caller with no token. The first read only
// remembers what is there.
export const RELEASES_EVERY_MS = 60 * 60_000;
async function newReleases(d: NotifyDeps, src: Source, kept: ReleaseMemory | undefined, now: number, notes: Note[]): Promise<ReleaseMemory | undefined> {
  const prev = kept && typeof kept.repo === "string" && Array.isArray(kept.seen) && kept.seen.every((t) => typeof t === "string") && Number.isSafeInteger(kept.readAt) ? kept : undefined;
  const repo = `${src.owner}/${src.repo}`;
  if (prev?.repo === repo && now - prev.readAt < RELEASES_EVERY_MS && now >= prev.readAt) return prev;
  const r = d.fetch ? await get(d.fetch, `${API}/repos/${repo}/releases?per_page=30`, 4_000_000, 15_000) : undefined;
  if (!r?.ok) return prev;
  let list: Record<string, unknown>[];
  try {
    const v = JSON.parse(new TextDecoder().decode(r.value)) as unknown;
    list = Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
  } catch {
    return prev;
  }
  const published = list.filter((x) => x && x.draft === false && typeof x.tag_name === "string" && RELEASE_TAG.test(x.tag_name));
  const tags = published.map((x) => x.tag_name as string);
  if (!prev || prev.repo !== repo) return { repo, seen: tags.slice(0, 50), readAt: now };
  for (const x of published.filter((y) => !prev.seen.includes(y.tag_name as string)).reverse()) {
    const tag = x.tag_name as string;
    const link = (Array.isArray(x.assets) ? (x.assets as Record<string, unknown>[]) : []).find((a) => a?.name === STATEMENT)?.browser_download_url;
    const got = link === `https://github.com/${repo}/releases/download/${tag}/${STATEMENT}` ? await get(d.fetch!, link, MAX[STATEMENT], 15_000) : undefined;
    const st = got?.ok ? parseStatement(new TextDecoder().decode(got.value)) : undefined;
    const commit = st && st.tag === tag ? `Commit ${st.commit.slice(0, 7)}` : "No statement taskbox reads";
    notes.push({ box: "", title: `taskbox ${tag} published`, body: `${commit}, on ${repo}. Not signed here? Look before the boxes take it.` });
  }
  return { repo, seen: [...new Set([...tags, ...prev.seen])].slice(0, 50), readAt: now };
}

// The hold the box reports in its status, and whether it names this controller as the lease's writer.
// A box that says neither has no hold for the lease, so nothing is written for it.
export function holdOf(result: Record<string, unknown>, id: string) {
  const h = result.hold && typeof result.hold === "object" ? (result.hold as Record<string, unknown>) : undefined;
  const hold = h && Number.isSafeInteger(h.since) && typeof h.why === "string" ? { since: h.since as number, why: h.why } : undefined;
  return { hold, writer: h?.writer === id, requestWaiting: result.requestWaiting === true };
}

// At most one note per box and cause in this long; the next one counts those held back.
export const NOTE_EVERY_MS = 10 * 60_000;
function tell(m: BoxMemory, notes: Note[], now: number, cause: string, n: Note): void {
  m.told ??= {};
  const last = m.told[cause];
  if (last && now - last.at < NOTE_EVERY_MS && now >= last.at) {
    last.held = (last.held ?? 0) + 1;
    return;
  }
  const held = last?.held ? ` (${last.held} more since the last note)` : "";
  notes.push({ ...n, body: `${n.body}${held}` });
  m.told[cause] = { at: now };
}

async function oneBox(d: NotifyDeps, box: Paired, m: BoxMemory, id: string, state: Parameters<typeof connectBox>[2], notes: Note[]): Promise<void> {
  const now = d.now();
  const name = box.name;
  const c = await connectBox(d, box, state);
  let result: Record<string, unknown> | undefined;
  if (!isStop(c)) {
    const v = c.hello.answers;
    // The poll first, on a box that takes it: the box knows this controller watches.
    if (v >= 4) await boxCall(sshDeps(d), c.target, remoteLine(["poll", id, "--json", "--answers", String(v)]), 30_000).catch(() => undefined);
    // A box one release behind answers status in its own words, and is reached all the same.
    const r = await boxCall(sshDeps(d), c.target, v >= 4 ? remoteLine(["status", "--json", "--answers", String(v)]) : "status --json", 30_000).catch(() => undefined);
    const a = r?.ok ? readAnswer("status", r.stdout, box.installId, v) : undefined;
    if (a?.ok) result = a.answer as unknown as Record<string, unknown>;
  }
  if (!result) {
    m.offlineSince ??= now;
    if (!m.offline && now - m.offlineSince >= OFFLINE_MS) {
      tell(m, notes, now, "offline", { box: name, title: `${name} is offline`, body: `This controller hasn't reached ${name} for 5 minutes. If it lost power, it may be waiting for its FileVault password.` });
      m.offline = true;
    }
  } else {
    if (m.offline) tell(m, notes, now, "back", { box: name, title: `${name} is back`, body: `${name} answers again.` });
    delete m.offlineSince;
    delete m.offline;
    const word = typeof result.state === "string" ? result.state : null;
    if (word && BAD.has(word) && word !== m.state) tell(m, notes, now, word, { box: name, title: `${name}: ${word}`, body: `Open taskbox to see why: taskbox status --box ${name}.` });
    m.state = word;
  }
  // The hold lease, when the box names this controller as its writer, and only in the jobs repo the
  // pairing names: never a repo the box's own answer names.
  const v = result ? holdOf(result, id) : { hold: undefined, writer: false, requestWaiting: false };
  m.lease ??= {};
  const step = leaseStep(name.toLowerCase(), { answered: !!result, hold: v.hold, requestWaiting: v.requestWaiting }, m.lease, now, v.writer);
  if (step.do !== "none" && d.gh && box.jobsRepo) {
    const why = step.do === "write" ? await writeLease(d.gh, box.jobsRepo, step.lease) : await endLease(d.gh, box.jobsRepo, name.toLowerCase());
    if (!why) leaseDone(m.lease, step, now);
  }
}

// One run: what to post. Nothing is posted here.
export async function notifyOnce(d: NotifyDeps): Promise<Note[]> {
  const mem = readMemory(d.home);
  const cfg = configOrStop(d);
  if (isStop(cfg)) return [];
  const ts = await tailnetOrStop(d);
  const notes: Note[] = [];
  const kept: Record<string, BoxMemory> = {};
  if (isStop(ts)) {
    // This Mac's own Tailscale is off: one note for that, and no box counts as offline.
    for (const b of cfg.config.boxes) kept[b.node] = { ...mem.boxes[b.node], offlineSince: undefined };
    mem.self ??= {};
    // Said once while it lasts; again only after it was back.
    if (!mem.self.told?.tailscale) tell(mem.self, notes, d.now(), "tailscale", { box: "", title: "Tailscale is off on this Mac", body: "Open Tailscale and connect: the boxes can't be read until it is." });
  } else {
    delete mem.self?.told?.tailscale;
    await Promise.all(
      cfg.config.boxes.map(async (b) => {
        const m = mem.boxes[b.node] ?? {};
        kept[b.node] = m;
        await oneBox(d, b, m, mem.id, ts.state, notes);
      }),
    );
  }
  const releases = cfg.config.source ? await newReleases(d, cfg.config.source, mem.releases, d.now(), notes) : undefined;
  writePrivateFile(d.home.notify, `${JSON.stringify({ v: 1, id: mem.id, boxes: kept, self: mem.self ?? {}, ...(releases ? { releases } : {}) })}\n`);
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
