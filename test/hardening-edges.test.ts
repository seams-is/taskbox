// Edge cases found by an independent tester: an update from the last release, and
// a restart after a stale beat.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beatFor, staleBeat } from "../src/beat.ts";
import { hashTree } from "../src/checks.ts";
import { paths } from "../src/config.ts";
import { settler } from "../src/guard.ts";
import { Log } from "../src/log.ts";
import { runLoop, writeLoopState } from "../src/loop.ts";
import { TART_KIT } from "../src/tart.ts";
import { readLoop } from "../src/watch.ts";
import { FakeSys } from "./fake.ts";
import { CFG, loopDeps, tempRoot, testBox } from "./helpers.ts";

describe("an update from the last release", () => {
  // `taskbox update` runs the installed release's code (install.ts), so the v2.5.x updater lays the
  // new install out with its own TART_KIT: Softnet in bin, no Softnet folder. The new code's paths
  // name softnet/softnet.
  test("the Softnet row on an install the v2.5.x updater laid out answers, rather than erroring", async () => {
    const dir = mkdtempSync(join(tmpdir(), "taskbox-inst-"));
    mkdirSync(join(dir, "bin"), { recursive: true });
    writeFileSync(join(dir, "bin/softnet"), "softnet");
    chmodSync(join(dir, "bin/softnet"), 0o4755);
    const p = { ...paths(dir, testBox()), softnet: join(dir, "softnet/softnet") };
    const softnetRow = TART_KIT.checks[0]![1];
    // An error here is "the check errored" in every pre-start check, so no VM starts on the box.
    await expect(softnetRow({ paths: p })).resolves.toBeDefined();
    expect((await softnetRow({ paths: p })).status).toBe("FAIL");
  });

  // An install as the v2.5.x updater lays it out, with its record.
  function oldLayout(dir: string) {
    mkdirSync(join(dir, "bin"), { recursive: true });
    writeFileSync(join(dir, "bin/bun"), "bun");
    writeFileSync(join(dir, "bin/softnet"), "softnet");
    // Bun's chmodSync can drop the setuid bit (install.ts setSetuid), so chmod sets it.
    Bun.spawnSync(["/bin/chmod", "4755", join(dir, "bin/softnet")]);
    writeFileSync(join(dir, "installed.json"), JSON.stringify({ commit: "c0ffee0", files: hashTree(dir) }));
  }
  // chmod for real, except the ACL calls, which name a service account this Mac may not have: those are recorded only.
  const recorder = (calls: string[], failOn?: string) => async (cmd: string, args: string[]) => {
    calls.push(`${cmd} ${args.join(" ")}`);
    if (args[0] === failOn) throw new Error("chmod failed");
    if (cmd === "/bin/chmod" && args[0] !== "-N" && args[0] !== "+a") expect(Bun.spawnSync([cmd, ...args]).exitCode).toBe(0);
  };

  test("settle moves Softnet to its folder, closed to all but the service, with the record, once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "taskbox-inst-"));
    oldLayout(dir);
    const calls: string[] = [];
    expect(await TART_KIT.settle(dir, "taskbox", recorder(calls))).toBe(true);
    const folder = join(dir, "softnet");
    const from = join(dir, "bin/softnet");
    const to = join(folder, "softnet");
    expect(calls).toEqual([`/bin/chmod 700 ${folder}`, `/bin/chmod -N ${folder}`, `/bin/chmod +a user:taskbox allow list,search ${folder}`, `/bin/chmod 4755 ${to}`, `/bin/chmod u-s ${from}`]);
    expect(existsSync(from)).toBe(false);
    expect(statSync(to).mode & 0o7777).toBe(0o4755);
    // The record matches the tree again, so "Installed files match" holds.
    expect(JSON.parse(readFileSync(join(dir, "installed.json"), "utf8")).files).toEqual(hashTree(dir));
    expect(await TART_KIT.settle(dir, "taskbox", recorder(calls))).toBe(false);
    expect(calls).toHaveLength(5);
  });

  test("a hard link to the old Softnet, made while any account could reach it, is no longer setuid", async () => {
    const dir = mkdtempSync(join(tmpdir(), "taskbox-inst-"));
    oldLayout(dir);
    const link = join(mkdtempSync(join(tmpdir(), "taskbox-other-")), "softnet");
    linkSync(join(dir, "bin/softnet"), link);
    expect(await TART_KIT.settle(dir, "taskbox", recorder([]))).toBe(true);
    expect(statSync(link).mode & 0o4000).toBe(0);
    // A new file, so the link isn't Softnet's, and the Softnet row would see a second link if it were.
    expect(statSync(join(dir, "softnet/softnet")).ino).not.toBe(statSync(link).ino);
    expect(statSync(join(dir, "softnet/softnet")).nlink).toBe(1);
  });

  test("a settle that stops after the copy is finished by the next, which clears the old file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "taskbox-inst-"));
    oldLayout(dir);
    await expect(TART_KIT.settle(dir, "taskbox", recorder([], "u-s"))).rejects.toThrow("chmod failed");
    expect(existsSync(join(dir, "softnet/softnet"))).toBe(true);
    expect(statSync(join(dir, "bin/softnet")).mode & 0o4000).not.toBe(0);
    expect(await TART_KIT.settle(dir, "taskbox", recorder([]))).toBe(true);
    expect(existsSync(join(dir, "bin/softnet"))).toBe(false);
    expect(statSync(join(dir, "softnet/softnet")).mode & 0o7777).toBe(0o4755);
    expect(JSON.parse(readFileSync(join(dir, "installed.json"), "utf8")).files).toEqual(hashTree(dir));
  });

  test("a settle that stops part way is finished by the next", async () => {
    const dir = mkdtempSync(join(tmpdir(), "taskbox-inst-"));
    oldLayout(dir);
    await expect(TART_KIT.settle(dir, "taskbox", recorder([], "+a"))).rejects.toThrow("chmod failed");
    expect(existsSync(join(dir, "bin/softnet"))).toBe(true);
    expect(await TART_KIT.settle(dir, "taskbox", recorder([]))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "installed.json"), "utf8")).files).toEqual(hashTree(dir));
  });

  test("an install in this layout is left as it is", async () => {
    const dir = mkdtempSync(join(tmpdir(), "taskbox-inst-"));
    mkdirSync(join(dir, "softnet"));
    writeFileSync(join(dir, "softnet/softnet"), "softnet");
    const calls: string[] = [];
    expect(await TART_KIT.settle(dir, "taskbox", recorder(calls))).toBe(false);
    expect(calls).toEqual([]);
  });

  // /opt/taskbox linked to an install the old updater laid out, and the guard's settler on it.
  function box() {
    const sys = new FakeSys();
    const me = process.getuid!();
    sys.responders.push((cmd, args) => {
      if (cmd === "/usr/bin/id" && args.join(" ") === "-u taskbox") return { code: 0, stdout: `${me}\n`, stderr: "" };
      if (cmd === "/bin/chmod") return { code: 0, stdout: "", stderr: "" };
      return undefined;
    });
    const p = paths(tempRoot(), testBox());
    rmSync(p.opt, { recursive: true, force: true });
    const inst = join(p.opt, "../taskbox-c0ffee0c0ffe-AAAAAA");
    mkdirSync(inst);
    oldLayout(inst);
    symlinkSync("taskbox-c0ffee0c0ffe-AAAAAA", p.opt);
    const log = new Log(join(inst, "../guard.log"));
    return { sys, p, inst, settle: settler(sys, p, log) };
  }
  const slotIs = (p: ReturnType<typeof paths>, sys: FakeSys, phase: string) => writeLoopState(p, { slotCount: 1, slots: { "1": { beat: beatFor(phase, sys.now()) } } });

  test("the guard moves Softnet once no VM is starting, so a loop from before finds it while it starts one", async () => {
    const { sys, p, inst, settle } = box();
    slotIs(p, sys, "starting a VM");
    await settle();
    expect(existsSync(join(inst, "bin/softnet"))).toBe(true);
    slotIs(p, sys, "waiting for a job");
    await settle();
    expect(existsSync(join(inst, "bin/softnet"))).toBe(false);
    expect(existsSync(join(inst, "softnet/softnet"))).toBe(true);
  });

  test("the guard never moves Softnet in an install other than the one it started with, such as after an undo", async () => {
    const { inst, settle } = box();
    writeFileSync(join(inst, "installed.json"), JSON.stringify({ commit: "older00", files: hashTree(inst) }));
    await settle();
    expect(existsSync(join(inst, "bin/softnet"))).toBe(true);
  });
});

