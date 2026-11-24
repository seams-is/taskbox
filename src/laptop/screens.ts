// What the controller draws. Every screen starts with the role, the box and
// this laptop's release, and ends with Now, Did and Next, as the box's do. Everything the box sent
// is scrubbed again here, whatever the schema already allowed.
import type { BoxCheck, Jobs, Log, Status } from "./schema.ts";
import { scrub } from "./scrub.ts";

export interface Screen {
  lines: string[];
  code: number;
}

// One box: `box: taskbox-1`. Several: `boxes: taskbox-1, taskbox-2`.
export function header(boxes: string | string[] | null, version: string): string {
  const list = boxes === null ? [] : typeof boxes === "string" ? [boxes] : boxes;
  return `taskbox (controller) · ${list.length > 1 ? `boxes: ${list.join(", ")}` : `box: ${list[0] ?? "none"}`} · ${version}`;
}

export const footer = (now: string, did: string, next: string) => ["", `Now: ${scrub(now)}`, `Did: ${scrub(did)}`, `Next: ${scrub(next)}`];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const two = (n: number) => String(n).padStart(2, "0");
export const hhmm = (ms: number) => {
  const d = new Date(ms);
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
};
export const dayTime = (ms: number | null) => {
  if (ms === null) return "time not known";
  const d = new Date(ms);
  return `${two(d.getDate())} ${MONTHS[d.getMonth()]} ${hhmm(ms)}`;
};
const minutes = (from: number | null, to: number | null) => (from !== null && to !== null && to >= from ? `${Math.max(1, Math.round((to - from) / 60_000))} min` : "");

// The box's state in a few words, for Now.
export function nowLine(s: Status): string {
  if (s.state === null) return "A state taskbox doesn't know.";
  if (s.state === "Running" && s.jobs.length > 1) return `Running ${s.jobs.length} jobs.`;
  const name = s.jobs[0]?.name ?? s.job;
  if (s.state === "Running" && name) return `Running ${scrub(name, 80)}.`;
  return `${s.state}.`;
}

export function nextFor(s: Status): string {
  switch (s.state) {
    case "Needs you":
      return "Type taskbox check to see what the box needs.";
    case "Failing":
      return "Nothing to do: agents fix it. taskbox check shows which check fails.";
    case "Stopped":
      return "Nothing to do here: the loop starts again when ci starts it at the box.";
    case "Downloading":
      return "Nothing to do. Type taskbox watch to follow the download.";
    case null:
      return "Type taskbox check.";
    default:
      return "Nothing to do.";
  }
}

// The lines between the header and the footer for status and watch.
export function statusBody(s: Status, own: string): string[] {
  const out: string[] = [];
  out.push(`State: ${s.state ?? "not known"}`);
  if (s.slots.total > 1) out.push(`Slots: ${s.slots.busy} of ${s.slots.total} busy`);
  const running = s.jobs.length ? s.jobs : s.state === "Running" ? [{ name: s.job, kind: null, since: null }] : [];
  for (const j of running) out.push(`Job: ${j.name ? scrub(j.name, 120) : "name not known"}${j.kind ? ` (${j.kind})` : ""}${j.since !== null ? `, since ${hhmm(j.since)}` : ""}`);
  if (s.lastJob) out.push(`Last job: ${dayTime(s.lastJob.at)}, ${s.lastJob.result ?? "result not known"}`);
  if (s.othersLoggedIn > 0) out.push(`Other users logged in at the box: ${s.othersLoggedIn}`);
  const rel = s.release ?? "release not known";
  out.push(`Box: ${rel}${s.commit ? ` (${s.commit})` : ""}${s.release && s.release !== own ? `. This laptop: ${own}.` : ""}`);
  return out;
}

export function jobsBody(j: Jobs): string[] {
  if (!j.jobs.length) return ["No jobs yet."];
  return j.jobs.map((r) =>
    [dayTime(r.startedAt), r.result ?? "running", minutes(r.jobAt ?? r.startedAt, r.endedAt), scrub(r.name, 120) || "name not known", r.vmDeleted ? "VM deleted" : r.endedAt !== null ? "VM not deleted" : ""].filter(Boolean).join("  "),
  );
}

export function logBody(l: Log): string[] {
  if (!l.lines.length) return ["No log yet for the last day."];
  return l.lines.map((e) => `${e.at !== null ? hhmm(e.at) : "--:--"}  ${scrub(e.text, 120)}`);
}

export function boxChecksBody(checks: BoxCheck[]): string[] {
  return checks.map((c) => `${(c.status ?? "?").padEnd(4)}  ${scrub(c.name, 60)}${c.detail ? `: ${scrub(c.detail, 120)}` : ""}`);
}
