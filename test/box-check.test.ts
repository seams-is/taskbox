// The hourly box check's rules, run as GitHub runs them: the template's own bash script and jq, with
// a stand-in gh that answers from fixtures. Every hold the variable may carry, against jobs waiting,
// a request waiting and GitHub's API out of reach; and two boxes sharing one jobs repo.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config.ts";
import { isoSecond } from "../src/hold.ts";
import { loadWorkflowYaml } from "../src/loadcmd.ts";
import { boxCheckFile, boxCheckYaml, TEMPLATES, templateFiles, testJobFile, testJobYaml, valuesOf } from "../src/watchdog.ts";
import { CFG } from "./helpers.ts";

const values = valuesOf(CFG as Config);
const yaml = boxCheckYaml(values);

// jq as GitHub's runner has it: on PATH. A Mac with none skips here, and CI, which must run them, fails.
const JQ = ["/usr/bin/jq", "/opt/homebrew/bin/jq", "/usr/local/bin/jq"].find((p) => existsSync(p));
const BASH = ["/opt/homebrew/bin/bash", "/usr/local/bin/bash", "/bin/bash"].find((p) => existsSync(p))!;
test.serial("CI has jq, so the rules below run there", () => {
  if (process.env.GITHUB_ACTIONS) expect(JQ).toBeDefined();
});

// The env block and the run script of the job's one run step, read from the filled YAML.
function parts(y: string): { env: Record<string, string>; script: string; lines: string[] } {
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
  return { env, script: script.join("\n"), lines };
}

const H = 3_600_000;
const M = 60_000;
interface Run {
  y?: string;
  hold?: unknown;
  queuedMinutes?: number;
  jobName?: string;
  apiDown?: boolean;
  jobsDown?: boolean; // the run list answers, a run's jobs don't
  count?: string;
  jobs?: { name: string; status: string; labels: string[]; minutes: number }[]; // instead of the one queued job
  files?: Record<string, string>; // the jobs repo's workflow files, by name
}