describe("a restart after a stale beat", () => {
  // The guard kicks a loop whose beat it reads stale on two passes a minute apart, trusting that a
  // loop that has just started writes its own beat first (loopwatch.ts).
  test("the loop's fresh beat is in place before it stops a leftover VM", async () => {
    const sys = new FakeSys();
    const d = loopDeps(sys, tempRoot());
    const old = sys.now() - 3600_000;
    writeLoopState(d.paths, { slotCount: 1, slots: { "1": { slot: "waiting", beat: { at: old, phase: "waiting", until: old + 180_000 } } } });
    let staleAtStop: unknown = "never stopped";
    sys.responders.push((cmd, args) => {
      if (!cmd.endsWith("/tart")) return undefined;
      if (args[0] === "list") return { code: 0, stderr: "", stdout: JSON.stringify([{ Name: CFG.image, Source: "OCI" }, { Name: "job-old-abcdef", Source: "local" }]) };
      if (args[0] === "stop" && args[1] === "job-old-abcdef" && staleAtStop === "never stopped") {
        staleAtStop = staleBeat(readLoop(d.paths.loopState), sys.now()) ?? null;
        // End the loop here: its next state write throws.
        mkdirSync(`${d.paths.loopState}.tmp`, { recursive: true });
      }
      return undefined;
    });
    await runLoop(d).catch(() => {});
    expect(staleAtStop).toBeNull();
  });
});
