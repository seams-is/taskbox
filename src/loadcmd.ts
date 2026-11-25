// taskbox load start, load on --only, load off and load report.
// on and off are the service account's, at the box, like stop and start. report is anyone's,
// remote too, read from the copies every user may read.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadReportAnswer } from "./answers.ts";
import { awayChecks } from "./away.ts";
import type { CheckContext } from "./checks.ts";
import { canaryLabels, fingerprint, TEMPLATES } from "./watchdog.ts";
import { GitHub } from "./github.ts";
import { Log } from "./log.ts";
import { type Config, type Kind, kindsOf, labelsFor, loadRepoOf, readStateJson } from "./config.ts";
import { readJobs } from "./jobs.ts";
import { currentSession, FRESH_MS, LOAD_MAX_MS, LOAD_MIN_MS, loadBlind, loadOff, loadOn, parseFor, readLoad } from "./load.ts";
import { loadReport, loadReportLines } from "./loadreport.ts";
import type { OpsDeps } from "./ops.ts";
import { serviceName } from "./names.ts";

const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16);

// The checklist: taskbox check --away's checks not met, by name (v2.5.0, src/away.ts). load on names them
// and the report keeps them as they stood, so a slow result on a box that fails the checklist isn't
// read as the scheduler's. It never stops load on: the owner chose to test now.
export async function checklistNotMet(c: CheckContext): Promise<string[]> {
  try {
    return (await awayChecks(c)).filter((k) => k.status === "FAIL").map((k) => k.name.replace(/[^\x20-\x7e]/g, "").slice(0, 60));
  } catch {
    return ["the checklist couldn't be read"];
  }
}