function run(r: Run): { code: number; out: string; count: string } {
  const dir = mkdtempSync(join(tmpdir(), "box-check-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const now = Date.now();
  const jobs = r.jobs ? r.jobs.map((j) => ({ name: j.name, status: j.status, labels: j.labels, created_at: isoSecond(now - j.minutes * M) })) : [...(r.queuedMinutes !== undefined ? [{ name: r.jobName ?? "app/test", status: "queued", labels: [CFG.label], created_at: isoSecond(now - r.queuedMinutes * M) }] : []), { name: "elsewhere", status: "queued", labels: ["ubuntu-latest"], created_at: isoSecond(now - 300 * M) }];
  writeFileSync(join(dir, "fixture-jobs.json"), JSON.stringify({ jobs }));
  mkdirSync(join(dir, "files"));
  for (const [n, t] of Object.entries(r.files ?? {})) writeFileSync(join(dir, "files", n), t);
  writeFileSync(join(dir, "names"), Object.keys(r.files ?? {}).join("\n") + "\n");
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/sh\n${r.apiDown ? "exit 1\n" : ""}case "$*" in\n  *status=queued*) echo 101 ;;\n  *status=in_progress*) ;;\n  *runs/101/jobs*) ${r.jobsDown ? "exit 1" : `cat "${join(dir, "fixture-jobs.json")}"`} ;;\n  *"contents/.github/workflows --jq"*) cat "${join(dir, "names")}" ;;\n  *contents/.github/workflows/*) cat "${join(dir, "files")}/$(basename "$4")" ;;\n  *) exit 1 ;;\nesac\n`,
  );
  chmodSync(join(bin, "gh"), 0o755);
  if (JQ) writeFileSync(join(bin, "jq"), `#!/bin/sh\nexec ${JQ} "$@"\n`), chmodSync(join(bin, "jq"), 0o755);
  const { env, script } = parts(r.y ?? yaml);
  if (r.count !== undefined) {
    mkdirSync(join(dir, env.COUNT_DIR!));
    writeFileSync(join(dir, env.COUNT_DIR!, "unreached"), r.count);
  }
  const p = Bun.spawnSync([BASH, "-c", script], { cwd: dir, env: { ...env, HOLD: r.hold === undefined ? "" : typeof r.hold === "string" ? r.hold : JSON.stringify(r.hold), TEST_ALERT: "false", GH_TOKEN: "unused", REPO: "example-org/app", RUNNER_TEMP: dir, PATH: `${bin}:/usr/bin:/bin` } });
  const countFile = join(dir, env.COUNT_DIR!, "unreached");
  return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString(), count: existsSync(countFile) ? readFileSync(countFile, "utf8").trim() : "" };
}

const hold = (o: { box?: string; since?: number; at?: number; until?: number; waitingSince?: number; waitingUntil?: number } = {}) => {
  const now = Date.now();
  const at = o.at ?? now - 10 * M;
  return { box: o.box ?? "taskbox-1", until: isoSecond(o.until ?? at + 12 * H), since: isoSecond(o.since ?? now - 2 * H), why: "workspace agent-a-3 (Whole)", waitingSince: o.waitingSince ? isoSecond(o.waitingSince) : null, waitingUntil: o.waitingUntil ? isoSecond(o.waitingUntil) : null, at: isoSecond(at) };
};

// Each run starts bash and jq a few times: the rule tests run one at a time, with room.
const SLOW = 60_000;
describe.skipIf(!JQ)("the hourly box check's rules", () => {
  test.serial("jobs waiting with no hold: it fails, and says the box isn't taking them", () => {
    const r = run({ queuedMinutes: 90 });
    expect(r.code).toBe(1);
    expect(r.out).toContain("Jobs are waiting and taskbox-1 isn't taking them");
    expect(r.out).toContain("\n  - app/test has waited 90 min");
    expect(r.out).not.toContain("elsewhere");
    expect(r.count).toBe("0");
  });

  test.serial("a job asking only for a size's labels is watched too", () => {
    const sized = { ...CFG, linux: { label: "taskbox-linux", image: "ghcr.io/x/y@sha256:" + "1".repeat(64), vmCpus: 4, vmMemoryMB: 8192, sizes: [{ name: "small", labels: ["taskbox-linux-small"], vmCpus: 2, vmMemoryMB: 4096 }] } } as unknown as Config;
    const v = valuesOf(sized);
    expect(v.labels).toContain("taskbox-linux-small");
    const r = run({ y: boxCheckYaml(v), jobs: [{ name: "app/lint", status: "queued", labels: ["taskbox-linux-small"], minutes: 90 }] });
    expect(r.code).toBe(1);
    expect(r.out).toContain("app/lint has waited 90 min for taskbox-linux-small");
  }, SLOW);

  test.serial("a job's name never starts a line, and loses what isn't printable", () => {
    const r = run({ queuedMinutes: 90, jobName: "::error title=x::forged\u0007" });
    expect(r.out).toContain("  - ::error title=x::forged has waited");
    expect(r.out.split("\n").some((l) => l.startsWith("::error"))).toBe(false);
  });

  test.serial("a current hold: jobs waiting don't alarm", () => {
    const r = run({ queuedMinutes: 90, hold: hold() });
    expect(r.code).toBe(0);
    expect(r.out).toContain("taskbox-1 is held (workspace agent-a-3 (Whole))");
  });

  test.serial("a hold nobody ended: jobs waiting alarm, and the email says it ran out", () => {
    const now = Date.now();
    const r = run({ queuedMinutes: 90, hold: hold({ at: now - 13 * H, until: now - H, since: now - 14 * H }) });
    expect(r.code).toBe(1);
    expect(r.out).toContain("The hold ran out while the controller was away");
  });

  test.serial("not a hold, and an alarm by itself: out of shape, another box's, dated ahead, a 2099 lease, past its cap", () => {
    const now = Date.now();
    const bad = [
      "not json",
      '{"until":"tomorrow"}',
      "[1]",
      hold({ box: "example-box" }),
      { ...hold(), box: undefined },
      hold({ at: now + 3 * H }),
      hold({ since: now + H, at: now }),
      { box: "taskbox-1", until: "2099-01-01T12:00:00Z", at: "2099-01-01T00:00:00Z", since: "2099-01-01T00:00:00Z", why: "x" },
      hold({ at: now, until: now + 13 * H }),
    ];
    for (const h of bad) {
      const r = run({ hold: h });
      expect({ h, code: r.code }).toEqual({ h, code: 1 });
      expect(r.out).toContain("isn't one its controller writes");
      expect(run({ hold: h, queuedMinutes: 90 }).out).toContain("isn't taking them");
    }
  }, SLOW);

  test.serial("a hold standing past holdAlarmHours fails while it is current", () => {
    const r = run({ hold: hold({ since: Date.now() - 25 * H }) });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/taskbox-1 has been held since \d\d:\d\d UTC on .* \(workspace agent-a-3 \(Whole\)\), over 24 hours/);
  });

  test.serial("a request waiting past requestAlertMinutes fails; one under it, or one no longer renewed, doesn't", () => {
    const now = Date.now();
    const r = run({ hold: hold({ waitingSince: now - 70 * M, waitingUntil: now + 50 * M }) });
    expect(r.code).toBe(1);
    expect(r.out).toContain("A workspace request on taskbox-1 has waited 70 minutes");
    expect(run({ hold: hold({ waitingSince: now - 20 * M, waitingUntil: now + 50 * M }) }).code).toBe(0);
    expect(run({ hold: hold({ waitingSince: now - 70 * M, waitingUntil: now - M }) }).code).toBe(0);
  }, SLOW);

  test.serial("GitHub's API out of reach, at the start or part-way: a warning, until the third run in a row fails", () => {
    const one = run({ apiDown: true });
    expect([one.code, one.count]).toEqual([0, "1"]);
    expect(one.out).toContain("::warning::GitHub's API didn't answer");
    expect(run({ jobsDown: true, count: "1" })).toMatchObject({ code: 0, count: "2" });
    const third = run({ apiDown: true, count: "2" });
    expect(third.code).toBe(1);
    expect(third.out).toContain("The hourly box check couldn't reach the box for 3 hours");
    expect(run({ count: "2" })).toMatchObject({ code: 0, count: "0" });
    expect(run({ apiDown: true, count: "x; rm -rf /" })).toMatchObject({ code: 0, count: "1" });
  }, SLOW);
});

describe("the count's cache", () => {
  test.serial("the folder the script counts in is the one the cache restores and saves, under one key prefix", () => {
    const { env, lines } = parts(yaml);
    const paths = lines.filter((l) => /^ {10}path: /.test(l)).map((l) => l.trim().slice(6));
    expect(paths).toEqual([env.COUNT_DIR!, env.COUNT_DIR!]);
    const prefix = lines.find((l) => l.includes("restore-keys:"))!.trim().split(" ")[1]!;
    for (const k of lines.filter((l) => /^ {10}key: /.test(l))) expect(k.trim().slice(5).startsWith(prefix)).toBe(true);
  });
});

describe("two boxes on one jobs repo", () => {
  const other = valuesOf({ ...CFG, runnerNamePrefix: "example-box", label: "example-box-macos", labels: ["example-box-macos"], mergeLabel: undefined } as Config);
  test.serial("each has its own files, variable, concurrency group, cache and run name", () => {
    expect(templateFiles(values).map((f) => f.path)).toEqual([boxCheckFile("taskbox-1"), testJobFile("taskbox-1")]);
    expect(templateFiles(other).map((f) => f.path)).toEqual([".github/workflows/taskbox-watchdog-example-box.yml", ".github/workflows/taskbox-canary-example-box.yml"]);
    const b = boxCheckYaml(other);
    for (const s of ["vars.TASKBOX_HOLD_EXAMPLE_BOX", "group: taskbox-box-check-example-box", "COUNT_DIR: .taskbox-box-check-example-box", "run-name: taskbox hourly box check example-box "]) expect(b).toContain(s);
    expect(b).not.toContain("taskbox-1");
    expect(testJobYaml(other)).not.toContain("taskbox-1");
  });

  test.serial.skipIf(!JQ)("one box dead, the other alive on a shared label: the dead box's own test job still alarms", () => {
    // taskbox-1 is dead. example-box runs a real job on the label both name, and taskbox-1's test
    // job, which asks for taskbox-1's own label alone, waits.
    const r = run({
      jobs: [
        { name: "app/build", status: "in_progress", labels: [CFG.label], minutes: 5 },
        { name: "taskbox test job taskbox-1", status: "queued", labels: ["taskbox-1-macos"], minutes: 90 },
      ],
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("Jobs are waiting and taskbox-1 isn't taking them");
    expect(r.out).toContain("taskbox test job taskbox-1 has waited 90 min for taskbox-1-macos");
    expect(testJobYaml(values)).toContain('label: ["taskbox-1-macos"]');
    expect(testJobYaml(other)).toContain('label: ["example-box-macos"]');
  }, SLOW);

  test.serial.skipIf(!JQ)("a check warns when another box's check names one of this box's labels", () => {
    const r = run({ files: { "taskbox-watchdog-taskbox-1.yml": yaml, "taskbox-watchdog-example-box.yml": boxCheckYaml({ ...other, labels: ["example-box-macos", CFG.label.toUpperCase()] }), "deploy.yml": "x" } });
    expect(r.out).toContain(`::warning::taskbox-watchdog-example-box.yml also names ${CFG.label}, so that box can take taskbox-1's jobs for it`);
    expect(r.out.match(/::warning::/g)).toHaveLength(1);
    expect(run({ files: { "taskbox-watchdog-example-box.yml": boxCheckYaml(other) } }).out).not.toContain("::warning::");
  }, SLOW);

  test.serial.skipIf(!JQ)("one box's hold quiets only that box", () => {
    expect(run({ queuedMinutes: 90, hold: hold() }).code).toBe(0);
    // The other box's check reads its own variable; given taskbox-1's lease, it isn't its own.
    const r = run({ y: boxCheckYaml(other), queuedMinutes: 90, hold: hold() });
    expect(r.code).toBe(1);
    expect(r.out).toContain("isn't one its controller writes");
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
  const filled = [yaml, testJobYaml(values), loadWorkflowYaml(CFG as Config)];
  const raw = ["taskbox-watchdog.yml", "taskbox-canary.yml", "taskbox-load.yml"].map((f) => readFileSync(join(TEMPLATES, f), "utf8"));

  test.serial("no value reaches a run: step through ${{ }}, and no template names a secret", () => {
    for (const y of [...filled, ...raw]) {
      const blocks = runBlocks(y);
      expect(blocks.length).toBeGreaterThan(0);
      for (const b of blocks) expect(b).not.toContain("${{");
      expect(y).not.toMatch(/secrets\./);
    }
  });

  test.serial("the test catches one that does", () => {
    expect(runBlocks("    steps:\n      - run: echo ${{ github.event.issue.title }}\n")[0]).toContain("${{");
    expect(runBlocks("      - name: x\n        run: |\n          echo hi\n          echo ${{ vars.X }}\n      - name: y\n")[0]).toContain("${{");
  });

  test.serial("every action is pinned by its commit", () => {
    for (const y of filled) for (const m of y.matchAll(/uses: (\S+)/g)) expect(m[1]).toMatch(/@[0-9a-f]{40}$/);
  });
});
