import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { ceilingMs, cleanLeftovers, endOldHold, ensureImage, HOLD_CHECK_MS, oneJob, pullImage, removeOldImages, RESTART, runLoop, Slots, whyWait } from "../src/loop.ts";
import { dirname, join } from "node:path";
import { childEnv } from "../src/sys.ts";
import { paths } from "../src/config.ts";
import { jobLines, validJob } from "../src/jobs.ts";
import { sharedPaths } from "../src/shared.ts";
import { screen } from "../src/watch.ts";
import { engineFor } from "../src/vm.ts";
import { FakeSys, SECRETS } from "./fake.ts";
import { loopDeps, PEM, tempRoot, testBox, CFG, PASS } from "./helpers.ts";

// A guest that answers at once, and a runner that takes one job then exits.
function happyGuest(sys: FakeSys, opts: { hang?: boolean } = {}) {
  sys.onSpawn = (p) => {
    if (p.args[0] === "exec") {
      queueMicrotask(() => {
        p.opts.onLine?.("Listening for Jobs");
        p.opts.onLine?.("Running job: integration");
        if (!opts.hang) p.exit(0);
      });
    }
  };
}

describe("one job", () => {
  test("runs the steps in order and deletes the VM", async () => {
    const sys = new FakeSys();
    happyGuest(sys);
    const d = loopDeps(sys, tempRoot());
    const out = await oneJob(d, () => "c0ffee0", "c0ffee0");
    expect(out).toBe("done");
    const order = sys.tartCalls();
    expect(order[0]).toBe(`clone ${d.cfg.image}`);
    expect(order.at(-2)).toMatch(/^stop job-/);
    expect(order.at(-1)).toMatch(/^delete job-/);
    const run = sys.spawned[0]!;
    expect(run.args.slice(0, 1)).toEqual(["run"]);
    expect(run.args).toContain("--net-softnet");
    expect(run.args).toContain("--no-graphics");
    expect(run.args.some((a) => a.startsWith("--dir"))).toBe(false);
    // The one allow rule lets DNS through the block on the box, nothing else.
    expect(run.args.filter((a) => a.startsWith("--net-softnet-allow"))).toEqual(["--net-softnet-allow=out proto udp @host port 53,out proto tcp @host port 53"]);
    // What must come before what: the clone first, the guest sealed and the Softnet check before the
    // runner starts, and the stop before the delete, last.
    const at = (re: RegExp) => sys.events.findIndex((e) => re.test(e));
    const runner = at(/^spawn tart exec -i/);
    expect(at(/^run tart clone /)).toBe(sys.events.findIndex((e) => e.includes(" tart ")));
    // The guest answers, then is sealed; sealing ends with the box's tries at the VM's address.
    expect(at(/^run tart exec VM|^run tart exec job-/)).toBeLessThan(at(/^run tart ip /));
    expect(at(/^run tart ip /)).toBeLessThan(runner);
    expect(at(/^run ps -axo pid=,etime=,user=,ruser=,svuid=,comm=/)).toBeLessThan(runner);
    expect(sys.events.filter((e) => / tart /.test(e)).slice(-2).map((e) => e.split(" ").slice(0, 3).join(" "))).toEqual(["run tart stop", "run tart delete"]);
    const paths = sys.requests.map((r) => `${r.method} ${new URL(r.url).pathname}`);
    expect(paths).toContain("POST /orgs/example-org/actions/runners/generate-jitconfig");
    // The JIT runner removes itself after its job, so a clean run deletes nothing.
    expect(paths.some((p) => p.startsWith("DELETE"))).toBe(false);
  });

  test("every VM blocks the box's public address", async () => {
    const sys = new FakeSys();
    happyGuest(sys);
    const d = loopDeps(sys, tempRoot());
    expect(await oneJob(d, () => "c0ffee0", "c0ffee0")).toBe("done");
    expect(sys.spawned[0]!.args).toContain("--net-softnet-block=203.0.113.7/32,100.64.0.0/10,@host");
    // The status the job reads says what was blocked.
    const status = sys.calls.find((c) => c.stdin?.includes('"softnetBlock"'));
    expect(status && JSON.parse(status.stdin!).softnetBlock).toEqual(["203.0.113.7/32", "100.64.0.0/10", "@host"]);
  });

  test("the status file names the box's Tailscale address for box-check, or null without one", async () => {
    for (const [ifc, want] of [["", null], ["utun99: flags=8051<UP>\n\tinet 100.101.102.103 --> 100.101.102.103 netmask 0xffffffff\n", "100.101.102.103"]] as const) {
      const sys = new FakeSys();
      happyGuest(sys);
      sys.responders.unshift((cmd, args) => (cmd === "/sbin/ifconfig" && args.length === 0 ? { code: ifc ? 0 : 1, stdout: ifc, stderr: "" } : undefined));
      const d = loopDeps(sys, tempRoot());
      expect(await oneJob(d, () => "c0ffee0", "c0ffee0")).toBe("done");
      const status = sys.calls.find((c) => c.stdin?.includes('"softnetBlock"'));
      expect(JSON.parse(status!.stdin!).tailscaleIPv4).toBe(want);
    }
  });

  test("each VM start reads the address again, so a new address is blocked from the next VM on", async () => {
    const sys = new FakeSys();
    happyGuest(sys);
    const d = loopDeps(sys, tempRoot());
    await oneJob(d, () => "c0ffee0", "c0ffee0");
    sys.publicIP = "198.51.100.9";
    await oneJob(d, () => "c0ffee0", "c0ffee0");
    const blocks = sys.spawned.filter((p) => p.args[0] === "run").map((p) => p.args.find((a) => a.startsWith("--net-softnet-block=")));
    expect(blocks).toEqual(["--net-softnet-block=203.0.113.7/32,100.64.0.0/10,@host", "--net-softnet-block=198.51.100.9/32,100.64.0.0/10,@host"]);
    expect(sys.traces).toBe(2);
  });

  test("with the public address unreadable, no runner and no VM", async () => {
    const sys = new FakeSys();
    happyGuest(sys);
    sys.publicIP = null;
    const d = loopDeps(sys, tempRoot());
    expect(await oneJob(d, () => "c0ffee0", "c0ffee0")).toBe("prestart-failed");
    expect(sys.tartCalls()).toEqual([]);
    expect(sys.requests.some((r) => r.url.includes("generate-jitconfig"))).toBe(false);
    expect(JSON.parse(readFileSync(d.paths.loopState, "utf8")).slot).toBe("no public address");
  });

  test("stops a job at the ceiling and removes its runner", async () => {
    const sys = new FakeSys();
    happyGuest(sys, { hang: true });
    const d = loopDeps(sys, tempRoot());
    d.cfg = { ...d.cfg, jobTimeoutMinutes: 1 };
    const out = await oneJob(d, () => "c0ffee0", "c0ffee0");
    expect(out).toBe("ceiling");
    expect(sys.spawned[1]!.killed).toBe(true);
    expect(sys.tartCalls().at(-1)).toMatch(/^delete job-/);
    expect(sys.requests.some((r) => r.method === "DELETE" && r.url.endsWith("/actions/runners/99"))).toBe(true);
  });

  test("a VM that ignores tart stop is ended by the loop, and deleted", async () => {
    const sys = new FakeSys();
    happyGuest(sys);
    sys.tartIgnoresStop = true;
    const d = loopDeps(sys, tempRoot());
    expect(await oneJob(d, () => "c0ffee0", "c0ffee0")).toBe("done");
    const vm = sys.spawned[0]!;
    expect(vm.args[0]).toBe("run");
    expect(vm.killed).toBe(true);
    expect(sys.tartCalls().slice(-2)).toEqual([`stop ${vm.args[1]}`, `delete ${vm.args[1]}`]);
    expect(sys.vms.size).toBe(0);
  });

  // To do: after the kill, the loop deletes at once (loop.ts, the job's finally). A tart run that
  // takes a moment to end still holds the VM, so Tart refuses the delete and the VM stays until the
  // leak check. The fake's kill ends a process at once, which hid it.
  test.todo("a VM that ignores tart stop, and takes a second to end after the kill, is still deleted", async () => {
    const sys = new FakeSys();
    happyGuest(sys);
    sys.tartIgnoresStop = true;
    const spawn = sys.spawn.bind(sys);
    sys.spawn = (cmd, args, opts) => {
      const proc = spawn(cmd, args, opts);
      if (!(cmd.endsWith("/tart") && args[0] === "run")) return proc;
      const vm = sys.spawned.at(-1)!;
      return { ...proc, kill: () => void sys.sleep(1000).then(() => vm.exit(137)) };
    };
    const d = loopDeps(sys, tempRoot());
    expect(await oneJob(d, () => "c0ffee0", "c0ffee0")).toBe("done");
    expect(sys.vms.size).toBe(0);
  });

  test("a VM that stops on tart stop needs no kill", async () => {
    const sys = new FakeSys();
    happyGuest(sys);
    const d = loopDeps(sys, tempRoot());
    expect(await oneJob(d, () => "c0ffee0", "c0ffee0")).toBe("done");
    expect(sys.spawned[0]!.killed).toBe(false);
    expect(sys.vms.size).toBe(0);
  });

  test("an idle runner gives way to an update", async () => {
    const sys = new FakeSys();
    sys.onSpawn = () => {}; // never takes a job
    const d = loopDeps(sys, tempRoot());
    let commit = "c0ffee0";
    let flippedAt = 0;
    const start = sys.now();
    void sys.sleep(60_000).then(() => {
      commit = "beef000";
      flippedAt = sys.now();
    });
    const out = await oneJob(d, () => commit, "c0ffee0");
    expect(out).toBe("update");
    expect(flippedAt).toBe(start + 60_000);
    const killedAt = sys.spawned[1]!.killedAt!;
    expect(killedAt - flippedAt).toBeGreaterThanOrEqual(0);
    expect(killedAt - flippedAt).toBeLessThan(5_000);
    expect(sys.tartCalls().at(-1)).toMatch(/^delete job-/);
  });

  test("an update that comes after the VM's ceiling finds the ceiling first", async () => {
    const sys = new FakeSys();
    sys.onSpawn = () => {};
    const d = loopDeps(sys, tempRoot());
    d.cfg = { ...d.cfg, vmMaxHours: 1 };
    let commit = "c0ffee0";
    void sys.sleep(2 * 3600_000).then(() => (commit = "beef000"));
    expect(await oneJob(d, () => commit, "c0ffee0")).toBe("ceiling");
  });

  test("a Softnet running as root ends the job before the runner starts", async () => {
    const sys = new FakeSys();
    happyGuest(sys);
    sys.responders.push((cmd) => (cmd === "/bin/ps" ? { code: 0, stderr: "", stdout: "101 05:00 taskbox taskbox 501 tart\n102 05:00 taskbox taskbox 501 /opt/taskbox/bin/softnet-x\n103 05:00 root taskbox 0 /opt/taskbox/bin/softnet\n" } : undefined));
    const d = loopDeps(sys, tempRoot());
    expect(await oneJob(d, () => "c0ffee0", "c0ffee0")).toBe("softnet-root");
    expect(sys.spawned.length).toBe(1); // the VM only, no runner
    expect(sys.tartCalls().at(-1)).toMatch(/^delete job-/);
    expect(sys.requests.some((r) => r.method === "DELETE")).toBe(true);
  });

  test("a failed pre-start check starts no VM", async () => {
    const sys = new FakeSys();
    const d = loopDeps(sys, tempRoot(), async () => [{ name: "FileVault", status: "FAIL", detail: "off" }]);
    expect(await oneJob(d, () => "c0ffee0", "c0ffee0")).toBe("prestart-failed");
    expect(sys.tartCalls()).toEqual([]);
    expect(sys.requests).toEqual([]);
  });

  test("an errored pre-start check counts as failed", async () => {
    const sys = new FakeSys();
    const d = loopDeps(sys, tempRoot(), async () => {
      throw new Error("boom");
    });
    expect(await oneJob(d, () => "c0ffee0", "c0ffee0")).toBe("prestart-failed");
    expect(sys.tartCalls()).toEqual([]);
  });

  test("the real pre-start check errors closed on a bare machine", async () => {
    const sys = new FakeSys();
    const d = loopDeps(sys, tempRoot());
    d.prestart = undefined; // run PRESTART itself; softnet and the key are missing
    expect(await oneJob(d, () => "c0ffee0", "c0ffee0")).toBe("prestart-failed");
    expect(sys.tartCalls()).toEqual([]);
  });
});