// taskbox template show load: the test repo's workflow, made from the box's settings, as taskbox template show test-job
// makes the canary (v2.5.0, src/watchdog.ts). Its canary pattern asks for the same jobs as the
// canary: one per kind, on each kind's own label.
export function loadSettings(cfg: Config) {
  const first = (k: Kind) => labelsFor(cfg, k)[0]!;
  const linux = kindsOf(cfg).includes("linux");
  return { v: 1, canary: canaryLabels(cfg), macos: first("macos"), ...(linux ? { linux: first("linux") } : {}) };
}
export function loadWorkflowYaml(cfg: Config, template = readFileSync(join(TEMPLATES, "taskbox-load.yml"), "utf8")): string {
  const s = loadSettings(cfg);
  // A box with no Linux kind has no Linux job, and no burst.
  const body = s.linux ? template.replace(/^# __LINUX(START|END)__\n/gm, "") : template.replace(/^# __LINUXSTART__\n[\s\S]*?^# __LINUXEND__\n/m, "");
  const values: Record<string, string> = {
    FINGERPRINT: fingerprint(s),
    CANARYLABELS: `[${s.canary.map((l) => JSON.stringify(l)).join(", ")}]`,
    MACOSLABEL: s.macos,
    LINUXLABEL: s.linux ?? "",
    PATTERNS: `[${(s.linux ? ["canary", "burst", "push", "day"] : ["canary", "push", "day"]).join(", ")}]`,
  };
  return body.replace(/__([A-Z]+)__/g, (m, k: string) => values[k] ?? m);
}

// taskbox check's row for the test repo (product review, finding 3): its runner group exists, is
// limited to selected private repos, and lists the test repo alone. As the service account, with
// the box's own App. Root skips it: the key's path is in that account's home, which it controls.
export const TEST_REPO_ROW = "Test repo";
export async function testRepoRow(c: CheckContext): Promise<{ status: "OK" | "FAIL" | "SKIP"; detail: string }> {
  const repo = loadRepoOf(c.cfg);
  if (!repo) return { status: "SKIP", detail: "no test repo, so no load test" };
  if (c.uid !== c.serviceUid) return { status: "SKIP", detail: `run as ${serviceName()} to check` };
  try {
    const log = new Log();
    const pem = readFileSync(c.paths.key, "utf8");
    log.secret(pem);
    const gh = new GitHub(c.sys, c.cfg, pem, log);
    await gh.runnerGroupId(await gh.token("runners"), repo.runnerGroup, repo.name);
    return { status: "OK", detail: `${repo.name}, in runner group ${repo.runnerGroup}, which lists it alone` };
  } catch (e) {
    return { status: "FAIL", detail: `${(e as Error).message.replace(/[^\x20-\x7e]/g, "").slice(0, 160)}` };
  }
}

export async function loadCommand(d: OpsDeps, cfg: Config, rest: string[], json: boolean): Promise<number> {
  const asService = d.uid === d.serviceUid;
  // The subcommand: the first word that is neither an option nor an option's value.
  const sub = rest.find((a, i) => !a.startsWith("--") && !["--for", "--session"].includes(rest[i - 1] ?? "")) ?? "status";
  const repo = loadRepoOf(cfg);
  // The service account reads its own files; anyone else, the copies in the folder every user may read.
  const shared = !asService;
  const now = d.sys.now();
  if (!repo) {
    d.say("taskbox.json names no test repo, so there is no load test.");
    return 1;
  }
  if (!["status", "on", "off", "report", "workflow"].includes(sub)) {
    d.say("taskbox load takes on, on --only, off, report or workflow.");
    return 1;
  }
  if (sub === "workflow") {
    d.say(loadWorkflowYaml(cfg).trimEnd());
    return 0;
  }
  if (sub === "on" || sub === "off") {
    if (!asService) {
      d.say(`Type taskbox load ${sub === "on" ? "start" : "stop"} as ${serviceName()}, at the box.`);
      return 1;
    }
    if (sub === "off") {
      const s = loadOff(d.paths, now);
      if (!s) {
        d.say("No load test session is on.");
        return 0;
      }
      d.say(`Load test session ${s.n} is off. Running load jobs finish, within 20 minutes; no new load VM starts.`);
      const seen = readLoad(d.paths).seen;
      const left = seen && now - seen.at <= FRESH_MS ? seen.load : 0;
      if (left) d.say(`${left} test repo job${left > 1 ? "s are" : " is"} still queued on GitHub. The box's App can only read, so cancel them in the test repo's Actions tab.`);
      d.say(`taskbox load report shows session ${s.n}.`);
      return 0;
    }
    const only = rest.includes("--only");
    const i = rest.indexOf("--for");
    const forMs = i >= 0 ? parseFor(rest[i + 1] ?? "") : undefined;
    if (i >= 0 && (forMs === undefined || forMs < LOAD_MIN_MS)) {
      d.say("taskbox load start --for takes hours and minutes, such as 2h or 90m: at least 10m, at most 4h.");
      return 1;
    }
    const slots = Number.isInteger(cfg.vmsAtOnce) ? cfg.vmsAtOnce! : 1;
    if (!only && slots < 2) {
      d.say("With one VM at a time, the load test can't run beside the real repo: it never takes the real repo's last slot. Type taskbox load start --only to give it the box for a while.");
      return 1;
    }
    const f = readLoad(d.paths);
    const cur = currentSession(f, now);
    if (cur) {
      d.say(`Load test session ${cur.n} is on already, until ${hhmm(cur.until)} UTC. Type taskbox load stop first.`);
      return 1;
    }
    const blind = loadBlind(f, now);
    if (only) {
      const seen = f.seen;
      const fresh = !!seen?.known && now - seen.at <= FRESH_MS;
      // Ask whenever real jobs wait, and whenever the box can't say (both reviews).
      if (fresh && seen!.real > 0) d.say(`${seen!.real} real job${seen!.real > 1 ? "s wait" : " waits"} on GitHub now${seen!.realMerge ? `, ${seen!.realMerge} of them merge queue jobs` : ""}. With --only they wait until the session ends.`);
      if (!fresh) d.say(`The box can't say whether real jobs wait: ${blind ?? "it can't see the queue now"}. With --only they wait until the session ends.`);
      if (!fresh || seen!.real > 0) {
        d.say("A merge queue drops a pull request whose checks wait past its timeout, 60 minutes unless you changed it. An alert that the real repo's jobs wait is expected while the session is on.");
        const a = (await d.ask("Type yes to give the test repo the box anyway: ")).trim().toLowerCase();
        if (a !== "yes") {
          d.say("Not started. The real repo carries on.");
          return 1;
        }
      }
    }
    // v2.5.0's checklist first, as taskbox check --away runs it.
    const checklist = await checklistNotMet({ sys: d.sys, cfg, paths: d.paths, uid: d.uid, serviceUid: d.serviceUid });
    const s = loadOn(d.paths, now, { ...(forMs !== undefined ? { forMs } : {}), only, checklist });
    if (typeof s === "string") {
      d.say(`A load test session is on already: ${s}.`);
      return 1;
    }
    d.say(`Load test session ${s.n} is on until ${hhmm(s.until)} UTC, ${only ? "with the box to itself: the real repo's jobs wait on GitHub" : "beside the real repo, never taking its last slot"}.`);
    if (blind) d.say(`Test jobs run only while the box can see the queue, and now ${blind}. taskbox load says when that changes.`);
    if (checklist.length) d.say(`taskbox check --away has ${checklist.length} thing${checklist.length > 1 ? "s" : ""} not met: ${checklist.join(", ")}. The session runs; the report names them, so a slow result there isn't read as the scheduler's. taskbox check --away has each fix.`);
    if ((forMs ?? LOAD_MAX_MS) > LOAD_MAX_MS) d.say("It ends by itself after 4 hours, the most a session runs.");
    d.say("Now start the test repo's load workflow on GitHub: Actions, load, Run workflow.");
    return 0;
  }
  if (sub === "report") {
    const jobs = readJobs(d.paths, d.serviceUid);
    if (jobs === undefined) {
      d.say(json ? JSON.stringify({ answers: 3, kind: "error", error: "jobs-unreadable" }) : `${d.paths.jobsFile} isn't taskbox's, so the report can't be read. Nothing to do: agents fix it.`);
      return 1;
    }
    const st = readStateJson<{ gaveWayLog?: unknown; kindChoice?: unknown }>(d.paths.loopState) ?? {};
    const log = (Array.isArray(st.gaveWayLog) ? st.gaveWayLog : [])
      .filter((x): x is { at: number; role?: unknown } => !!x && typeof x === "object" && Number.isFinite((x as { at?: unknown }).at))
      .map((x) => ({ at: x.at, ...(x.role === "load" ? { role: "load" as const } : {}) }));
    const j = rest.indexOf("--session");
    const n = j >= 0 ? Number(rest[j + 1]) : undefined;
    if (n !== undefined && !Number.isInteger(n)) {
      d.say("taskbox load report --session takes a session's number.");
      return 1;
    }
    const r = loadReport(cfg, jobs, readLoad(d.paths, shared), log, now, st.kindChoice === "source", n);
    if (typeof r === "string") {
      d.say(json ? JSON.stringify({ answers: 3, kind: "error", error: "no-session" }) : `${r}.`);
      return 1;
    }
    d.say(json ? JSON.stringify(loadReportAnswer(r)) : loadReportLines(r).join("\n"));
    return 0;
  }
  // taskbox load status: the session now.
  const f = readLoad(d.paths, shared);
  const s = currentSession(f, now);
  const last = f.sessions.at(-1);
  d.say(s ? `Load test session ${s.n} is on until ${hhmm(s.until)} UTC, ${s.only ? "with the box to itself" : "beside the real repo"}.` : `No load test session is on.${last ? ` The last was session ${last.n}: taskbox load report.` : ""}`);
  const blind = s ? loadBlind(f, now) : undefined;
  if (blind) d.say(`Test jobs wait: ${blind}.`);
  if (!s && last?.why) d.say(`The box ended session ${last.n} at ${hhmm(last.endedAt ?? last.until)} UTC: ${last.why}`);
  if (f.seen?.known && f.seen.load && !s && now - f.seen.at <= FRESH_MS) d.say(`${f.seen.load} test repo job${f.seen.load > 1 ? "s are" : " is"} queued on GitHub with no session on: no VM starts for them.`);
  return 0;
}
