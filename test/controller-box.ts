// A box for the controller's tests, answered by the box's own code: each line the controller sends goes
// through the agent shell's own check (src/shell.ts commandFor), then the box's own main (src/cli.ts)
// on a fake box, so every envelope the controller reads is one the box itself made. Nothing real runs.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type CliDeps, main } from "../src/cli.ts";
import { paths } from "../src/config.ts";
import { commandFor } from "../src/shell.ts";
import * as answers from "../src/answers.ts";
import { spyOn } from "bun:test";
import { FakeSys } from "./fake.ts";
import { fakeLaunchd, quietBox, tempRoot, testBox } from "./helpers.ts";

// The box's service account is the test's own user, so the state it reads is its own.
const SERVICE = process.getuid!();

// The install ID is root's file, made once and read-only; the test can't make a file root's, so each
// stand-in's ID is read as the box's own code would read it from root's file.
const ids = new Map<string, string>();
let spied = false;
function placeId(path: string, id: string): void {
  ids.set(path, id);
  if (spied) return;
  const real = answers.readInstallId;
  spyOn(answers, "readInstallId").mockImplementation((p: string, rootUid?: number) => ids.get(p) ?? real(p, rootUid));
  spied = true;
}

export class StandIn {
  root: string;
  sys = new FakeSys();
  sent: string[] = [];
  // A line's answer set by hand, in place of the box's own: for a box that breaks the rules.
  over = new Map<string, { stdout: string; code: number }>();
  // Root's uid as the box's code reads root's files: the tester's own, for a test that writes them.
  rootUid: number | undefined;

  constructor(
    readonly installId: string,
    readonly hostname = "taskbox-1",
    tag = "v3.0.0-rc.1",
  ) {
    this.root = tempRoot();
    const p = paths(this.root, testBox());
    mkdirSync(p.app, { recursive: true });
    writeFileSync(join(p.app, "taskbox.json"), readFileSync(join(import.meta.dir, "../taskbox.example.json"), "utf8"));
    writeFileSync(join(p.app, "versions.json"), readFileSync(join(import.meta.dir, "../versions.json"), "utf8"));
    for (const f of [p.jobsFile, p.guardLog, p.guardState, p.installId]) mkdirSync(dirname(f), { recursive: true, mode: 0o700 });
    writeFileSync(p.installed, JSON.stringify({ commit: "c0ffee0c0ffee0c0ffee0c0ffee0c0ffee0c0ff", tag, pr: 2, title: "feat: install the box", mergedAt: "2026-11-12T10:00:00Z", files: {} }));
    writeFileSync(p.installId, `${installId}\n`, { mode: 0o444 });
    placeId(p.installId, installId);
    quietBox(this.sys);
    fakeLaunchd(this.sys);
    this.sys.fallbacks.push(() => ({ code: 1, stdout: "", stderr: "" }));
  }

  // One line, as the agent shell takes it, then the box's main. stdout is what the shell would print.
  async answer(line: string): Promise<{ stdout: string; code: number }> {
    this.sent.push(line);
    const set = this.over.get(line);
    if (set) return set;
    const c = commandFor(line);
    if ("no" in c) return { stdout: `${c.no}\n`, code: 2 };
    const said: string[] = [];
    const deps: CliDeps = {
      sys: () => this.sys,
      uid: SERVICE,
      serviceUid: async () => SERVICE,
      env: { HOME: "/Users/taskbox-agent" },
      tty: () => 0,
      user: () => "taskbox-agent",
      ask: async () => "",
      say: (l) => said.push(l),
      err: () => {},
      terminal: () => false,
      hostname: () => `${this.hostname}.local`,
      root: this.root,
      chown: () => {},
      ...(this.rootUid !== undefined ? { rootUid: this.rootUid } : {}),
    };
    const code = await main(c.args, deps);
    return { stdout: said.length ? `${said.join("\n")}\n` : "", code };
  }
}
