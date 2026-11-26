import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type CheckContext, serviceUnlocksDisk, consoleUsers, diskNeed, loginSessions, otherLogins, CHECK_EXTRA, PUBLIC_FIX, publicIPv4, runnerGroupRow, sessionOwners, sharingOff, tcpListeners } from "../src/checks.ts";
import { loadConfig, paths } from "../src/config.ts";
import { FakeSys, githubRoutes, json, NETSTAT_CLEAN } from "./fake.ts";
import { CFG, PEM, tempRoot, testBox, quietBox } from "./helpers.ts";

const HEAD = "Active Internet connections (including servers)\nProto Recv-Q Send-Q  Local Address          Foreign Address        (state)\n";

function box(netstat: string | null, probe: "refused" | "timeout" | "open" = "refused") {
  const sys = new FakeSys();
  quietBox(sys);
  sys.probe = probe;
  sys.responders.push((cmd) =>
    cmd === "/usr/sbin/netstat" ? (netstat === null ? { code: 1, stdout: "", stderr: "no" } : { code: 0, stdout: netstat, stderr: "" }) : undefined,
  );
  return { sys, cfg: CFG, paths: paths("/nonexistent", testBox()), uid: 0, serviceUid: undefined };
}

describe("sharing services off", () => {
  test("passes with stealth mode on: the box's own network address is never probed", async () => {
    const c = box(NETSTAT_CLEAN);
    const probed: string[] = [];
    c.sys.tcpProbe = async (host: string) => {
      probed.push(host);
      return host === "127.0.0.1" ? "refused" : "timeout";
    };
    expect((await sharingOff(c)).status).toBe("OK");
    expect([...new Set(probed)]).toEqual(["127.0.0.1"]);
  });

  test("fails when anything listens on a sharing port, on any address", async () => {
    for (const local of ["*.22", "*.7000", "172.20.10.7.5900", "::1.5000", "127.0.0.1.445", "*.3283", "fd90:9838:fed3:b.5900", "fe80::1%lo0.22"]) {
      const r = await sharingOff(box(`${HEAD}tcp46      0      0  ${local}                 *.*                    LISTEN\n`));
      expect(r.status).toBe("FAIL");
      // Screen Sharing's port is allowed only behind the guard, which isn't running here.
      expect(r.detail).toContain(local.endsWith(".5900") ? "Screen Sharing is on" : "listening");
    }
  });

  test("a sharing port that is only an outgoing connection is not a listener", async () => {
    const r = await sharingOff(box(`${HEAD}tcp4       0      0  172.20.10.7.5000       1.2.3.4.443            ESTABLISHED\n`));
    expect(r.status).toBe("OK");
  });

  test("fails closed when netstat can't be read", async () => {
    expect((await sharingOff(box(null))).status).toBe("FAIL");
    expect((await sharingOff(box("garbage"))).status).toBe("FAIL");
    expect((await sharingOff(box(null))).detail).toContain("(no)");
    // An empty table for root or ci fails too: only they decide this row.
    expect((await sharingOff(box(""))).status).toBe("FAIL");
    expect((await sharingOff({ ...box(""), uid: 502, serviceUid: 502 })).status).toBe("FAIL");
  });

  test("anyone else whose netstat sees no sockets, as over Tailscale SSH, gets a SKIP", async () => {
    expect(await sharingOff({ ...box(""), uid: 504, serviceUid: 502 })).toEqual({ status: "SKIP", detail: "run as taskbox to check" });
    // A failed or garbled netstat still fails for them.
    expect((await sharingOff({ ...box(null), uid: 504, serviceUid: 502 })).status).toBe("FAIL");
    expect((await sharingOff({ ...box("garbage"), uid: 504, serviceUid: 502 })).status).toBe("FAIL");
  });

  test("127.0.0.1 must still refuse each port", async () => {
    expect((await sharingOff(box(NETSTAT_CLEAN, "open"))).status).toBe("FAIL");
    expect((await sharingOff(box(NETSTAT_CLEAN, "timeout"))).status).toBe("FAIL");
  });

  test("reads macOS netstat lines", () => {
    expect(tcpListeners(`${HEAD}tcp46 0 0 *.8770 *.* LISTEN\ntcp4 0 0 127.0.0.1.631 *.* LISTEN\ntcp4 0 0 1.2.3.4.5 6.7.8.9.443 ESTABLISHED\n`)).toEqual([
      { address: "*", port: 8770 },
      { address: "127.0.0.1", port: 631 },
    ]);
  });
});