describe("secrets", () => {
  test("the key, token and runner config never reach an argument or the log", async () => {
    const sys = new FakeSys();
    happyGuest(sys);
    const root = tempRoot();
    const d = loopDeps(sys, root);
    await oneJob(d, () => "c0ffee0", "c0ffee0");
    const args = sys.allArgs();
    const log = readFileSync(d.paths.log, "utf8");
    const jwts = sys.requests.filter((r) => r.auth.split(".").length === 3).map((r) => r.auth.slice(7));
    expect(jwts.length).toBeGreaterThan(0);
    for (const s of [SECRETS.token, SECRETS.jit, d.paths.key, PEM.split("\n")[1]!, ...jwts]) {
      expect(args.includes(s)).toBe(false);
      expect(log.includes(s)).toBe(false);
    }
    // The runner config goes in on stdin.
    expect(sys.spawned[1]!.opts.stdin).toBe(SECRETS.jit + "\n");
  });

  test("the log redacts a token even if a message carries one", () => {
    const sys = new FakeSys();
    const d = loopDeps(sys, tempRoot());
    d.log.secret(SECRETS.jit);
    d.log.write(`oops ${SECRETS.jit} ${SECRETS.token}`);
    expect(d.log.lines[0]).not.toContain(SECRETS.jit);
    expect(d.log.lines[0]).not.toContain(SECRETS.token);
  });

  test("no Sentry variable reaches a child or the LaunchAgent", () => {
    process.env.SENTRY_DSN = "https://example.invalid/1";
    const env = childEnv("/Users/ci");
    delete process.env.SENTRY_DSN;
    expect(Object.keys(env).some((k) => /SENTRY/.test(k))).toBe(false);
    const plist = readFileSync(new URL("../launchd/local.taskbox.loop.plist", import.meta.url), "utf8");
    expect(/<key>[^<]*SENTRY/.test(plist)).toBe(false);
  });
});

