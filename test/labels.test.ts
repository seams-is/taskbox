// taskbox's launchd labels, and a box installed under an earlier prefix moving to them: the update
// retires the old guard and tailscaled, the loop moves itself between jobs, and stop, start and remove
// know both names while the old loop may still run. Also the settings that make the code general.
import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { AGENT_LABEL, assetUrl, boxNames, GUARD_LABEL, LABEL_PREFIX, loadConfig, paths, previousLabels, OLD_TAILSCALE_SOCKET, TAILSCALE_SOCKET, TAILSCALED_LABEL } from "../src/config.ts";
import { BOOTOUT_WAIT_S, keepsKept, labelsBack, retirePrevious, Stop, tailscaleUrlProblem } from "../src/install.ts";
import { CHECK_EXTRA, serviceNamesRow, tailscaleRow } from "../src/checks.ts";
import { handOver, relabelDue, RESTART, underOldLabel } from "../src/loop.ts";
import { Log } from "../src/log.ts";
import { reloadToken, remove, restartServices } from "../src/ops.ts";
import { start, stop } from "../src/stopstart.ts";
import { FakeSys } from "./fake.ts";
import { CFG, quietBox, servicesObey, socketDirOk, tempRoot, testBox } from "./helpers.ts";

const OLD = "org.example.taskbox";
const old = previousLabels(OLD);
const repo = join(import.meta.dir, "..");

// A fake launchd. Each loaded service has a pid, or 0 when loaded but not running. bootstrap loads a
// plist under its file's name and starts it; bootout unloads.
// lingers: how many prints a service still answers after its bootout, as tailscaled does for about
// 3 s while its process exits (ran in a Tart test Mac).
function launchd(sys: FakeSys, loaded: Record<string, number>, opts: { bootstrapFails?: boolean; bootoutFails?: string[]; lingers?: Record<string, number> } = {}) {
  let next = 9000;
  const leaving: Record<string, number> = {};
  sys.responders.push((cmd, args) => {
    if (cmd !== "/bin/launchctl") return undefined;
    const [verb, a, b] = args;
    if (verb === "print") {
      if (leaving[a!]) {
        leaving[a!]!--;
        return { code: 0, stdout: "\tstate = exiting\n", stderr: "" };
      }
      if (!(a! in loaded)) return { code: 113, stdout: "", stderr: "Could not find service" };
      const pid = loaded[a!]!;
      return { code: 0, stdout: pid ? `\tstate = running\n\tpid = ${pid}\n` : "\tstate = not running\n", stderr: "" };
    }
    if (verb === "bootout") {
      if (opts.bootoutFails?.includes(a!)) return { code: 5, stdout: "", stderr: "Boot-out failed: 5" };
      const had = a! in loaded;
      delete loaded[a!];
      if (had && opts.lingers?.[a!]) leaving[a!] = opts.lingers[a!]!;
      return { code: had ? 0 : 3, stdout: "", stderr: had ? "" : "No such process" };
    }
    if (verb === "bootstrap") {
      if (opts.bootstrapFails) return { code: 5, stdout: "", stderr: "Bootstrap failed: 5" };
      if (Object.values(leaving).some((n) => n > 0)) return { code: 37, stdout: "", stderr: "Bootstrap failed: 37: Operation already in progress" };
      loaded[`${a}/${basename(b!, ".plist")}`] = next++;
      return { code: 0, stdout: "", stderr: "" };
    }
    return undefined;
  });
  return loaded;
}

describe("the labels", () => {
  test("are neutral and match each plist's own Label and file name", () => {
    // The labels name no org, project or box, so any copy of taskbox can use them.
    const c = JSON.parse(readFileSync(join(repo, "taskbox.example.json"), "utf8"));
    for (const word of [c.org, c.project, c.runnerNamePrefix]) expect(LABEL_PREFIX.split(".")).not.toContain(word);
    for (const label of [AGENT_LABEL, GUARD_LABEL, TAILSCALED_LABEL]) expect(label.startsWith(`${LABEL_PREFIX}.`)).toBe(true);
    for (const label of [AGENT_LABEL, GUARD_LABEL, TAILSCALED_LABEL]) {
      const text = readFileSync(join(repo, "launchd", `${label}.plist`), "utf8");
      expect(text).toContain(`<key>Label</key>\n  <string>${label}</string>`);
    }
  });

  // The update to a release that moves the names is run by the install before it, which reads each
  // plist under its old label. So a box's copy may carry the three plists under the previous prefix
  // too, the same but for the Label. The public export never copies these files.
  test("any other plist is a bridge: a neutral one under an earlier prefix, the same but for the Label", () => {
    const neutral = { loop: AGENT_LABEL, guard: GUARD_LABEL, tailscaled: TAILSCALED_LABEL };
    // The GitHub key keeper's plist is v3's own, with no earlier label.
    for (const f of readdirSync(join(repo, "launchd")).filter((f) => f !== "local.taskbox.broker.plist" && !Object.values(neutral).some((l) => f === `${l}.plist`))) {
      const m = /^(.+)\.(loop|guard|tailscaled)\.plist$/.exec(f);
      expect(m ? `${m[1]} ${m[2]}` : f).toMatch(/^[a-z0-9.-]+ (loop|guard|tailscaled)$/);
      const [, prefix, kind] = m! as unknown as [string, string, keyof typeof neutral];
      const label = neutral[kind];
      const now = readFileSync(join(repo, "launchd", `${label}.plist`), "utf8");
      expect(readFileSync(join(repo, "launchd", f), "utf8")).toBe(now.replace(`<string>${label}</string>`, `<string>${prefix}.${kind}</string>`));
    }
  });

  test("paths know the old loop label only when taskbox.json names a previous prefix", () => {
    expect(paths(tempRoot(), testBox()).loopLabels).toEqual([AGENT_LABEL]);
    const p = paths(tempRoot(), testBox(OLD));
    expect(p.loopLabels).toEqual([AGENT_LABEL, `${OLD}.loop`]);
    expect(p.previousLabelPrefix).toBe(OLD);
  });
});