describe("restart password", () => {
  const LIST = (ids: string[]) => `Cryptographic users for disk3s1s1 (${ids.length} found)\n|\n${ids.map((i) => `+-- ${i}\n|   Type: Local Open Directory User\n|   Volume Owner: Yes\n`).join("")}`;
  const ctx = (ciId: string | null, users: string[] | null, fileVault = true) => {
    const c = box(NETSTAT_CLEAN);
    c.sys.responders.unshift((cmd) => {
      if (cmd === "/usr/bin/fdesetup") return { code: 0, stdout: fileVault ? "true\n" : "false\n", stderr: "" };
      if (cmd === "/usr/bin/dscl") return ciId ? { code: 0, stdout: `GeneratedUID: ${ciId}\n`, stderr: "" } : { code: 1, stdout: "", stderr: "no" };
      if (cmd === "/usr/sbin/diskutil") return users ? { code: 0, stdout: LIST(users), stderr: "" } : { code: 1, stdout: "", stderr: "no" };
      return undefined;
    });
    return c;
  };
  const ID = "8BA59B42-6A28-42C2-98F0-77A9E83EB03B";
  test("ci can unlock: one password", async () => {
    const r = await serviceUnlocksDisk(ctx(ID, ["AAAAAAAA-0000-0000-0000-000000000000", ID]));
    expect(r.status).toBe("OK");
    expect(r.detail).toContain("once");
  });
  test("ci can't unlock: FAIL with the fix", async () => {
    const r = await serviceUnlocksDisk(ctx(ID, ["AAAAAAAA-0000-0000-0000-000000000000"]));
    expect(r.status).toBe("FAIL");
    expect(r.detail).toContain("type taskbox unlock");
  });
  test("FileVault off: never OK, and points at the FileVault line", async () => {
    const r = await serviceUnlocksDisk(ctx(ID, [ID], false));
    expect(r.status).toBe("SKIP");
    expect(r.detail).toContain("FileVault line");
  });
  test("can't read either: FAIL with the fix, never OK", async () => {
    expect((await serviceUnlocksDisk(ctx(null, [ID]))).status).toBe("FAIL");
    expect((await serviceUnlocksDisk(ctx(ID, null))).status).toBe("FAIL");
  });
});

describe("a second user on the box", () => {
  test("who's console lines name each other logged-in user once, never ci", () => {
    const who = "ci       console  Nov 12 09:00\npat       console  Nov 12 10:00\npat       ttys000  Nov 12 10:05\nsam     ttys001  Nov 12 10:06\n";
    expect(consoleUsers(who, "ci")).toEqual(["pat"]);
    expect(consoleUsers("", "ci")).toEqual([]);
  });

  test("the person typing isn't listed as another user", async () => {
    const sys = new FakeSys();
    quietBox(sys);
    sys.responders.push((cmd) => (cmd === "/usr/bin/who" ? { code: 0, stdout: "ci console x\npat console x\nowner console x\n", stderr: "" } : undefined));
    expect(await otherLogins(sys, "ci", "owner")).toEqual(["pat"]);
  });

  test("the floor counts the image download until the image is held", () => {
    const root = tempRoot();
    const p = paths(root, testBox());
    mkdirSync(dirname(p.pull), { recursive: true });
    const cfg = { ...CFG, minFreeDiskGB: 60, imageGB: 77, imageName: "img 1" };
    const c = { sys: new FakeSys(), cfg, paths: p, uid: 502, serviceUid: 502 } as CheckContext;
    expect(diskNeed(c)).toEqual({ needGB: 137, imageGB: 77 });
    // A download that stops starts again, so what it has so far never counts.
    writeFileSync(p.pull, JSON.stringify({ image: "img 1", ref: CFG.image, state: "downloading", percent: 50 }));
    expect(diskNeed(c).needGB).toBe(137);
    writeFileSync(p.pull, JSON.stringify({ image: "img 1", ref: CFG.image, state: "ready" }));
    expect(diskNeed(c).needGB).toBe(60);
    // A new pin under the same name is not held.
    writeFileSync(p.pull, JSON.stringify({ image: "img 1", ref: "ghcr.io/x@sha256:other", state: "ready" }));
    expect(diskNeed(c).needGB).toBe(137);
    // A record from before refs were kept counts as held when its name matches.
    writeFileSync(p.pull, JSON.stringify({ image: "img 1", state: "ready" }));
    expect(diskNeed(c).needGB).toBe(60);
    // The loop's wait knows the image isn't held, whatever the record says.
    expect(diskNeed(c, 0, true).needGB).toBe(137);
    writeFileSync(p.pull, JSON.stringify({ image: "an older image", state: "ready" }));
    expect(diskNeed(c).needGB).toBe(137);
  });
});

