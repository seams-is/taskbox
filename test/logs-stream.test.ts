// taskbox logs with the spec's flags, and the streams: logs -f and status -w with --json print one
// envelope a change, then the final one after Ctrl-C.
import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type CliDeps, main } from "../src/cli.ts";
import { paths } from "../src/config.ts";
import { FakeSys } from "./fake.ts";
import { fakeLaunchd, quietBox, tempRoot, testBox } from "./helpers.ts";

const CI = 502;

function box() {
  const root = tempRoot();
  const p = paths(root, testBox());
  mkdirSync(p.app, { recursive: true });
  writeFileSync(join(p.app, "taskbox.json"), readFileSync(join(import.meta.dir, "../taskbox.example.json"), "utf8"));
  writeFileSync(p.installed, JSON.stringify({ commit: "c0ffee0c0ffee0c0ffee0c0ffee0c0ffee0c0ff", tag: "v3.0.0", files: {} }));
  mkdirSync(dirname(p.log), { recursive: true });
  mkdirSync(dirname(p.guardLog), { recursive: true });
  return { root, p };
}

// As the service account. after(n): called at each of the command's sleeps.
async function run(root: string, argv: string[], after?: (n: number, sys: FakeSys) => void) {
  const sys = new FakeSys();
  quietBox(sys);
  fakeLaunchd(sys);
  sys.fallbacks.push((cmd) => (cmd === "/usr/sbin/dseditgroup" ? { code: 67, stdout: "", stderr: "" } : undefined));
  if (after) {
    const real = sys.sleep.bind(sys);
    let n = 0;
    sys.sleep = async (ms, signal) => {
      after(n++, sys);
      return real(ms, signal);
    };
  }
  const said: string[] = [];
  const deps: CliDeps = { sys: () => sys, uid: CI, serviceUid: async () => CI, env: { HOME: "/Users/ci" }, tty: () => 0, user: () => "ci", ask: async () => "", say: (l) => said.push(l), root, chown: () => {} };
  return { code: await main(argv, deps), said, sys };
}

const at = (sys: FakeSys, back: number) => new Date(sys.now() - back).toISOString();

describe("taskbox logs", () => {
  test("--since, --until, -n and --grep pick the lines; --from guard reads the guard's log", async () => {
    const b = box();
    const s = new FakeSys();
    writeFileSync(b.p.log, [`${at(s, 5 * 3600_000)} job j1 done`, `${at(s, 3 * 3600_000)} pulling macos-a`, `${at(s, 2 * 3600_000)} job j2 done`, `${at(s, 60_000)} job j3 done`, ""].join("\n"));
    writeFileSync(b.p.guardLog, `${at(s, 60_000)} the guard put the rules back\n`);
    const lines = (r: { said: string[] }) => r.said.filter((l) => /^\d\d:\d\d {2}/.test(l)).map((l) => l.slice(7));
    expect(lines(await run(b.root, ["logs"]))).toEqual(["A job ran and finished.", "Started downloading macos-a.", "A job ran and finished.", "A job ran and finished."]);
    expect(lines(await run(b.root, ["logs", "--since", "4h", "--until", "90m"]))).toEqual(["Started downloading macos-a.", "A job ran and finished."]);
    expect(lines(await run(b.root, ["logs", "-n", "1"]))).toEqual(["A job ran and finished."]);
    expect(lines(await run(b.root, ["logs", "--grep", "DOWNLOADING"]))).toEqual(["Started downloading macos-a."]);
    expect(lines(await run(b.root, ["logs", "--from", "guard"]))).toEqual(["the guard put the rules back"]);
    expect((await run(b.root, ["logs", "--from", "keys"])).said[0]).toContain("keeps no log file");
    const j = JSON.parse((await run(b.root, ["logs", "--json", "-n", "2"])).said[0]!);
    expect(j.result.lines.map((l: { text: string }) => l.text)).toEqual(["A job ran and finished.", "A job ran and finished."]);
  });

  test("-f follows new lines until Ctrl-C; with --json each comes as its own envelope, then the final one", async () => {
    const b = box();
    writeFileSync(b.p.log, "");
    const step = (n: number, sys: FakeSys) => {
      if (n === 1) appendFileSync(b.p.log, `${new Date(sys.now()).toISOString()} job j9 done\n`);
      if (n === 3) process.emit("SIGINT");
    };
    const t = await run(b.root, ["logs", "-f"], step);
    expect(t.code).toBe(0);
    expect(t.said.some((l) => l.endsWith("A job ran and finished."))).toBe(true);
    expect(t.said).toContain("Stopped following. taskbox logs -f follows again.");
    writeFileSync(b.p.log, "");
    const j = await run(b.root, ["logs", "-f", "--json"], step);
    const env = j.said.map((l) => JSON.parse(l));
    expect(env.map((e) => e.final)).toEqual([false, true]);
    expect(env[0].result.lines.map((l: { text: string }) => l.text)).toEqual(["A job ran and finished."]);
  });
});

describe("taskbox status -w --json", () => {
  test("streams one envelope each time the box changes, then the final one after Ctrl-C", async () => {
    const b = box();
    const r = await run(b.root, ["status", "-w", "--json"], (n, sys) => {
      if (n === 1) writeFileSync(b.p.installed, JSON.stringify({ commit: "beef000beef000beef000beef000beef000beef0", tag: "v3.0.1", files: {}, at: sys.now() }));
      if (n === 3) process.emit("SIGINT");
    });
    expect(r.code).toBe(0);
    const env = r.said.map((l) => JSON.parse(l));
    expect(env.map((e) => e.final)).toEqual([false, false, true]);
    expect(env.every((e) => e.command === "status" && e.answers === 4)).toBe(true);
    expect(JSON.stringify(env[0].result)).not.toEqual(JSON.stringify(env[1].result));
  });
});