describe("the image pull", () => {
  test("a failed pull is recorded with Tart's last line, so check never shows it as still downloading", async () => {
    const sys = new FakeSys();
    sys.onSpawn = (p) => {
      if (p.args[0] === "pull") {
        queueMicrotask(() => {
          p.opts.onLine?.("pulling disk (3.1 GB compressed)...");
          p.opts.onLine?.("40%");
          p.opts.onLine?.("Error: connection reset by peer");
          p.exit(1);
        });
      }
    };
    const d = loopDeps(sys, tempRoot());
    await expect(ensureImage(d)).rejects.toThrow(/pull failed/);
    const pull = JSON.parse(readFileSync(d.paths.pull, "utf8"));
    expect(pull.state).toBe("failed");
    expect(pull.percent).toBe(40);
    expect(pull.error).toContain("connection reset");
    expect(sys.spawned[0]!.opts.env).toEqual({ CI: "1", TART_NO_AUTO_PRUNE: "1" });
  });
  test("with too little room it throws, with the numbers, and pulls nothing", async () => {
    const sys = new FakeSys();
    sys.responders.push((cmd) => (cmd === "/bin/df" ? { code: 0, stdout: `F 1 U A C M\n/dev/disk3s5 1 1 ${100e9 / 1024} 1% /\n`, stderr: "" } : undefined));
    const d = loopDeps(sys, tempRoot());
    d.cfg = { ...d.cfg, imageGB: 77 };
    await expect(ensureImage(d)).rejects.toThrow("no room to download: 100 GB free, 137 GB needed");
    expect(sys.spawned.filter((p) => p.args[0] === "pull").length).toBe(0);
  });
});