describe("an update on a box installed under the old labels", () => {
  function box(loaded: Record<string, number>) {
    const sys = new FakeSys();
    servicesObey(sys);
    quietBox(sys);
    const l = launchd(sys, loaded);
    const p = paths(tempRoot(), testBox(OLD));
    for (const f of [p.agentPlist, p.guardPlist]) mkdirSync(join(f, ".."), { recursive: true });
    const files = [join(p.agentPlist, "..", `${old.loop}.plist`), join(p.guardPlist, "..", `${old.guard}.plist`), join(p.guardPlist, "..", `${old.tailscaled}.plist`)];
    for (const f of files) writeFileSync(f, "<plist/>");
    const said: string[] = [];
    return { sys, l, p, files, said, d: { sys, paths: p, say: (s: string) => said.push(s) } };
  }

  test("boots out the old guard and tailscaled, and removes all three old files", async () => {
    const b = box({ [`system/${old.guard}`]: 100, [`system/${old.tailscaled}`]: 101, [`gui/502/${old.loop}`]: 102 });
    await retirePrevious(b.d, OLD);
    expect(b.l[`system/${old.guard}`]).toBeUndefined();
    expect(b.l[`system/${old.tailscaled}`]).toBeUndefined();
    for (const f of b.files) expect(existsSync(f)).toBe(false);
    // The loop in ci's session is left running, so a job isn't cut: it moves itself later.
    expect(b.l[`gui/502/${old.loop}`]).toBe(102);
    expect(b.sys.calls.some((c) => c.args[0] === "bootout" && c.args[1]!.startsWith("gui/"))).toBe(false);
    expect(b.said).toEqual([]);
  });

  test("an old tailscaled that won't stop loads nothing new, puts the guard back, keeps every old file and stops the update", async () => {
    const sys = new FakeSys();
    servicesObey(sys);
    quietBox(sys);
    const l = launchd(sys, { [`system/${old.guard}`]: 100, [`system/${old.tailscaled}`]: 101 }, { bootoutFails: [`system/${old.tailscaled}`] });
    const p = paths(tempRoot(), testBox(OLD));
    mkdirSync(join(p.guardPlist, ".."), { recursive: true });
    mkdirSync(join(p.agentPlist, ".."), { recursive: true });
    const files = [join(p.agentPlist, "..", `${old.loop}.plist`), join(p.guardPlist, "..", `${old.guard}.plist`), join(p.guardPlist, "..", `${old.tailscaled}.plist`)];
    for (const f of files) writeFileSync(f, "<plist/>");
    await expect(retirePrevious({ sys, paths: p, say: () => {} }, OLD)).rejects.toThrow("tailscaled under the old name didn't stop, so the services keep their old names and nothing new was loaded. Type taskbox update again; if it says this twice, restart the Mac, then type taskbox update.");
    // The old guard, booted out, is loaded again from its file, so Screen Sharing stays guarded.
    expect(l[`system/${old.guard}`]).toBeGreaterThan(0);
    expect(l[`system/${old.tailscaled}`]).toBe(101);
    for (const f of files) expect(existsSync(f)).toBe(true);
    expect(Object.keys(l).some((k) => k.includes(LABEL_PREFIX))).toBe(false);
  });

  test("a box already moved, or never under the old names, is left as it is", async () => {
    const b = box({ [`system/${GUARD_LABEL}`]: 200 });
    await retirePrevious(b.d, OLD);
    expect(b.l).toEqual({ [`system/${GUARD_LABEL}`]: 200 });
    expect(b.said).toEqual([]);
  });

});

