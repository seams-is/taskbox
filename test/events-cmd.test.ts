// taskbox events, through main on the fake box: both writers merged by id, filtered, as text or JSON.
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type CliDeps, main } from "../src/cli.ts";
import { paths } from "../src/config.ts";
import { eventLog } from "../src/core/events.ts";
import { loopState, rootStateOf } from "../src/core/paths.ts";
import { FakeSys } from "./fake.ts";
import { fakeLaunchd, quietBox, tempRoot, testBox } from "./helpers.ts";

const ME = process.getuid!();
const OP = "op_01JD8Q4ABCDEFGHJKMNPQRSTVW";

function box() {
  const sys = new FakeSys();
  quietBox(sys);
  fakeLaunchd(sys);
  const root = tempRoot();
  const p = paths(root, testBox());
  mkdirSync(p.app, { recursive: true });
  writeFileSync(join(p.app, "taskbox.json"), readFileSync(join(import.meta.dir, "../taskbox.example.json"), "utf8"));
  writeFileSync(join(p.app, "versions.json"), readFileSync(join(import.meta.dir, "../versions.json"), "utf8"));
  mkdirSync(dirname(p.jobsFile), { recursive: true, mode: 0o700 });
  mkdirSync(dirname(p.installId), { recursive: true });
  const guard = eventLog("guard", { dir: rootStateOf(p).events, owner: ME }, sys);
  const loop = eventLog("loop", { dir: loopState(p.state).events, owner: ME }, sys);
  return { sys, root, p, guard, loop };
}

async function run(b: ReturnType<typeof box>, argv: string[]) {
  const said: string[] = [];
  const deps: CliDeps = {
    sys: () => b.sys,
    uid: ME,
    serviceUid: async () => ME,
    env: { HOME: "/Users/ci" },
    tty: () => 0,
    user: () => "ci",
    ask: async () => "",
    say: (l) => said.push(l),
    err: () => {},
    terminal: () => true,
    hostname: () => "taskbox-1.local",
    root: b.root,
    rootUid: ME,
    chown: () => {},
  };
  const code = await main(argv, deps);
  return { code, said };
}

describe("taskbox events", () => {
  test("merges the guard's and the loop's events in time order, as sentences", async () => {
    const b = box();
    b.guard.write({ type: "drain.started", op: OP, subject: "box", actor: "service", text: "The service account started a drain." });
    b.sys.clock += 1000;
    b.loop.write({ type: "job.started", subject: "job-1", actor: "taskbox", text: "Job 1 started." });
    b.sys.clock += 1000;
    b.guard.write({ type: "op.succeeded", op: OP, subject: "box", actor: "taskbox", text: "The drain ended." });
    const r = await run(b, ["events"]);
    expect(r.code).toBe(0);
    const body = r.said.filter((l) => /^\d{4}-/.test(l));
    expect(body).toHaveLength(3);
    expect(body[0]).toContain("The service account started a drain.  (drain.started, service, " + OP + ")");
    expect(body[1]).toContain("Job 1 started.");
    expect(body[2]).toContain("The drain ended.");
    expect(r.said).toContain("Did: Read 3 events.");
  });

  test("--op, --type and --subject narrow it; --json gives the events in the envelope", async () => {
    const b = box();
    b.guard.write({ type: "drain.started", op: OP, subject: "box", actor: "service", text: "Drain." });
    b.loop.write({ type: "job.started", subject: "job-1", actor: "taskbox", text: "Job 1 started." });
    b.loop.write({ type: "job.finished", subject: "job-2", actor: "taskbox", text: "Job 2 ended." });
    expect((await run(b, ["events", "--op", OP])).said.filter((l) => /^\d{4}-/.test(l))).toHaveLength(1);
    expect((await run(b, ["events", "--type", "job"])).said.filter((l) => /^\d{4}-/.test(l))).toHaveLength(2);
    const one = await run(b, ["events", "--subject", "job-2", "--json"]);
    const e = JSON.parse(one.said.at(-1)!);
    expect(e.command).toBe("events");
    expect(e.result.events.map((x: { text: string }) => x.text)).toEqual(["Job 2 ended."]);
  });

  test("--since leaves out what is older; a bad flag is usage", async () => {
    const b = box();
    b.guard.write({ type: "drain.started", subject: "box", actor: "service", text: "Old." });
    b.sys.clock += 3 * 3600_000;
    b.guard.write({ type: "pause.started", subject: "box", actor: "service", text: "New." });
    const r = await run(b, ["events", "--since", "1h"]);
    expect(r.said.filter((l) => /^\d{4}-/.test(l)).map((l) => l.includes("New."))).toEqual([true]);
    expect((await run(b, ["events", "--op", "nope"])).code).toBe(2);
    expect((await run(b, ["events", "-w"])).code).toBe(2);
  });

  test("-f --json streams each new event as its own envelope line", async () => {
    const b = box();
    b.guard.write({ type: "drain.started", subject: "box", actor: "service", text: "First." });
    // Two follow rounds, then a later event, then the --until ends it.
    const until = new Date(b.sys.clock + 5_000).toISOString();
    // The second event comes while the command sleeps between reads.
    const sleep = b.sys.sleep.bind(b.sys);
    let n = 0;
    b.sys.sleep = async (ms: number, signal?: AbortSignal) => {
      if (n++ === 0) b.loop.write({ type: "job.started", subject: "job-1", actor: "taskbox", text: "Second." });
      return sleep(ms, signal);
    };
    const r = await run(b, ["events", "-f", "--json", "--until", until]);
    const lines = r.said.map((l) => JSON.parse(l));
    expect(lines[0].final).toBe(false);
    expect(lines[0].lines[0]).toContain("First.");
    expect(lines.some((x) => x.final === false && x.lines.some((l: string) => l.includes("Second.")))).toBe(true);
    expect(lines.at(-1).final).toBe(true);
  });
});