describe("who is logged in", () => {
  const LW = "/System/Library/CoreServices/loginwindow.app/Contents/MacOS/loginwindow";
  const IDS = "_www 70\nci 501\npat 502\nowner 503\n";

  test("each user with a loginwindow process, never root's at the login screen, and never another program", () => {
    const ps = `    0 ${LW}\n  501 ${LW}\n  502 ${LW}\n  503 /usr/bin/loginwindowish\n  503 /bin/zsh\n`;
    expect(sessionOwners(ps, IDS)).toEqual(["ci", "pat"]);
    expect(sessionOwners("", IDS)).toEqual([]);
  });

  test("a user who switched out still counts, though who no longer lists them", async () => {
    const sys = new FakeSys();
    quietBox(sys);
    sys.responders.push((cmd) =>
      cmd === "/bin/ps" ? { code: 0, stdout: `  0 ${LW}\n  501 ${LW}\n  502 ${LW}\n`, stderr: "" }
      : cmd === "/usr/bin/dscl" ? { code: 0, stdout: IDS, stderr: "" }
      : cmd === "/usr/bin/who" ? { code: 0, stdout: "ci console x\n", stderr: "" }
      : undefined,
    );
    expect(await loginSessions(sys)).toEqual({ users: ["ci", "pat"], known: true, seenBy: { ci: "loginwindow and who", pat: "loginwindow" } });
  });

  test("the bare command name counts; two names on one ID both count; who alone counts and says so", async () => {
    expect(sessionOwners("  502 loginwindow\n", "pat 502\nUe2 502\n")).toEqual(["Ue2", "pat"]);
    const sys = new FakeSys();
    quietBox(sys);
    sys.responders.push((cmd) => (cmd === "/usr/bin/who" ? { code: 0, stdout: "pat console x\n", stderr: "" } : cmd === "/usr/bin/dscl" ? { code: 0, stdout: IDS, stderr: "" } : undefined));
    expect((await loginSessions(sys)).seenBy).toEqual({ pat: "who" });
  });

  test("the box config names only real user names, never ci, and refuses hold's old settings", () => {
    const dir = mkdtempSync(join(tmpdir(), "taskbox-cfg-"));
    const base = JSON.parse(readFileSync(join(import.meta.dir, "..", "taskbox.example.json"), "utf8"));
    const load = (v: Record<string, unknown>) => (writeFileSync(join(dir, "taskbox.json"), JSON.stringify({ ...base, ...v })), () => loadConfig(dir));
    // v2.2.0: hold is gone, so taskbox.json names nobody for it, and a file that still does is refused.
    expect("holdUsers" in base || "holdMaxHours" in base).toBe(false);
    for (const k of ["holdUsers", "holdMaxHours", "remoteHoldHoursPerDay"]) expect(load({ [k]: k === "holdUsers" ? ["pat"] : 4 })).toThrow(`${k} is gone`);
    expect(load({ screenSharingUsers: ["Ci"] })).toThrow("screenSharingUsers");
    expect(load({ remoteUser: "CI" })).toThrow("remoteUser");
    expect(load({ noVMWhileLoggedIn: ["pat"] })).toThrow("noVMWhileLoggedIn is gone");
    expect(load({ vmCpus: 12 })).toThrow("vmCpus");
    expect(load({ vmMemoryMB: 1024 })).toThrow("vmMemoryMB");
    expect(load({ jobTimeoutMinutes: 0 })).toThrow("jobTimeoutMinutes");
    expect([base.vmCpus, base.vmMemoryMB, base.jobTimeoutMinutes]).toEqual([4, 8192, 55]);
  });

  test("the image is pinned by digest, the form Tart caches it by", () => {
    const dir = mkdtempSync(join(tmpdir(), "taskbox-cfg-"));
    const base = JSON.parse(readFileSync(join(import.meta.dir, "..", "taskbox.example.json"), "utf8"));
    const load = (image: unknown) => (writeFileSync(join(dir, "taskbox.json"), JSON.stringify({ ...base, image })), () => loadConfig(dir));
    expect(load(base.image)().image).toBe(base.image);
    const digest = base.image.split("@")[1];
    for (const bad of ["ghcr.io/cirruslabs/macos-golden-gate-xcode:27.2", `ghcr.io/cirruslabs/x:27.2@${digest}`, `cirruslabs/x@${digest}`, `ghcr.io/x@sha256:abc`, 7, undefined]) expect(load(bad)).toThrow("pinned by digest");
  });
});

