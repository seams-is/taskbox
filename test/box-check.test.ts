// The hourly box check's rules, run as GitHub runs them: the template's own bash script and jq, with
// a stand-in gh that answers from fixtures. Each hold the laptop may leave in the variable (hold.ts)
// against jobs waiting, a request waiting, and GitHub's API out of reach.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config.ts";
import { isoSecond } from "../src/hold.ts";
import { loadWorkflowYaml } from "../src/loadcmd.ts";
import { canaryYaml, TEMPLATES, watchdogYaml } from "../src/watchdog.ts";
import { CFG } from "./helpers.ts";

const BOX = "taskbox-1";
const yaml = watchdogYaml(CFG as Config, BOX);

// The env block and the run script of the job's one run step, read from the filled YAML.
function parts(y: string): { env: Record<string, string>; script: string } {
  const lines = y.split("\n");
  const env: Record<string, string> = {};
  const start = lines.indexOf("    env:");
  for (let i = start + 1; i < lines.length && /^ {6}\S|^ {6}#|^ {8}/.test(lines[i]!); i++) {
    const m = /^ {6}([A-Z_]+): (.*)$/.exec(lines[i]!);
    if (!m) continue;
    if (m[2] === "|") {
      const body: string[] = [];
      while (i + 1 < lines.length && /^ {8}/.test(lines[i + 1]!)) body.push(lines[++i]!.slice(8));
      env[m[1]!] = body.join("\n") + "\n";
    } else env[m[1]!] = m[2]!.replace(/^"(.*)"$/, "$1");
  }
  const at = lines.findIndex((l) => l === "        run: |");
  const script: string[] = [];
  for (let i = at + 1; i < lines.length && (lines[i] === "" || /^ {10}/.test(lines[i]!)); i++) script.push(lines[i]!.slice(10));
  return { env, script: script.join("\n") };
}

const H = 3_600_000;
const M = 60_000;
interface Run {
  hold?: unknown;
  queuedMinutes?: number; // a job for the box queued this long ago
  running?: boolean;
  apiDown?: boolean;
  count?: string; // what the cache restored
}

