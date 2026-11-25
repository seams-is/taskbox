import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type CliDeps, main } from "../src/cli.ts";
import { paths } from "../src/config.ts";
import { type OpsDeps, remove } from "../src/ops.ts";
import { FakeSys } from "./fake.ts";
import { tempRoot, testBox, quietBox, servicesObey, settingsText } from "./helpers.ts";

// Remove leaves the box's JIT runners for GitHub to drop. Root never reads ci's App key,
// and never deletes another box's runners by a shared name prefix.
function removeDeps() {
  const sys = new FakeSys();
  quietBox(sys);
  servicesObey(sys);
  sys.responders.push((cmd, args) => {
    if (cmd === "/bin/launchctl" && args[0] === "print") return { code: 113, stdout: "", stderr: "" };
    if (cmd === "/usr/bin/du") return { code: 0, stdout: "0\t/x\n", stderr: "" };
    return undefined;
  });
  const p = paths(tempRoot(), testBox());
  const said: string[] = [];
  const d: OpsDeps = { sys, paths: p, uid: 502, serviceUid: 502, say: (l) => said.push(l), ask: async () => "yes" };
  return { d, p, sys, said };
}

describe("taskbox remove and the box's runners", () => {
  test("it asks GitHub nothing, and says GitHub drops the runners", async () => {
    const { d, sys, said } = removeDeps();
    sys.fetch = async () => {
      throw new Error("remove called GitHub");
    };
    expect(await remove(d, { serviceUid: 502 })).toBe(0);
    expect(existsSync(d.paths.opt)).toBe(false);
    expect(said.find((l) => l.startsWith("Did: "))).toContain("left this box's runners for GitHub to drop within a day");
  });

  test("a pipe where ci's key was is never opened", async () => {
    const { d, p } = removeDeps();
    mkdirSync(join(p.key, ".."), { recursive: true });
    Bun.spawnSync(["/usr/bin/mkfifo", p.key]);
    // Opening a pipe with no writer waits for ever, so a read of it would time this test out.
    expect(await remove(d, { serviceUid: 502 })).toBe(0);
  });

  // The command itself, as the owner types it through sudo: with ci's key a pipe, a read of it
  // would wait for ever, and every call to GitHub is recorded.
  test("the command reads no key and makes no GitHub call before it removes", async () => {
    const { d, p, sys, said } = removeDeps();
    mkdirSync(p.app, { recursive: true });
    writeFileSync(join(p.app, "taskbox.json"), settingsText());
    mkdirSync(join(p.key, ".."), { recursive: true });
    Bun.spawnSync(["/usr/bin/mkfifo", p.key]);
    const fetched: string[] = [];
    sys.fetch = async (url) => (fetched.push(url), new Response("{}", { status: 500 }));
    // Typed at the box: taskbox's parents are a shell in Terminal, then launchd.
    sys.responders.push((cmd, args) => (cmd === "/bin/ps" && args[1] === "ppid=,comm=" ? { code: 0, stdout: args[3] === String(process.pid) ? "700 -zsh\n" : "1 /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal\n", stderr: "" } : undefined));
    const deps: CliDeps = {
      sys: () => sys,
      uid: 0,
      serviceUid: async () => 502,
      env: { SUDO_USER: "owner", HOME: "/var/root" },
      tty: () => 0,
      user: () => "root",
      ask: async () => "yes",
      say: d.say,
      root: join(p.opt, "../.."),
    };
    expect(await main(["remove"], deps)).toBe(0);
    expect(existsSync(p.opt)).toBe(false);
    expect(fetched).toEqual([]);
    expect(said.find((l) => l.startsWith("Did: "))).toContain("left this box's runners for GitHub to drop within a day");
  });
});