describe("the box's public address", () => {
  const sysWith = (body: string, status = 200) => {
    const sys = new FakeSys();
    quietBox(sys);
    sys.fetch = async () => new Response(body, { status });
    return sys;
  };
  test("reads Cloudflare's trace, and anything odd is null", async () => {
    expect(await publicIPv4(new FakeSys())).toBe("203.0.113.7");
    expect(await publicIPv4(sysWith("ip=198.51.100.4\n"))).toBe("198.51.100.4");
    expect(await publicIPv4(sysWith("ip=010.001.1.1\n"))).toBe("10.1.1.1");
    for (const body of ["ip=256.1.1.1", "ip=2001:db8::1", "ip=1.2.3.4 extra", "ip=1.2.3", "fl=1\n"]) expect(await publicIPv4(sysWith(body))).toBeNull();
    expect(await publicIPv4(sysWith("ip=1.2.3.4", 500))).toBeNull();
    const broken = new FakeSys();
    broken.fetch = async () => { throw new Error("offline"); };
    expect(await publicIPv4(broken)).toBeNull();
  });
  test("taskbox check has a row for it, with its fix", async () => {
    const row = CHECK_EXTRA.find(([n]) => n === "Public address")!;
    const sys = new FakeSys();
    quietBox(sys);
    const ctx = { sys, uid: 501, serviceUid: 501 } as unknown as CheckContext;
    // What each source said: the address for ci and root, only that it answered for anyone else.
    const both = (await row[1](ctx)) as { status: string; detail: string };
    expect(both.status).toBe("OK");
    expect(both.detail).toMatch(/^cloudflare-trace said \d+\.\d+\.\d+\.\d+; ipify said \d+\.\d+\.\d+\.\d+\. It is blocked for every VM$/);
    const remote = (await row[1]({ ...ctx, uid: 502 } as unknown as CheckContext)) as { detail: string };
    expect(remote.detail).toBe("cloudflare-trace said an address; ipify said an address. It is blocked for every VM");
    sys.publicIP = null;
    expect(await row[1](ctx)).toEqual({ status: "FAIL", detail: `${PUBLIC_FIX} (cloudflare-trace and ipify didn't answer)` });
    expect(PUBLIC_FIX).not.toContain("sudo");
  });
});

// The Runner group row: only the box's own runners, with its labels.
describe("the runner group row", () => {
  function group(runners: { name: string; labels: string[] }[]) {
    const root = tempRoot();
    const p = paths(root, testBox());
    mkdirSync(dirname(p.key), { recursive: true });
    writeFileSync(p.key, PEM);
    const sys = new FakeSys();
    githubRoutes(sys);
    sys.routes.unshift((method, url) =>
      method === "GET" && new URL(url).pathname === "/orgs/example-org/actions/runner-groups/7/runners"
        ? json({ total_count: runners.length, runners: runners.map((r, i) => ({ id: i + 1, name: r.name, labels: r.labels.map((name) => ({ name })) })) })
        : undefined,
    );
    const c: CheckContext = { sys, cfg: CFG, paths: p, uid: 0, serviceUid: 0, rootUid: 0 };
    return runnerGroupRow(c);
  }

  test("the box's own runners with its labels: OK", async () => {
    expect(await group([{ name: "taskbox-1-1-abc", labels: ["taskbox-macos"] }])).toEqual({ status: "OK", detail: "only this box's runners, with its labels" });
  });

  test("a runner the box didn't make, or one with a label the settings don't name: FAIL, each named", async () => {
    expect(await group([{ name: "someone-elses-runner", labels: ["taskbox-macos"] }])).toEqual({ status: "FAIL", detail: "The runner someone-elses-runner in the box's runner group wasn't made by this box" });
    const r = await group([
      { name: "taskbox-1-2-def", labels: ["taskbox-macos", "ubuntu-latest"] },
      { name: "other", labels: [] },
    ]);
    expect(r).toEqual({ status: "FAIL", detail: "The runner taskbox-1-2-def has the label ubuntu-latest, which this box's settings don't name. The runner other in the box's runner group wasn't made by this box" });
  });
});

describe("the AirPlay hint on the sharing row", () => {
  test("only 5000 and 7000 get AirPlay's fix; another sharing port doesn't", async () => {
    for (const [local, airplay] of [["*.5000", true], ["::1.7000", true], ["*.445", false], ["*.22", false], ["*.50000", false]] as const) {
      const r = await sharingOff(box(`${HEAD}tcp46      0      0  ${local}                 *.*                    LISTEN\n`));
      if (local === "*.50000") {
        expect(r.status).toBe("OK");
        continue;
      }
      expect(r.status).toBe("FAIL");
      expect(r.detail.includes("AirPlay Receiver is on")).toBe(airplay);
      expect(r.detail).not.toContain("taskbox update");
    }
  });
});