describe("old images", () => {
  test("only the pin stays, and the owner reads what was removed and freed", async () => {
    const sys = new FakeSys();
    const OLD = "ghcr.io/cirruslabs/macos-tahoe-xcode@sha256:" + "9".repeat(64);
    sys.image(CFG_IMAGE, 77);
    sys.image(OLD, 64);
    sys.vms.set("my-own-vm", { ip: "192.168.64.9" });
    const d = loopDeps(sys, tempRoot());
    writeFileSync(join(d.paths.projectState, "images.json"), JSON.stringify({ [OLD]: "macos-tahoe-xcode 26.5" }));
    const notes = await removeOldImages(d);
    expect(sys.tartCalls().filter((c) => c.startsWith("delete"))).toEqual([`delete ${OLD}`]);
    expect(notes).toEqual(["Removed old image macos-tahoe-xcode 26.5, about 64 GB freed."]);
    const state = JSON.parse(readFileSync(d.paths.loopState, "utf8"));
    expect(state.cleanup).toContain("Removed old image macos-tahoe-xcode 26.5");
  });

  test("an image an older loop pulled, with no recorded name, is named by its repo", async () => {
    const sys = new FakeSys();
    const OLD = "ghcr.io/cirruslabs/macos-tahoe-xcode@sha256:" + "9".repeat(64);
    sys.image(OLD, 64);
    const d = loopDeps(sys, tempRoot());
    expect(await removeOldImages(d)).toEqual(["Removed old image macos-tahoe-xcode, an older image, about 64 GB freed."]);
  });
});

describe("the pull's ceiling", () => {
  test("a download still running after 6 hours is stopped, to start again from the beginning", async () => {
    const sys = new FakeSys();
    sys.onSpawn = (p) => {
      if (p.args[0] === "pull") queueMicrotask(() => p.opts.onLine?.("pulling disk (69.3 GB compressed)..."));
    };
    const root = tempRoot();
    const res = await pullImage(sys, engineFor("tart", sys, paths(root, testBox())), "img", "img", join(root, "pull.json"));
    expect(res.ok).toBe(false);
    expect(res.error).toContain("ran for 6 hours");
    expect(sys.spawned[0]!.killed).toBe(true);
    // No network or disk reads while it runs: the percent is the whole record.
    expect(sys.calls.some((c) => ["/usr/bin/nettop", "/usr/bin/du", "/sbin/route"].includes(c.cmd))).toBe(false);
  });
});