describe("the loop moving to its new label", () => {
  const d = (sys: FakeSys, prefix: string | null = OLD, withAgent = true) => {
    const p = paths(tempRoot(), testBox(prefix ?? undefined));
    if (withAgent) {
      mkdirSync(join(p.agentPlist, ".."), { recursive: true });
      writeFileSync(p.agentPlist, "<plist/>");
    }
    return { sys, cfg: { ...CFG, ...(prefix ? { previousLabelPrefix: prefix } : {}) }, paths: p, log: new Log(p.log) };
  };

  test("nothing to do with no previous prefix, or no old loop loaded", async () => {
    const sys = new FakeSys();
    servicesObey(sys);
    quietBox(sys);
    launchd(sys, {});
    expect(await handOver(d(sys, null), 502, 4242)).toBeUndefined();
    expect(sys.calls).toEqual([]);
    expect(await handOver(d(sys), 502, 4242)).toBeUndefined();
    expect(sys.calls.map((c) => c.args[0])).toEqual(["print"]);
  });

  test("the old loop loads the new one, then boots itself out", async () => {
    const sys = new FakeSys();
    servicesObey(sys);
    quietBox(sys);
    const l = launchd(sys, { [`gui/502/${old.loop}`]: 4242 });
    const x = d(sys);
    // A real bootout ends this process; here it returns, so the loop exits 0 and launchd won't restart the old one.
    expect(await handOver(x, 502, 4242)).toBe(0);
    expect(l[`gui/502/${AGENT_LABEL}`]).toBeGreaterThan(0);
    expect(l[`gui/502/${old.loop}`]).toBeUndefined();
    const verbs = sys.calls.map((c) => `${c.args[0]} ${c.args[1]}`);
    expect(verbs.indexOf(`bootstrap gui/502`)).toBeLessThan(verbs.indexOf(`bootout gui/502/${old.loop}`));
    expect(sys.calls.find((c) => c.args[0] === "bootstrap")!.args[2]).toBe(x.paths.agentPlist);
    expect(readFileSync(x.paths.log, "utf8")).toContain("the loop moves to its new name");
  });

  test("before the new LaunchAgent is in place, the old loop tries nothing and logs one plain line", async () => {
    const sys = new FakeSys();
    servicesObey(sys);
    quietBox(sys);
    const l = launchd(sys, { [`gui/502/${old.loop}`]: 4242 });
    const x = d(sys, OLD, false);
    expect(await handOver(x, 502, 4242)).toBeUndefined();
    expect(sys.calls.some((c) => c.args[0] === "bootstrap")).toBe(false);
    expect(l[`gui/502/${old.loop}`]).toBe(4242);
    expect(readFileSync(x.paths.log, "utf8")).toContain("the loop keeps its old name until the next taskbox update moves taskbox's services");
  });

  test("an old loop that can't load the new one keeps running under the old name", async () => {
    const sys = new FakeSys();
    servicesObey(sys);
    quietBox(sys);
    const l = launchd(sys, { [`gui/502/${old.loop}`]: 4242 }, { bootstrapFails: true });
    const x = d(sys);
    expect(await handOver(x, 502, 4242)).toBeUndefined();
    expect(l[`gui/502/${old.loop}`]).toBe(4242);
    expect(readFileSync(x.paths.log, "utf8")).toContain("the loop keeps its old name: launchctl bootstrap ended with 5");
  });

  test("the new loop waits for the old one to end, so two loops never take jobs", async () => {
    const sys = new FakeSys();
    servicesObey(sys);
    quietBox(sys);
    const l = launchd(sys, { [`gui/502/${old.loop}`]: 4242, [`gui/502/${AGENT_LABEL}`]: 5000 });
    let sleeps = 0;
    sys.sleep = async () => {
      if (++sleeps === 3) delete l[`gui/502/${old.loop}`];
    };
    expect(await handOver(d(sys), 502, 5000)).toBeUndefined();
    expect(sleeps).toBe(3);
  });

  test("and tries again later if the old one doesn't end", async () => {
    const sys = new FakeSys();
    servicesObey(sys);
    quietBox(sys);
    launchd(sys, { [`gui/502/${old.loop}`]: 4242 });
    sys.sleep = async () => {};
    const x = d(sys);
    expect(await handOver(x, 502, 5000, 10)).toBe(RESTART);
    expect(readFileSync(x.paths.log, "utf8")).toContain("the loop under its old name is still running");
  });

  test("an old loop that is loaded but not running is booted out", async () => {
    const sys = new FakeSys();
    servicesObey(sys);
    quietBox(sys);
    const l = launchd(sys, { [`gui/502/${old.loop}`]: 0 });
    expect(await handOver(d(sys), 502, 5000)).toBeUndefined();
    expect(l[`gui/502/${old.loop}`]).toBeUndefined();
  });
});

describe("stop, start and remove while the old loop may still run", () => {
  test("stop stops the loop under whichever name it runs", async () => {
    const sys = new FakeSys();
    servicesObey(sys);
    quietBox(sys);
    const l = launchd(sys, { [`gui/502/${old.loop}`]: 4242 });
    const said: string[] = [];
    const p = paths(tempRoot(), testBox(OLD));
    expect(await stop({ sys, paths: p, uid: 502, say: (s) => said.push(s), ask: async () => "no" })).toBe(0);
    expect(l[`gui/502/${old.loop}`]).toBeUndefined();
  });

  test("start, between the two updates, loads the old LaunchAgent when the new one isn't there yet", async () => {
    const sys = new FakeSys();
    servicesObey(sys);
    quietBox(sys);
    const l = launchd(sys, {});
    const p = paths(tempRoot(), testBox(OLD));
    mkdirSync(join(p.agentPlist, ".."), { recursive: true });
    const oldFile = join(p.agentPlist, "..", `${old.loop}.plist`);
    writeFileSync(oldFile, "<plist/>");
    writeFileSync(p.stopped, JSON.stringify({ at: 1 }));
    const said: string[] = [];
    expect(await start({ sys, paths: p, uid: 502, say: (s) => said.push(s), ask: async () => "no" })).toBe(0);
    expect(sys.calls.find((c) => c.args[0] === "bootstrap")!.args).toEqual(["bootstrap", "gui/502", oldFile]);
    expect(l[`gui/502/${old.loop}`]).toBeGreaterThan(0);
    expect(said.at(-1)).toBe("Started. Type taskbox status -w to see what it does.");
    expect(existsSync(p.stopped)).toBe(false);
  });

  test("start loads the new LaunchAgent once its file is there", async () => {
    const sys = new FakeSys();
    servicesObey(sys);
    quietBox(sys);
    const l = launchd(sys, {});
    const p = paths(tempRoot(), testBox(OLD));
    mkdirSync(join(p.agentPlist, ".."), { recursive: true });
    writeFileSync(p.agentPlist, "<plist/>");
    writeFileSync(join(p.agentPlist, "..", `${old.loop}.plist`), "<plist/>");
    expect(await start({ sys, paths: p, uid: 502, say: () => {}, ask: async () => "no" })).toBe(0);
    expect(l[`gui/502/${AGENT_LABEL}`]).toBeGreaterThan(0);
    expect(l[`gui/502/${old.loop}`]).toBeUndefined();
  });

  test("start counts the old loop as running", async () => {
    const sys = new FakeSys();
    servicesObey(sys);
    quietBox(sys);
    launchd(sys, { [`gui/502/${old.loop}`]: 4242 });
    const said: string[] = [];
    expect(await start({ sys, paths: paths(tempRoot(), testBox(OLD)), uid: 502, say: (s) => said.push(s), ask: async () => "no" })).toBe(3);
    expect(said.at(-1)).toContain("Already running");
  });

  test("remove boots out and deletes the old loop and guard too", async () => {
    const sys = new FakeSys();
    servicesObey(sys);
    quietBox(sys);
    const l = launchd(sys, { [`gui/502/${old.loop}`]: 1, [`system/${old.guard}`]: 2, [`gui/502/${AGENT_LABEL}`]: 3, [`system/${GUARD_LABEL}`]: 4 });
    const p = paths(tempRoot(), testBox(OLD));
    for (const f of [p.agentPlist, p.guardPlist]) mkdirSync(join(f, ".."), { recursive: true });
    const oldFiles = [join(p.agentPlist, "..", `${old.loop}.plist`), join(p.guardPlist, "..", `${old.guard}.plist`)];
    for (const f of oldFiles) writeFileSync(f, "<plist/>");
    const said: string[] = [];
    await remove({ sys, paths: p, uid: 0, say: (s) => said.push(s), ask: async () => "yes" }, { serviceUid: 502 });
    expect(l).toEqual({});
    for (const f of oldFiles) expect(existsSync(f)).toBe(false);
  });
});