function run(r: Run): { code: number; out: string; count: string } {
  const dir = mkdtempSync(join(tmpdir(), "box-check-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const now = Date.now();
  const jobs = [
    ...(r.queuedMinutes !== undefined ? [{ name: "app/test", status: "queued", labels: [CFG.label], created_at: isoSecond(now - r.queuedMinutes * M) }] : []),
    ...(r.running ? [{ name: "app/build", status: "in_progress", labels: [CFG.label], created_at: isoSecond(now - 5 * M) }] : []),
    { name: "elsewhere", status: "queued", labels: ["ubuntu-latest"], created_at: isoSecond(now - 300 * M) },
  ];
  writeFileSync(join(dir, "fixture-jobs.json"), JSON.stringify({ jobs }));
  // gh api: the runs list (one queued run), then that run's jobs; or no answer at all.
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/bash\n${r.apiDown ? "exit 1\n" : ""}case "$*" in\n  *status=queued*) echo 101 ;;\n  *status=in_progress*) ;;\n  *runs/101/jobs*) cat "${join(dir, "fixture-jobs.json")}" ;;\n  *) exit 1 ;;\nesac\n`,
  );
  chmodSync(join(bin, "gh"), 0o755);
  const { env, script } = parts(yaml);
  if (r.count !== undefined) {
    mkdirSync(join(dir, ".taskbox-box-check"));
    writeFileSync(join(dir, ".taskbox-box-check/unreached"), r.count);
  }
  const p = Bun.spawnSync(["/bin/bash", "-c", script], {
    cwd: dir,
    env: { ...env, HOLD: r.hold === undefined ? "" : typeof r.hold === "string" ? r.hold : JSON.stringify(r.hold), TEST_ALERT: "false", GH_TOKEN: "unused", REPO: "example-org/app", RUNNER_TEMP: dir, PATH: `${bin}:/usr/bin:/bin` },
  });
  const countFile = join(dir, ".taskbox-box-check/unreached");
  return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString(), count: existsSync(countFile) ? readFileSync(countFile, "utf8").trim() : "" };
}

const hold = (o: { since?: number; at?: number; until?: number; waitingSince?: number | null; waitingUntil?: number | null; why?: string } = {}) => {
  const now = Date.now();
  const at = o.at ?? now - 10 * M;
  return {
    until: isoSecond(o.until ?? at + 12 * H),
    since: isoSecond(o.since ?? now - 2 * H),
    why: o.why ?? "workspace agent-a-3 (Whole)",
    waitingSince: o.waitingSince ? isoSecond(o.waitingSince) : null,
    waitingUntil: o.waitingUntil ? isoSecond(o.waitingUntil) : null,
    at: isoSecond(at),
  };
};

const jq = existsSync("/usr/bin/jq");
describe("the hourly box check's rules", () => {
  test.skipIf(!jq)("jobs waiting with no hold: it fails, and says the box isn't taking them", () => {
    const r = run({ queuedMinutes: 90 });
    expect(r.code).toBe(1);
    expect(r.out).toContain("Jobs are waiting and taskbox-1 isn't taking them");
    expect(r.out).toContain("app/test has waited 90 min");
    expect(r.out).not.toContain("elsewhere");
    expect(r.count).toBe("0");
  });

  test.skipIf(!jq)("jobs waiting while a job runs: busy, not dead", () => {
    expect(run({ queuedMinutes: 90, running: true }).code).toBe(0);
  });

  test.skipIf(!jq)("a current hold: jobs waiting don't alarm", () => {
    const r = run({ queuedMinutes: 90, hold: hold() });
    expect(r.code).toBe(0);
    expect(r.out).toContain("taskbox-1 is held (workspace agent-a-3 (Whole))");
    expect(r.out).toContain("and it is held");
  });

  test.skipIf(!jq)("an ended hold is none: jobs waiting alarm", () => {
    const now = Date.now();
    const r = run({ queuedMinutes: 90, hold: hold({ at: now - 13 * H, until: now - H, since: now - 14 * H }) });
    expect(r.code).toBe(1);
    expect(r.out).toContain("isn't taking them");
  });

  test.skipIf(!jq)("a hold further ahead than its lease is ignored as if absent", () => {
    const now = Date.now();
    const r = run({ queuedMinutes: 90, hold: hold({ at: now, until: now + 13 * H }) });
    expect(r.code).toBe(1);
    expect(r.out).toContain("runs further ahead than 12 hours, so it counts as none");
    expect(r.out).toContain("isn't taking them");
  });

  test.skipIf(!jq)("a hold standing past holdAlarmHours fails while it is current", () => {
    const now = Date.now();
    const r = run({ hold: hold({ since: now - 25 * H }) });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/taskbox-1 has been held since \d\d:\d\d UTC on .* \(workspace agent-a-3 \(Whole\)\), over 24 hours/);
  });

  test.skipIf(!jq)("a request waiting past requestAlertMinutes fails; one under it, or one no longer renewed, doesn't", () => {
    const now = Date.now();
    const r = run({ hold: hold({ waitingSince: now - 70 * M, waitingUntil: now + 50 * M }) });
    expect(r.code).toBe(1);
    expect(r.out).toContain("A workspace request on taskbox-1 has waited 70 minutes");
    expect(run({ hold: hold({ waitingSince: now - 20 * M, waitingUntil: now + 50 * M }) }).code).toBe(0);
    expect(run({ hold: hold({ waitingSince: now - 70 * M, waitingUntil: now - M }) }).code).toBe(0);
  });

  test.skipIf(!jq)("a variable out of shape is no hold", () => {
    for (const h of ["not json", '{"until":"tomorrow"}', "[1]", '{"until":"2030-01-01T00:00:00Z"}']) {
      const r = run({ queuedMinutes: 90, hold: h });
      expect(r.code).toBe(1);
      expect(r.out).toContain("isn't taking them");
    }
  });

  test.skipIf(!jq)("GitHub's API out of reach: a warning, until the third run in a row fails; a run that reads it starts the count again", () => {
    const one = run({ apiDown: true });
    expect(one.code).toBe(0);
    expect(one.out).toContain("::warning::GitHub's API didn't answer");
    expect(one.count).toBe("1");
    expect(run({ apiDown: true, count: "1" })).toMatchObject({ code: 0, count: "2" });
    const third = run({ apiDown: true, count: "2" });
    expect(third.code).toBe(1);
    expect(third.out).toContain("The hourly box check couldn't reach the box for 3 hours");
    expect(run({ count: "2" })).toMatchObject({ code: 0, count: "0" });
    // A count the cache gave back out of shape counts from none.
    expect(run({ apiDown: true, count: "x; rm -rf /" })).toMatchObject({ code: 0, count: "1" });
  });
});

describe("every template", () => {
  // Each run: block's lines, from its run: line to the next line indented no more than it.
  function runBlocks(y: string): string[] {
    const out: string[] = [];
    const lines = y.split("\n");
    lines.forEach((l, i) => {
      const m = /^(\s*)(?:- )?run: ?(.*)$/.exec(l);
      if (!m) return;
      const indent = m[1]!.length;
      const block = [m[2]!];
      for (let j = i + 1; j < lines.length; j++) {
        const n = lines[j]!;
        if (n.trim() && n.length - n.trimStart().length <= indent) break;
        block.push(n);
      }
      out.push(block.join("\n"));
    });
    return out;
  }
  const filled = [watchdogYaml(CFG as Config, BOX), canaryYaml(CFG as Config), loadWorkflowYaml(CFG as Config)];
  const raw = ["taskbox-watchdog.yml", "taskbox-canary.yml", "taskbox-load.yml"].map((f) => readFileSync(join(TEMPLATES, f), "utf8"));

  test("no value reaches a run: step through ${{ }}, and no template names a secret", () => {
    for (const y of [...filled, ...raw]) {
      const blocks = runBlocks(y);
      expect(blocks.length).toBeGreaterThan(0);
      for (const b of blocks) expect(b).not.toContain("${{");
      expect(y).not.toMatch(/secrets\./);
    }
  });

  test("the test catches one that does", () => {
    expect(runBlocks("    steps:\n      - run: echo ${{ github.event.issue.title }}\n")[0]).toContain("${{");
    expect(runBlocks("      - name: x\n        run: |\n          echo hi\n          echo ${{ vars.X }}\n      - name: y\n")[0]).toContain("${{");
  });

  test("every action is pinned by its commit", () => {
    for (const y of filled) for (const m of y.matchAll(/uses: (\S+)/g)) expect(m[1]).toMatch(/@[0-9a-f]{40}$/);
  });
});