describe("the loop", () => {
  test("removes leftover job VMs and nothing else on start", async () => {
    const sys = new FakeSys();
    sys.vms.set("job-old", { ip: "192.168.64.7" });
    sys.vms.set("keep-me", { ip: "192.168.64.8" });
    sys.image("ghcr.io/x@sha256:1");
    const d = loopDeps(sys, tempRoot());
    expect(await cleanLeftovers(d)).toEqual({ removed: 1, failed: 0 });
    expect(sys.tartCalls().filter((c) => c.startsWith("delete"))).toEqual(["delete job-old"]);
    expect([...sys.vms.keys()]).toEqual(["keep-me", "ghcr.io/x@sha256:1"]);
  });

  test("a VM left from before a restart is gone before the first clone", async () => {
    const sys = new FakeSys();
    happyGuest(sys);
    sys.image(CFG_IMAGE);
    sys.runVM("job-old").exit(0); // the last loop's VM, stopped with it
    sys.events = [];
    const d = loopDeps(sys, tempRoot(), async () => {
      writeFileSync(d.paths.installed, JSON.stringify({ commit: "beef000", files: {} }));
      return PASS;
    });
    expect(await runLoop(d)).toBe(RESTART);
    const tart = sys.events.filter((e) => e.startsWith("run tart"));
    expect(tart.indexOf("run tart delete job-old")).toBeGreaterThanOrEqual(0);
    expect(tart.indexOf("run tart delete job-old")).toBeLessThan(tart.findIndex((e) => e.startsWith("run tart clone")));
    expect(sys.vms.has("job-old")).toBe(false);
  });

  test("a loop due to move to its new name restarts as for an update, the commit unchanged", async () => {
    const sys = new FakeSys();
    sys.image(CFG_IMAGE);
    let due = false;
    const d = loopDeps(sys, tempRoot(), async () => ((due = true), [{ name: "x", status: "FAIL", detail: "" }]));
    d.relabel = () => due;
    expect(await runLoop(d)).toBe(RESTART);
  });

  test("a leftover VM tart won't delete is counted as not removed, and the log says why", async () => {
    const sys = new FakeSys();
    for (const n of ["job-a", "job-b"]) sys.vms.set(n, { ip: "" });
    sys.responders.push((cmd, args) => (cmd.endsWith("/tart") && args[0] === "delete" && args[1] === "job-b" ? { code: 1, stderr: "the VM is locked by a running tart", stdout: "" } : undefined));
    const d = loopDeps(sys, tempRoot());
    expect(await cleanLeftovers(d)).toEqual({ removed: 1, failed: 1 });
    const log = readFileSync(d.paths.log, "utf8");
    expect(log).toContain("removed leftover VM job-a");
    expect(log).toContain("could not remove leftover VM job-b: the VM is locked by a running tart");
    expect(log).not.toContain("removed leftover VM job-b");
  });

  test("restarts after an update", async () => {
    const sys = new FakeSys();
    sys.responders.push((cmd, args) =>
      cmd.endsWith("/tart") && args[0] === "list"
        ? { code: 0, stderr: "", stdout: JSON.stringify([{ Name: CFG_IMAGE, Source: "OCI" }]) }
        : undefined,
    );
    const root = tempRoot();
    const d = loopDeps(sys, root, async () => {
      writeFileSync(d.paths.installed, JSON.stringify({ commit: "beef000", files: {} }));
      return [{ name: "x", status: "FAIL", detail: "" }];
    });
    expect(await runLoop(d)).toBe(RESTART);
  });
});

// pat's login session as the process list shows it. ps "fail" stands for a list that can't be read.
function sessions(sys: FakeSys, pat: () => "in" | "out" | "fail") {
  sys.responders.push((cmd) => {
    if (cmd === "/usr/bin/dscl") return { code: 0, stderr: "", stdout: "taskbox 501\npat 502\nowner 503\n" };
    if (cmd !== "/bin/ps") return undefined;
    const now = pat();
    if (now === "fail") return { code: 1, stderr: "", stdout: "" };
    const lw = "/System/Library/CoreServices/loginwindow.app/Contents/MacOS/loginwindow";
    return { code: 0, stderr: "", stdout: `    0 ${lw}\n  501 ${lw}\n${now === "in" ? `  502 ${lw}\n  502 /Applications/Epic Games Launcher.app/Contents/MacOS/EpicGamesLauncher\n` : ""}` };
  });
}

const CFG_IMAGE = "ghcr.io/cirruslabs/macos-tahoe-base@sha256:" + "0".repeat(64);

const me = process.getuid!();

describe("shared mode", () => {
  test("every VM gets the config's size, set on the clone after tart clone, never on the image", async () => {
    const sys = new FakeSys();
    happyGuest(sys);
    const d = loopDeps(sys, tempRoot());
    await oneJob(d, () => "c0ffee0", "c0ffee0");
    const set = sys.calls.find((c) => c.cmd.endsWith("/tart") && c.args[0] === "set")!;
    expect(set.args[1]).toMatch(/^job-/);
    expect(set.args.slice(2)).toEqual(["--cpu", "4", "--memory", "8192"]);
    const order = sys.tartCalls();
    expect(order.findIndex((c) => c.startsWith("clone"))).toBeLessThan(order.findIndex((c) => c.startsWith("set")));
  });
  test("a VM starts while another user is logged in, and its job line says so", async () => {
    const sys = new FakeSys();
    happyGuest(sys);
    sys.responders.push((cmd) => (cmd === "/usr/bin/who" ? { code: 0, stdout: "pat  console  Nov 16 09:00\n", stderr: "" } : undefined));
    const d = loopDeps(sys, tempRoot());
    mkdirSync(d.paths.shared, { recursive: true });
    expect(await oneJob(d, () => "c0ffee0", "c0ffee0")).toBe("done");
    const line = readFileSync(d.paths.jobsFile, "utf8");
    expect(JSON.parse(line)).toMatchObject({ cpus: 4, memoryMB: 8192, beside: ["pat"], pressure: "normal" });
  });
  test("a job's ceiling is its own time limit plus 10 minutes", () => {
    const d = loopDeps(new FakeSys(), tempRoot());
    expect(ceilingMs({ ...d.cfg, jobTimeoutMinutes: 55 })).toBe(65 * 60_000);
  });
});