describe("the settings that make the code general", () => {
  const dir = mkdtempSync(join(tmpdir(), "taskbox-cfg-"));
  const base = JSON.parse(readFileSync(join(repo, "taskbox.example.json"), "utf8"));
  const load = (v: Record<string, unknown>) => (writeFileSync(join(dir, "taskbox.json"), JSON.stringify({ ...base, ...v })), () => loadConfig(dir));

  test("the example loads, with made-up names only", () => {
    writeFileSync(join(dir, "taskbox.json"), JSON.stringify(base));
    const c = loadConfig(dir);
    expect([c.org, c.jobsFrom, c.project, c.appId]).toEqual(["example-org", "example-org/app", "app", 123456]);
  });

  test("project, org, repo and jobsFrom are checked", () => {
    for (const bad of [undefined, "", "App", "../x", "a b", 7]) expect(load({ project: bad })).toThrow("project");
    for (const bad of [undefined, "", "a/b", "-x"]) expect(load({ org: bad })).toThrow("org");
    for (const bad of [undefined, "", "a/b"]) expect(load({ repo: bad })).toThrow("repo");
    for (const bad of [undefined, "app", "a/b/c", "a b/c"]) expect(load({ jobsFrom: bad })).toThrow("jobsFrom");
  });

  test("accounts.people names the box's own users, and no user is built in", () => {
    expect(load({ accounts: { service: "taskbox", people: [] } })().accounts.people).toEqual([]);
    expect(load({ accounts: { service: "taskbox", people: ["pat"] } })().accounts.people).toEqual(["pat"]);
    for (const bad of [["root"], "pat", [7]]) expect(load({ accounts: { service: "taskbox", people: bad } })).toThrow("accounts.people");
    expect(load({ accounts: { service: "taskbox" } })().accounts).toEqual({ service: "taskbox", people: [] });
  });

  test("previousLabelPrefix is an earlier prefix, never the current one", () => {
    expect(load({ previousLabelPrefix: OLD })().previousLabelPrefix).toBe(OLD);
    for (const bad of [LABEL_PREFIX, "nodots", "a..b", "a.b/c", 7]) expect(load({ previousLabelPrefix: bad })).toThrow("previousLabelPrefix");
  });

  test("boxNames reads the project and prefix from settings that may not be complete", () => {
    const accounts = { service: "taskbox", agent: "taskbox-agent" };
    writeFileSync(join(dir, "taskbox.json"), JSON.stringify({ project: "app", accounts, previousLabelPrefix: OLD }));
    expect(boxNames(dir)).toEqual({ project: "app", service: "taskbox", agent: "taskbox-agent", previousLabelPrefix: OLD });
    writeFileSync(join(dir, "taskbox.json"), JSON.stringify({ project: "app", accounts: { service: "taskbox" }, previousLabelPrefix: LABEL_PREFIX }));
    expect(boxNames(dir)).toEqual({ project: "app", service: "taskbox" });
    writeFileSync(join(dir, "taskbox.json"), JSON.stringify({ project: "app" }));
    expect(() => boxNames(dir)).toThrow("taskbox.json has no accounts.service");
    writeFileSync(join(dir, "taskbox.json"), JSON.stringify({}));
    expect(() => boxNames(dir)).toThrow("taskbox.json has no project");
    expect(() => boxNames(join(dir, "none"))).toThrow("taskbox.json can't be read");
  });

  test("a release asset's address comes from org and repo", () => {
    expect(assetUrl(CFG, 123)).toBe("https://api.github.com/repos/example-org/taskbox/releases/assets/123");
  });
});