describe("memory", () => {
  test("high pressure, or too little memory free, starts no VM; memory it can't read counts as short", async () => {
    for (const [m, want] of [
      [{ pressure: 2, availableGB: 20 }, "memory pressure is high"],
      [{ pressure: 1, availableGB: 9 }, "9.0 GB of memory is free, and a VM needs 12.2 GB"],
      [{ pressure: undefined, availableGB: 20 }, "the box can't read its memory"],
    ] as const) {
      const sys = new FakeSys();
      const d = { ...loopDeps(sys, tempRoot()), memory: async () => m };
      expect(await oneJob(d, () => "c0ffee0", "c0ffee0")).toBe("held-back");
      expect(sys.tartCalls().some((c) => c.startsWith("clone"))).toBe(false);
      expect(readFileSync(d.paths.log, "utf8")).toContain(want);
    }
  });
  test("very high pressure during a job ends it, and the record says why", async () => {
    const sys = new FakeSys();
    happyGuest(sys, { hang: true });
    let reads = 0;
    const d = { ...loopDeps(sys, tempRoot()), memory: async () => ({ pressure: (++reads > 3 ? 4 : 1) as 1 | 4, availableGB: 20 }) };
    mkdirSync(d.paths.shared, { recursive: true });
    expect(await oneJob(d, () => "c0ffee0", "c0ffee0")).toBe("pressure");
    expect(JSON.parse(readFileSync(d.paths.jobsFile, "utf8"))).toMatchObject({ result: "stopped", why: "pressure", pressure: "very high" });
  });
});

describe("hold and share are gone (v2.2.0)", () => {
  // As v2.1.1 kept them: a hold in the loop's state, and requests left in ci's requests folder.
  function leftFromBefore(d: ReturnType<typeof loopDeps>, hold: boolean, requests: number) {
    if (hold) writeFileSync(d.paths.loopState, JSON.stringify({ hold: { until: d.sys.now() + 3600_000, at: d.sys.now(), reason: "render", by: "pat" }, holdUse: { day: "x", by: { pat: 1 } } }));
    mkdirSync(d.paths.requests, { recursive: true });
    for (let i = 0; i < requests; i++) writeFileSync(join(d.paths.requests, `r${i}`), '{"v":1,"do":"hold"}');
  }

  test("a hold kept from before, and the requests left, end at the first read with one log line", async () => {
    const sys = new FakeSys();
    const d = loopDeps(sys, tempRoot());
    leftFromBefore(d, true, 2);
    endOldHold(d);
    const st = JSON.parse(readFileSync(d.paths.loopState, "utf8"));
    expect([st.hold, st.holdUse]).toEqual([undefined, undefined]);
    expect(readdirSync(d.paths.requests)).toEqual([]);
    const log = readFileSync(d.paths.log, "utf8").trim().split("\n");
    expect(log.length).toBe(1);
    expect(log[0]).toContain("hold: pat's hold until ");
    expect(log[0]).toContain("and 2 requests left for one ended: hold is gone in v2.2.0");
    // Nothing left: nothing said.
    endOldHold(d);
    expect(readFileSync(d.paths.log, "utf8").trim().split("\n").length).toBe(1);
  });

  test("a hold that ran its time, or none at all, ends with no line", () => {
    const d = loopDeps(new FakeSys(), tempRoot());
    writeFileSync(d.paths.loopState, JSON.stringify({ hold: { until: d.sys.now() - 1, at: 1, reason: "x", by: "pat" } }));
    endOldHold(d);
    expect(JSON.parse(readFileSync(d.paths.loopState, "utf8")).hold).toBeUndefined();
    expect(existsSync(d.paths.log)).toBe(false);
  });

  test("a requests folder that is a link is left alone, and nothing it points to goes", () => {
    const d = loopDeps(new FakeSys(), tempRoot());
    const elsewhere = join(d.paths.serviceHome, "elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(elsewhere, "keep"), "x");
    mkdirSync(dirname(d.paths.requests), { recursive: true });
    symlinkSync(elsewhere, d.paths.requests);
    endOldHold(d);
    expect(readdirSync(elsewhere)).toEqual(["keep"]);
  });

  test("runLoop ends a kept hold before it waits for anything, and no hold stops a VM", async () => {
    const sys = new FakeSys();
    happyGuest(sys);
    sys.responders.push((cmd, args) => (cmd.endsWith("/tart") && args[0] === "list" ? { code: 0, stderr: "", stdout: JSON.stringify([{ Name: CFG_IMAGE, Source: "OCI" }]) } : undefined));
    const d = loopDeps(sys, tempRoot());
    mkdirSync(d.paths.shared, { recursive: true });
    leftFromBefore(d, true, 1);
    const real = sys.sleep.bind(sys);
    sys.sleep = async (ms: number) => {
      if (existsSync(d.paths.jobsFile)) writeFileSync(d.paths.installed, JSON.stringify({ commit: "beef000", files: {} }));
      return real(ms);
    };
    expect(await runLoop(d)).toBe(RESTART);
    const line = JSON.parse(readFileSync(d.paths.jobsFile, "utf8").trim().split("\n")[0]!);
    expect(line).toMatchObject({ result: "finished", job: "integration" });
    expect(line.waits).toBeUndefined();
    expect(readFileSync(d.paths.log, "utf8")).toContain("ended: hold is gone in v2.2.0");
  });
});

describe("the guard fails closed", () => {
  test("rules gone at a VM's start with Screen Sharing on: the VM goes, and no VM starts while it's on", async () => {
    const sys = new FakeSys();
    happyGuest(sys);
    const d = loopDeps(sys, tempRoot());
    d.checks = { ...d.checks, rootUid: me };
    // Screen Sharing listens; the guard's record says the rules went missing after the VM started.
    sys.responders.unshift((cmd) => (cmd === "/usr/sbin/netstat" ? { code: 0, stdout: "Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)\ntcp4       0      0  *.5900                 *.*                    LISTEN\n", stderr: "" } : undefined));
    const real = sys.spawn.bind(sys);
    sys.spawn = (cmd, args, opts) => {
      const p = real(cmd, args, opts);
      if (args[0] === "run") writeGuardRecord(d, { missingAt: sys.now() + 1, at: sys.now() + 2 });
      return p;
    };
    expect(await oneJob(d, () => "c0ffee0", "c0ffee0")).toBe("guard-closed");
    expect(sys.tartCalls().at(-1)).toMatch(/^delete job-/);
    expect(JSON.parse(readFileSync(d.paths.loopState, "utf8")).guardClosed).toBe(true);
    expect((await whyWait(d))?.key).toBe("guard");
    // Once a box-check job has shown VM starts leave the rules alone, the rule lifts.
    expect(await whyWait({ ...d, cfg: { ...d.cfg, vmnetPfProven: true } })).toBeUndefined();
  });
});

// The guard's record as root writes it; the tests run as one user, who stands in for root.
function writeGuardRecord(d: ReturnType<typeof loopDeps>, r: { missingAt: number; at: number }) {
  mkdirSync(dirname(d.paths.guardState), { recursive: true });
  writeFileSync(d.paths.guardState, JSON.stringify({ ok: true, detail: "x", tun: "utun99", ...r }), { mode: 0o644 });
}
describe("an update during a pull", () => {
  test("stops Tart, isn't a failure, and the loop restarts", async () => {
    const sys = new FakeSys();
    let n = 0;
    const root = tempRoot();
    const res = await pullImage(sys, engineFor("tart", sys, paths(root, testBox())), "img", "img", join(root, "pull.json"), () => ++n > 3);
    expect(res).toEqual({ ok: false, updated: true, error: "stopped for an update" });
    expect(sys.spawned[0]!.killed).toBe(true);
    const s = JSON.parse(readFileSync(join(root, "pull.json"), "utf8"));
    expect([s.state, s.failures, s.error]).toEqual(["failed", 0, "an update was installed"]);
  });

  test("ensureImage returns stopped, so runLoop exits to restart", async () => {
    const sys = new FakeSys();
    sys.responders.push((cmd, args) => {
      if (cmd.endsWith("/tart") && args[0] === "list") return { code: 0, stderr: "", stdout: "[]" };
      return undefined;
    });
    const d = loopDeps(sys, tempRoot());
    let calls = 0;
    expect(await ensureImage(d, () => ++calls > 3)).toBe("stopped");
    expect(sys.spawned.some((p) => p.args[0] === "pull" && p.killed)).toBe(true);
  });
});


describe("taskbox hold and share typed after the update", () => {
  // test.serial: more than 50 ms of work alone (test/setup.ts).
  test.serial("each gets one line saying it's gone, exits 2 as v3's other old names do (§2.6), and changes nothing", () => {
    for (const cmd of [["hold", "--for", "1h", "--reason", "x"], ["share"]]) {
      const r = Bun.spawnSync([process.execPath, join(import.meta.dir, "..", "src/cli.ts"), ...cmd], { env: { PATH: "/usr/bin:/bin", HOME: tempRoot() } });
      expect(r.exitCode).toBe(2);
      expect(r.stdout.toString()).toBe(`taskbox ${cmd[0]} is gone from v2.2.0: jobs share the box with every user, all the time. To stop jobs, the service account types taskbox stop.\n`);
    }
  });
});

describe("clearing the old requests folder", () => {
  test("a folder someone left with files in it stays, and the loop says so once", () => {
    const d = loopDeps(new FakeSys(), tempRoot());
    mkdirSync(join(d.paths.requests, "x"), { recursive: true });
    writeFileSync(join(d.paths.requests, "x", "y"), "x");
    endOldHold(d);
    endOldHold(d);
    const log = readFileSync(d.paths.log, "utf8").trim().split("\n");
    expect(log).toEqual([expect.stringContaining("the old requests folder keeps 1 name another user left, so it stays")]);
  });

  test("files and links go, only their names; an empty folder goes; a folder with files is never walked into", async () => {
    const { clearRequests, removeRequests } = await import("../src/requests.ts");
    const root = tempRoot();
    const dir = join(root, "requests");
    const outside = join(root, "outside");
    mkdirSync(dir);
    mkdirSync(outside);
    writeFileSync(join(outside, "precious"), "x");
    writeFileSync(join(dir, "req"), "{}");
    symlinkSync(outside, join(dir, "link-to-folder"));
    symlinkSync(join(outside, "precious"), join(dir, "link-to-file"));
    mkdirSync(join(dir, "empty"));
    mkdirSync(join(dir, "full"));
    writeFileSync(join(dir, "full", "theirs"), "x");
    expect(clearRequests(dir)).toEqual({ removed: 4, left: 1, files: 3 });
    expect(readdirSync(dir)).toEqual(["full"]);
    expect(readdirSync(join(dir, "full"))).toEqual(["theirs"]);
    expect(readFileSync(join(outside, "precious"), "utf8")).toBe("x");
    // The folder stays while a folder with files is in it, and goes once that is gone.
    expect(removeRequests(dir)).toEqual({ removed: false, left: 1 });
    rmSync(join(dir, "full"), { recursive: true });
    expect(removeRequests(dir)).toEqual({ removed: true, left: 0 });
    expect(existsSync(dir)).toBe(false);
  });
});

// A runner that takes a job waitMs after it starts.
function runnerTakesJobAfter(sys: FakeSys, waitMs: number) {
  sys.onSpawn = (p) => {
    if (p.args[0] !== "exec" || !p.args.some((a) => a.includes("run.sh"))) return;
    const t = sys.now();
    const real = sys.sleep.bind(sys);
    let done = false;
    sys.sleep = async (ms) => {
      await real(ms);
      if (!done && sys.now() - t >= waitMs) {
        done = true;
        p.opts.onLine?.("Running job: build");
        p.opts.onLine?.("Job build completed with result: Succeeded");
        p.exit(0);
      }
    };
  };
}

describe("what the loop records", () => {
  test("each job line has its phases, in order, with queued before the ask", async () => {
    const sys = new FakeSys();
    runnerTakesJobAfter(sys, 20_000);
    const d = loopDeps(sys, tempRoot());
    mkdirSync(d.paths.shared, { recursive: true });
    d.box = new Slots(2);
    d.box.held.set(1, { slot: 1, kind: "macos", labels: ["taskbox-macos"], job: false });
    expect(await oneJob(d, () => "c0ffee0", "c0ffee0", [], { kind: "macos", queuedAt: sys.now() - 30_000, why: "a jobs job for macOS has waited 0 min, and no VM can take it" })).toBe("done");
    const line = JSON.parse(readFileSync(d.paths.jobsFile, "utf8"));
    expect(validJob(line)).toBe(true);
    const p = line.phases;
    expect(p.queued).toBe(-30_000);
    const order = ["cloned", "guestUp", "sealed", "runnerStarted", "jobStarted", "jobDone", "deleted"].map((k) => p[k]);
    expect(order.every((x: number) => Number.isInteger(x) && x >= 0)).toBe(true);
    expect([...order].sort((a: number, b: number) => a - b)).toEqual(order);
    // A job taken within busyWithinSeconds of the runner starting marks its kind busy.
    expect(d.box.fastAt.macos).toBeDefined();
    // The reason the scheduler gave is on the slot, for watch.
    expect(jobLines(line).join("\n")).toMatch(/Boot \d+ s, waited \d+ s from queued, ran \d+ s, cleanup \d+ s\./);
  });
  test("a job taken long after its VM was ready leaves its kind not busy", async () => {
    const sys = new FakeSys();
    runnerTakesJobAfter(sys, 5 * 60_000);
    const d = loopDeps(sys, tempRoot());
    d.box = new Slots(2);
    await oneJob(d, () => "c0ffee0", "c0ffee0", [], { kind: "macos" });
    expect(d.box.fastAt.macos).toBeUndefined();
  });
  test.serial("runLoop writes each slot's reason, and watch shows it under the slot's line", async () => {
    const sys = new FakeSys();
    sys.onSpawn = () => {};
    const d = loopDeps(sys, tempRoot());
    d.cfg = { ...CFG, vmsAtOnce: 2 };
    d.checks = { ...d.checks, cfg: d.cfg };
    d.memory = async () => ({ pressure: 1, availableGB: 20, totalGB: 34.36 });
    mkdirSync(d.paths.shared, { recursive: true });
    sys.responders.push((cmd, args) => (cmd.endsWith("/tart") && args[0] === "list" ? { code: 0, stderr: "", stdout: JSON.stringify([{ Name: CFG.image, Source: "OCI" }]) } : undefined));
    const real = sys.sleep.bind(sys);
    const t0 = sys.now();
    sys.sleep = async (ms) => {
      await real(ms);
      if (sys.now() - t0 > 20 * 60_000) writeFileSync(d.paths.installed, JSON.stringify({ commit: "beef000", files: {} }));
    };
    expect(await runLoop(d)).toBe(RESTART);
    const st = JSON.parse(readFileSync(d.paths.loopState, "utf8"));
    expect(st.kindChoice).toBe("follow: no job source is set");
    expect(Object.values(st.slots).map((s) => (s as { why?: string }).why)).toContain("the box can't see the queue, so a macOS VM waits ready for the next job");
    // The copy every user reads keeps the reasons.
    const copy = JSON.parse(readFileSync(sharedPaths(d.paths).loopState, "utf8"));
    expect(JSON.stringify(copy.slots)).toContain("waits ready");
    const out = screen({ pullFile: "/none", loopFile: d.paths.loopState, now: sys.now() }).join("\n");
    expect(out).toContain("Why: ");
  });
});