describe("time limits", () => {
  test("every launchctl call has a time limit", () => {
    for (const f of readdirSync(join(repo, "src"), { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts"))) {
      const text = readFileSync(join(repo, "src", f), "utf8");
      for (const m of text.matchAll(/run\("\/bin\/launchctl", \[[^\]]*\]\)/g)) throw new Error(`${f}: ${m[0]} has no time limit`);
    }
  });
});

describe("taskbox rollback back across the label move", () => {
  // The kept install, now behind /opt/taskbox: its launchd folder has the old labels' files only.
  function box(keptHasNew = false) {
    const sys = new FakeSys();
    servicesObey(sys);
    quietBox(sys);
    const l = launchd(sys, { [`system/${GUARD_LABEL}`]: 10, [`system/${TAILSCALED_LABEL}`]: 11, [`gui/502/${AGENT_LABEL}`]: 12 });
    const p = paths(tempRoot(), testBox(OLD));
    const kept = join(p.app, "launchd");
    mkdirSync(kept, { recursive: true });
    for (const k of ["loop", "guard", "tailscaled"]) writeFileSync(join(kept, `${OLD}.${k}.plist`), `<plist>${k}</plist>`);
    if (keptHasNew) for (const lab of [AGENT_LABEL, GUARD_LABEL, TAILSCALED_LABEL]) writeFileSync(join(kept, `${lab}.plist`), "<plist/>");
    for (const f of [p.agentPlist, p.guardPlist, p.tailscaledPlist]) {
      mkdirSync(join(f, ".."), { recursive: true });
      writeFileSync(f, "<plist>new</plist>");
    }
    const said: string[] = [];
    return { sys, l, p, said, d: { sys, paths: p, say: (x: string) => said.push(x) } };
  }

  test("the guard and tailscaled go back to their old names from the kept install's plists, one at a time", async () => {
    const b = box();
    expect(await labelsBack(b.d, OLD)).toBe("The guard and tailscaled run under their old names again. Log out taskbox and log in again, so the loop does too.");
    expect(b.l[`system/${GUARD_LABEL}`]).toBeUndefined();
    expect(b.l[`system/${TAILSCALED_LABEL}`]).toBeUndefined();
    expect(b.l[`system/${old.guard}`]).toBeGreaterThan(0);
    expect(b.l[`system/${old.tailscaled}`]).toBeGreaterThan(0);
    // Each new daemon is booted out before its old one loads, so two never run at once.
    const order = b.sys.calls.filter((c) => c.cmd === "/bin/launchctl").map((c) => `${c.args[0]} ${c.args.at(-1)}`);
    expect(order.indexOf(`bootout system/${TAILSCALED_LABEL}`)).toBeLessThan(order.findIndex((o) => o.endsWith(`${old.tailscaled}.plist`)));
    // The files: the old ones written from the kept install, the new ones gone.
    expect(readFileSync(join(b.p.guardPlist, "..", `${old.guard}.plist`), "utf8")).toBe("<plist>guard</plist>");
    expect(readFileSync(join(b.p.agentPlist, "..", `${old.loop}.plist`), "utf8")).toBe("<plist>loop</plist>");
    for (const f of [b.p.agentPlist, b.p.guardPlist, b.p.tailscaledPlist]) expect(existsSync(f)).toBe(false);
    // The running loop is left alone: its job isn't cut.
    expect(b.l[`gui/502/${AGENT_LABEL}`]).toBe(12);
  });

  test("a kept install that already has the new labels is left as it is", async () => {
    const b = box(true);
    expect(await labelsBack(b.d, OLD)).toBeUndefined();
    expect(b.sys.calls).toEqual([]);
  });

  test("an old daemon that won't start is said, with the next step", async () => {
    const b = box();
    b.sys.responders.unshift((cmd, args) => (cmd === "/bin/launchctl" && args[0] === "bootstrap" && args[2]!.endsWith(`${old.tailscaled}.plist`) ? { code: 5, stdout: "", stderr: "Bootstrap failed: 5" } : undefined));
    b.sys.sleep = async () => {};
    expect(await labelsBack(b.d, OLD)).toBe("The services went back to their old names, but tailscaled didn't start. Keep Screen Sharing off and type taskbox update.");
  });

});

describe("the old tailscaled at the second update", () => {
  test("the second update waits for the old tailscaled to finish exiting, then retires it", async () => {
    const sys = new FakeSys();
    servicesObey(sys);
    quietBox(sys);
    sys.sleep = async () => {};
    const l = launchd(sys, { [`system/${old.guard}`]: 100, [`system/${old.tailscaled}`]: 101 }, { lingers: { [`system/${old.tailscaled}`]: 3 } });
    const p = paths(tempRoot(), testBox(OLD));
    mkdirSync(join(p.guardPlist, ".."), { recursive: true });
    mkdirSync(join(p.agentPlist, ".."), { recursive: true });
    await retirePrevious({ sys, paths: p, say: () => {} }, OLD);
    expect(l).toEqual({});
    expect(existsSync(join(p.guardPlist, "..", `${old.tailscaled}.plist`))).toBe(false);
  });

  test("one that never goes is stuck only after the wait", async () => {
    const sys = new FakeSys();
    servicesObey(sys);
    quietBox(sys);
    let slept = 0;
    sys.sleep = async () => void slept++;
    launchd(sys, { [`system/${old.tailscaled}`]: 101 }, { lingers: { [`system/${old.tailscaled}`]: 999 } });
    const p = paths(tempRoot(), testBox(OLD));
    mkdirSync(join(p.guardPlist, ".."), { recursive: true });
    await expect(retirePrevious({ sys, paths: p, say: () => {} }, OLD)).rejects.toThrow("tailscaled under the old name didn't stop");
    expect(slept).toBe(BOOTOUT_WAIT_S);
  });

  test("undo starts the old tailscaled only once the new one has gone, since they share a socket", async () => {
    const sys = new FakeSys();
    servicesObey(sys);
    quietBox(sys);
    sys.sleep = async () => {};
    const l = launchd(sys, { [`system/${GUARD_LABEL}`]: 10, [`system/${TAILSCALED_LABEL}`]: 11 }, { lingers: { [`system/${TAILSCALED_LABEL}`]: 3 } });
    const p = paths(tempRoot(), testBox(OLD));
    const kept = join(p.app, "launchd");
    mkdirSync(kept, { recursive: true });
    for (const k of ["loop", "guard", "tailscaled"]) writeFileSync(join(kept, `${OLD}.${k}.plist`), `<plist>${k}</plist>`);
    for (const f of [p.agentPlist, p.guardPlist, p.tailscaledPlist]) {
      mkdirSync(join(f, ".."), { recursive: true });
      writeFileSync(f, "<plist>new</plist>");
    }
    expect(await labelsBack({ sys, paths: p, say: () => {} }, OLD)).toBe("The guard and tailscaled run under their old names again. Log out taskbox and log in again, so the loop does too.");
    expect(l[`system/${old.tailscaled}`]).toBeGreaterThan(0);
    // No bootstrap was refused for a tailscaled still exiting.
    expect(sys.calls.filter((c) => c.args[0] === "bootstrap").length).toBe(2);
  });

  test("undo straight after the first update, with every service still under its old name, moves nothing", async () => {
    const sys = new FakeSys();
    servicesObey(sys);
    quietBox(sys);
    launchd(sys, { [`system/${old.guard}`]: 1, [`system/${old.tailscaled}`]: 2 });
    const p = paths(tempRoot(), testBox(OLD));
    const kept = join(p.app, "launchd");
    mkdirSync(kept, { recursive: true });
    for (const k of ["loop", "guard", "tailscaled"]) writeFileSync(join(kept, `${OLD}.${k}.plist`), "<plist/>");
    mkdirSync(join(p.guardPlist, ".."), { recursive: true });
    for (const k of ["guard", "tailscaled"]) writeFileSync(join(p.guardPlist, "..", `${old[k as "guard" | "tailscaled"]}.plist`), "<plist/>");
    expect(await labelsBack({ sys, paths: p, say: () => {} }, OLD)).toBeUndefined();
    expect(sys.calls).toEqual([]);
  });

  test("a loop under its old name restarts, as for an update, once the new LaunchAgent is in place", async () => {
    const p = paths(tempRoot(), testBox(OLD));
    const log = new Log(p.log);
    expect(relabelDue({ paths: p, log }, false)()).toBe(false);
    const due = relabelDue({ paths: p, log }, true);
    expect(due()).toBe(false);
    mkdirSync(join(p.agentPlist, ".."), { recursive: true });
    writeFileSync(p.agentPlist, "<plist/>");
    expect([due(), due()]).toEqual([true, true]);
    expect(readFileSync(p.log, "utf8").match(/restarts under its new name/g)).toHaveLength(1);
  });

  test("the loop knows when it runs under the old label", async () => {
    const sys = new FakeSys();
    servicesObey(sys);
    quietBox(sys);
    launchd(sys, { [`gui/502/${old.loop}`]: 4242 });
    const cfg = { ...CFG, previousLabelPrefix: OLD };
    expect(await underOldLabel({ sys, cfg }, 502, 4242)).toBe(true);
    expect(await underOldLabel({ sys, cfg }, 502, 5000)).toBe(false);
    expect(await underOldLabel({ sys, cfg: CFG }, 502, 4242)).toBe(false);
  });

  test("remove stops tailscaled under either name and removes its files, state and socket", async () => {
    const sys = new FakeSys();
    servicesObey(sys);
    quietBox(sys);
    sys.sleep = async () => {};
    const l = launchd(sys, { [`system/${TAILSCALED_LABEL}`]: 11, [`system/${old.tailscaled}`]: 12, [`system/${GUARD_LABEL}`]: 13 }, { lingers: { [`system/${TAILSCALED_LABEL}`]: 2 } });
    const p = paths(tempRoot(), testBox(OLD));
    mkdirSync(join(p.guardPlist, ".."), { recursive: true });
    const files = [p.tailscaledPlist, join(p.guardPlist, "..", `${old.tailscaled}.plist`), p.tailscaleSocket, p.oldTailscaleSocket];
    for (const f of files) {
      mkdirSync(join(f, ".."), { recursive: true });
      writeFileSync(f, "x");
    }
    mkdirSync(join(p.tailscaleState, "x"), { recursive: true });
    const said: string[] = [];
    await remove({ sys, paths: p, uid: 0, say: (s) => said.push(s), ask: async () => "yes" }, { serviceUid: 502 });
    expect(l).toEqual({});
    for (const f of [...files, p.tailscaleState, p.tailscaleSocketDir]) expect(existsSync(f)).toBe(false);
    expect(said.join("\n")).toContain("stopped taskbox's Tailscale");
    expect(said.join("\n")).toContain("removed Tailscale's socket under its old name");
  });

  test("remove keeps tailscaled's files when it won't stop, and says so", async () => {
    const sys = new FakeSys();
    servicesObey(sys);
    quietBox(sys);
    sys.sleep = async () => {};
    launchd(sys, { [`system/${TAILSCALED_LABEL}`]: 11 }, { bootoutFails: [`system/${TAILSCALED_LABEL}`] });
    const p = paths(tempRoot(), testBox(OLD));
    mkdirSync(join(p.tailscaleState, "x"), { recursive: true });
    const said: string[] = [];
    expect(await remove({ sys, paths: p, uid: 0, say: (s) => said.push(s), ask: async () => "yes" }, { serviceUid: 502 })).toBe(1);
    expect(existsSync(p.tailscaleState)).toBe(true);
    expect(said.join("\n")).toContain("taskbox's Tailscale, which didn't stop");
  });
});

describe("undo restarts the root services on the code it went back to", () => {
  const installs = (sameTailscaled: boolean) => {
    const root = tempRoot();
    const now = join(root, "opt/taskbox-now");
    const was = join(root, "opt/taskbox-was");
    for (const [dir, bytes] of [[now, "tailscaled A"], [was, sameTailscaled ? "tailscaled A" : "tailscaled B"]] as const) {
      mkdirSync(join(dir, "bin"), { recursive: true });
      writeFileSync(join(dir, "bin/tailscaled"), bytes);
    }
    return { now, was };
  };
  const kicks = (sys: FakeSys) => sys.calls.filter((c) => c.args[0] === "kickstart").map((c) => c.args.join(" "));

  test("tailscaled's LaunchDaemon goes back to the kept install's, such as one with the old socket name, and is loaded again", async () => {
    // As logins.test.ts has it: the plist is written back, and a one-shot LaunchDaemon loads it again.
    const box = () => {
      const x = new FakeSys();
      x.sleep = async () => {};
      servicesObey(x);
      launchd(x, { [`system/${GUARD_LABEL}`]: 1, [`system/${TAILSCALED_LABEL}`]: 2 });
      return x;
    };
    const sys = box();
    const { now, was } = installs(true);
    const d = { sys, paths: paths(tempRoot(), testBox()), uid: 0, say: () => {}, ask: async () => "yes", rootUid: process.getuid!() };
    const oldPlist = readFileSync(join(import.meta.dir, "../launchd/local.taskbox.tailscaled.plist"), "utf8").replace(TAILSCALE_SOCKET, OLD_TAILSCALE_SOCKET);
    mkdirSync(join(now, "app/launchd"), { recursive: true });
    writeFileSync(join(now, "app/launchd", `${TAILSCALED_LABEL}.plist`), oldPlist);
    mkdirSync(dirname(d.paths.tailscaledPlist), { recursive: true });
    writeFileSync(d.paths.tailscaledPlist, readFileSync(join(import.meta.dir, "../launchd/local.taskbox.tailscaled.plist")));
    for (const f of [d.paths.tailscaledLog, reloadToken(d.paths)]) mkdirSync(dirname(f), { recursive: true });
    const noChown = () => {};
    expect(await restartServices(d, now, was, noChown)).toContain("tailscaled loads again from this install's plist within a minute");
    expect(readFileSync(d.paths.tailscaledPlist, "utf8")).toBe(oldPlist);
    const verbs = sys.calls.filter((c) => c.cmd === "/bin/launchctl" && c.args.join(" ").includes("tailscale")).map((c) => c.args[0]);
    expect(verbs).toEqual(["print", "bootout", "bootstrap"]);
    // With a pool account, undo says the socket is back where other accounts can reach it.
    mkdirSync(dirname(d.paths.poolRecord), { recursive: true });
    writeFileSync(d.paths.poolRecord, "{}");
    writeFileSync(d.paths.tailscaledPlist, readFileSync(join(import.meta.dir, "../launchd/local.taskbox.tailscaled.plist")));
    expect(await restartServices({ ...d, sys: box() }, now, was, noChown)).toContain(`The older install puts tailscaled's socket back at its old path, ${OLD_TAILSCALE_SOCKET}, where other accounts on the box, the workspace account included, can reach it. Type taskbox update to move it back.`);
    rmSync(d.paths.poolRecord);
    // The same plist: nothing is reloaded.
    const again = box();
    await restartServices({ ...d, sys: again }, now, was, noChown);
    expect(again.calls.some((c) => c.args[0] === "bootout")).toBe(false);
  });

  test("the guard restarts under the name it runs under; tailscaled only when its binary differs", async () => {
    for (const [loaded, guard, ts] of [
      [{ [`system/${GUARD_LABEL}`]: 1, [`system/${TAILSCALED_LABEL}`]: 2 }, GUARD_LABEL, TAILSCALED_LABEL],
      [{ [`system/${old.guard}`]: 1, [`system/${old.tailscaled}`]: 2 }, old.guard, old.tailscaled],
    ] as const) {
      for (const same of [true, false]) {
        const sys = new FakeSys();
        servicesObey(sys);
        quietBox(sys);
        launchd(sys, { ...loaded });
        const { now, was } = installs(same);
        const d = { sys, paths: paths(tempRoot(), testBox(OLD)), uid: 0, say: () => {}, ask: async () => "yes" };
        expect(await restartServices(d, now, was)).toBeUndefined();
        expect(kicks(sys)).toEqual([`kickstart -k system/${guard}`, ...(same ? [] : [`kickstart -k system/${ts}`])]);
      }
    }
  });

  test("a restart that fails is said, with what it means", async () => {
    const sys = new FakeSys();
    servicesObey(sys);
    quietBox(sys);
    launchd(sys, { [`system/${GUARD_LABEL}`]: 1 });
    sys.responders.unshift((cmd, args) => (cmd === "/bin/launchctl" && args[0] === "kickstart" ? { code: 5, stdout: "", stderr: "" } : undefined));
    const { now, was } = installs(true);
    const d = { sys, paths: paths(tempRoot(), testBox()), uid: 0, say: () => {}, ask: async () => "yes" };
    expect(await restartServices(d, now, was)).toBe("the guard didn't restart, so it runs the newer code until the Mac restarts.");
  });

});

describe("the install kept for undo", () => {
  test("an update to the commit already installed keeps the install kept for undo", () => {
    expect(keepsKept("abc", "abc", "/opt/taskbox-v221")).toBe(true);
    expect(keepsKept("abc", "def", "/opt/taskbox-v221")).toBe(false);
    expect(keepsKept("abc", "abc", undefined)).toBe(false);
    expect(keepsKept(undefined, "abc", undefined)).toBe(false);
  });
});

describe("between the two updates that move the names: what the owner is told", () => {
  const ctx = (sys: FakeSys, prefix?: string) => ({ sys, cfg: CFG, paths: paths(tempRoot(), testBox(prefix)), uid: 0, serviceUid: 502, rootUid: process.getuid!() });

  test("check says to update once more while the services run under their old names", async () => {
    const sys = new FakeSys();
    servicesObey(sys);
    quietBox(sys);
    const c = ctx(sys, OLD);
    mkdirSync(join(c.paths.guardPlist, ".."), { recursive: true });
    writeFileSync(join(c.paths.guardPlist, "..", `${old.guard}.plist`), "<plist/>");
    const r = await serviceNamesRow(c);
    expect(r.status).toBe("FAIL");
    expect(r.detail).toContain("type taskbox update once more");
    expect((await serviceNamesRow(ctx(sys))).status).toBe("OK");
    const moved = ctx(sys, OLD);
    expect((await serviceNamesRow(moved)).status).toBe("OK");
    expect(CHECK_EXTRA.map(([n]) => n)).toContain("Service names");
  });

  test("between the updates, the Tailscale row checks tailscaled under its old name, and passes", async () => {
    const sys = new FakeSys();
    servicesObey(sys);
    quietBox(sys);
    const c = ctx(sys, OLD);
    const app = join(c.paths.app, "launchd");
    mkdirSync(app, { recursive: true });
    mkdirSync(join(c.paths.tailscaledPlist, ".."), { recursive: true });
    writeFileSync(join(app, `${old.tailscaled}.plist`), "<plist>ts</plist>");
    writeFileSync(join(c.paths.tailscaledPlist, "..", `${old.tailscaled}.plist`), "<plist>ts</plist>");
    sys.responders.unshift((cmd, args) => {
      if (cmd === c.paths.tailscale && args.includes("serve")) return { code: 0, stdout: "null", stderr: "" };
      if (cmd === c.paths.tailscale && args.includes("prefs")) return { code: 0, stdout: JSON.stringify({ RunSSH: true, CorpDNS: false, RouteAll: false, RunWebClient: false }), stderr: "" };
      if (cmd === c.paths.tailscale && args.includes("status")) return { code: 0, stdout: JSON.stringify({ BackendState: "Running", Self: { Tags: ["tag:taskbox"] } }), stderr: "" };
      if (cmd === "/bin/launchctl" && args[0] === "print") {
        if (args[1] !== `system/${old.tailscaled}`) return { code: 113, stdout: "", stderr: "" };
        return { code: 0, stdout: "\tenvironment = {\n\t\tTS_SSH_DISABLE_FORWARDING => true\n\t\tTS_SSH_DISABLE_SFTP => true\n\t\tSHELL => /opt/taskbox/bin/taskbox-shell\n\t}\n", stderr: "" };
      }
      return undefined;
    });
    mkdirSync(dirname(c.paths.tailscaledLog), { recursive: true });
    writeFileSync(c.paths.tailscaledLog, "", { mode: 0o640 });
    socketDirOk({ sys, paths: c.paths });
    const r = await tailscaleRow(c);
    expect([r.status, r.detail]).toEqual(["OK", "signed in as tag:taskbox, with Tailscale SSH, under its old name"]);
    // A different old-named plist from the install's own copy still fails.
    writeFileSync(join(c.paths.tailscaledPlist, "..", `${old.tailscaled}.plist`), "<plist>other</plist>");
    expect((await tailscaleRow(c)).detail).toContain("tailscaled's LaunchDaemon isn't taskbox's");
  });

  test("a daemon that won't stop is an owner step, and says what is true", async () => {
    const sys = new FakeSys();
    servicesObey(sys);
    quietBox(sys);
    sys.sleep = async () => {};
    launchd(sys, { [`system/${old.tailscaled}`]: 101 }, { lingers: { [`system/${old.tailscaled}`]: 999 } });
    const p = paths(tempRoot(), testBox(OLD));
    mkdirSync(join(p.guardPlist, ".."), { recursive: true });
    const e = await retirePrevious({ sys, paths: p, say: () => {} }, OLD).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Stop);
    expect((e as Stop).owner).toBe(true);
    expect((e as Stop).message).not.toContain("runs as before");
  });

  test("the old tailscale address only counts in the copy whose repo it names", () => {
    const own = { org: "example-org", repo: "taskbox" };
    const url = "https://api.github.com/repos/example-org/taskbox/releases/assets/7";
    expect(tailscaleUrlProblem(undefined, own, 7)).toBe(false);
    expect(tailscaleUrlProblem(url, own, 7)).toBe(false);
    expect(tailscaleUrlProblem(url, own, 8)).toBe(true);
    expect(tailscaleUrlProblem(url, { org: "another-org", repo: "taskbox" }, 9)).toBe(false);
    expect(tailscaleUrlProblem(url, { org: "example-org", repo: "taskbox-fork" }, 9)).toBe(false);
  });

  test("each new plist is written before its old one goes, so a power cut never leaves neither", async () => {
    const sys = new FakeSys();
    servicesObey(sys);
    quietBox(sys);
    launchd(sys, { [`system/${old.guard}`]: 1, [`system/${old.tailscaled}`]: 2 });
    const p = paths(tempRoot(), testBox(OLD));
    const app = join(p.app, "launchd");
    mkdirSync(app, { recursive: true });
    for (const l of [AGENT_LABEL, GUARD_LABEL, TAILSCALED_LABEL]) writeFileSync(join(app, `${l}.plist`), `<plist>${l}</plist>`);
    for (const f of [p.guardPlist, p.agentPlist]) mkdirSync(join(f, ".."), { recursive: true });
    for (const [f, l] of [[p.guardPlist, old.guard], [p.tailscaledPlist, old.tailscaled], [p.agentPlist, old.loop]] as const) writeFileSync(join(f, "..", `${l}.plist`), "<plist>old</plist>");
    // What reaches the disk, in order.
    const order: string[] = [];
    const [write, rm] = [fs.writeFileSync, fs.rmSync] as unknown as ((...a: unknown[]) => void)[];
    const w = spyOn(fs, "writeFileSync").mockImplementation(((...a: unknown[]) => (order.push(`write ${basename(String(a[0]))}`), write!(...a))) as never);
    const r = spyOn(fs, "rmSync").mockImplementation(((...a: unknown[]) => (order.push(`rm ${basename(String(a[0]))}`), rm!(...a))) as never);
    try {
      await retirePrevious({ sys, paths: p, say: () => {} }, OLD);
    } finally {
      w.mockRestore();
      r.mockRestore();
    }
    for (const [f, l] of [[p.guardPlist, GUARD_LABEL], [p.tailscaledPlist, TAILSCALED_LABEL], [p.agentPlist, AGENT_LABEL]] as const) expect(readFileSync(f, "utf8")).toBe(`<plist>${l}</plist>`);
    for (const [now, then] of [[GUARD_LABEL, old.guard], [TAILSCALED_LABEL, old.tailscaled], [AGENT_LABEL, old.loop]]) {
      expect(order.indexOf(`write ${now}.plist`)).toBeGreaterThan(-1);
      expect(order.indexOf(`write ${now}.plist`)).toBeLessThan(order.indexOf(`rm ${then}.plist`));
    }
  });
});
