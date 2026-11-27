// Before v2.4.2, the Softnet-as-root check halted a box. It read every Softnet on the box, and with two
// VMs at once it caught the other VM's Softnet in the moment it runs as root before it drops to the service account.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { computeState, softnetFix } from "../src/state.ts";
import { etimeSeconds, rootSoftnets, SOFTNET_CHECK_TRIES, SOFTNET_DROP_GRACE_S, softnetAsRoot, softnetRootProblem } from "../src/tart.ts";
import { FakeSys } from "./fake.ts";

const SOFTNET = "/opt/taskbox/bin/softnet";
// The service account (accounts.service) of the box the fixture was captured on.
const SERVICE = "ci";
function psSys(frames: (string | null)[]) {
  const sys = new FakeSys();
  let i = 0;
  const slept: number[] = [];
  sys.responders.unshift((cmd) => {
    if (cmd !== "/bin/ps") return undefined;
    const f = frames[Math.min(i++, frames.length - 1)];
    return f === null ? { code: 1, stdout: "", stderr: "ps failed" } : { code: 0, stdout: f!, stderr: "" };
  });
  const orig = sys.sleep.bind(sys);
  sys.sleep = async (ms: number) => (slept.push(ms), orig(ms));
  return { sys, slept, reads: () => i };
}
// By default a Softnet ci started: its real user is ci, whatever its effective one.
const line = (pid: number, etime: string, user: string, ruser = "ci", comm = SOFTNET, svuid = user === "root" ? 0 : 501) => `${pid} ${etime} ${user} ${ruser} ${svuid} ${comm}`;
// launchd is always in ps's output, so a read with no line that parses can't be a real one.
const LAUNCHD = line(1, "14-19:39:02", "root", "root", "/sbin/launchd");

describe("Softnet as root", () => {
  test("etime reads in every shape ps prints", () => {
    expect(etimeSeconds("00:05")).toBe(5);
    expect(etimeSeconds("01:02")).toBe(62);
    expect(etimeSeconds("1:00:00")).toBe(3600);
    expect(etimeSeconds("2-03:04:05")).toBe(2 * 86400 + 3 * 3600 + 4 * 60 + 5);
    expect(etimeSeconds("soon")).toBeUndefined();
  });
  test("only a Softnet ci started that runs as root counts, by its effective or saved user ID", async () => {
    const { sys } = psSys([[LAUNCHD, line(10, "05:00", "ci"), line(11, "00:03", "root", "ci"), line(12, "09:00", "ci", "root"), line(13, "09:00", "root", "ci", "/usr/sbin/notsoftnetd"), line(14, "09:00", "root", "ci", "/bin/zsh"), line(15, "09:00", "ci", "ci", SOFTNET, 0)].join("\n")]);
    expect((await rootSoftnets(sys, SERVICE))!.map((p) => p.pid)).toEqual([11, 15]);
  });
  test("the real user counted is the box's own service account, by its configured name (v2.7.0)", async () => {
    const { sys } = psSys([[LAUNCHD, line(20, "00:30", "root", "ci"), line(21, "00:30", "root", "taskbox"), line(22, "00:30", "root", "taskbox-agent")].join("\n")]);
    expect((await rootSoftnets(sys, "taskbox"))!.map((p) => p.pid)).toEqual([21]);
  });
  test("a real ps line of taskbox's Softnet, still root, is counted (fixture from a Tart rerun)", async () => {
    const real = readFileSync(new URL("./fixtures/ps-softnet.txt", import.meta.url), "utf8");
    const { sys } = psSys([[LAUNCHD, real].join("\n")]);
    expect(await rootSoftnets(sys, SERVICE)).toEqual([{ pid: 1910, ageS: 1, line: "pid 1910, running 00:01, user root, real user ci, saved ID 0" }]);
  });
  test("no Softnet as root passes at once", async () => {
    const { sys, slept } = psSys([[line(10, "05:00", "ci")].join("\n")]);
    expect(await softnetAsRoot(sys, SERVICE)).toBe(false);
    expect(slept).toEqual([]);
  });
  test("a Softnet still root past its grace fails at once, even beside a young one", async () => {
    const { sys, slept } = psSys([[line(10, "00:30", "root"), line(11, "00:02", "root")].join("\n")]);
    expect(await softnetAsRoot(sys, SERVICE)).toBe(true);
    expect(slept).toEqual([]);
  });
  test("another VM's Softnet mid-start is waited out, and passes once it drops (the taskbox-1 halt)", async () => {
    const { sys, slept } = psSys([[line(10, "02:10", "ci"), line(11, "00:04", "root")].join("\n"), [line(10, "02:27", "ci"), line(11, "00:21", "ci")].join("\n")]);
    expect(await softnetAsRoot(sys, SERVICE)).toBe(false);
    expect(slept).toEqual([(SOFTNET_DROP_GRACE_S - 4 + 1) * 1000]);
  });
  test("a young Softnet that is still root once its grace has passed fails", async () => {
    const { sys } = psSys([line(11, "00:04", "root"), line(11, "00:21", "root")]);
    expect(await softnetAsRoot(sys, SERVICE)).toBe(true);
  });
  test("an age it can't read, or ps failing, fails this VM, never the box", async () => {
    for (const frame of [line(11, "later", "root"), null]) {
      const p = await softnetRootProblem(psSys([frame]).sys, SERVICE);
      expect(p?.halt).toBe(false);
      expect(p?.why).toStartWith("taskbox couldn't tell");
    }
  });
  test("new Softnets starting each read: it gives up waiting after its tries, and that VM's own check reads them", async () => {
    const { sys, reads } = psSys([line(11, "00:01", "root"), line(12, "00:01", "root"), line(13, "00:01", "root"), line(14, "00:01", "root")]);
    expect(await softnetAsRoot(sys, SERVICE)).toBe(false);
    expect(reads()).toBe(SOFTNET_CHECK_TRIES);
  });
  test("a ps that throws, or whose output no longer parses, fails this VM, never the box", async () => {
    const sys = new FakeSys();
    sys.responders.unshift((cmd) => (cmd === "/bin/ps" ? (() => { throw new Error("timed out"); })() : undefined));
    for (const s of [sys, psSys(["PID ETIME USER\nsomething else entirely"]).sys, psSys([""]).sys]) {
      const p = await softnetRootProblem(s, SERVICE);
      expect(p?.halt).toBe(false);
      expect(p?.why).toBe("taskbox couldn't tell whether Softnet dropped root: ps couldn't be read");
    }
  });
  test("a command path with a space still parses, and a Softnet that isn't taskbox's isn't counted", async () => {
    const { sys } = psSys([[LAUNCHD, line(20, "05:00", "root", "ci", "/Applications/My Tools/softnet")].join("\n")]);
    expect(await rootSoftnets(sys, SERVICE)).toEqual([]);
  });
  test("taskbox's Softnet counts in its folder, in bin, and by its install folder's own name", async () => {
    const paths = ["/opt/taskbox/softnet/softnet", "/opt/taskbox/bin/softnet", "/opt/taskbox-0123456789ab-AbC123/softnet/softnet", "/opt/taskbox/softnet/softnet-x", "/opt/taskboxes/softnet/softnet"];
    const { sys } = psSys([[LAUNCHD, ...paths.map((p, i) => line(30 + i, "05:00", "root", "root", p))].join("\n")]);
    expect((await rootSoftnets(sys, SERVICE))!.map((p) => p.pid)).toEqual([30, 31, 32]);
  });
  test("another account's root process started under taskbox's Softnet name isn't counted", async () => {
    // Such as sudo, setuid root, held at its password prompt, started with that name.
    const { sys } = psSys([[LAUNCHD, line(40, "05:00", "root", "visitor", "/opt/taskbox/softnet/softnet")].join("\n")]);
    expect(await rootSoftnets(sys, SERVICE)).toEqual([]);
  });
  test("with two young root Softnets, it waits until the youngest is past its grace", async () => {
    const { sys, slept } = psSys([[LAUNCHD, line(11, "00:04", "root"), line(12, "00:09", "root")].join("\n"), LAUNCHD]);
    expect(await softnetAsRoot(sys, SERVICE)).toBe(false);
    expect(slept).toEqual([(SOFTNET_DROP_GRACE_S - 4 + 1) * 1000]);
  });
  test("the problem names the process, and the owner is told how to run jobs again", async () => {
    const why = await softnetRootProblem(psSys([[LAUNCHD, line(77, "03:00", "root")].join("\n")]).sys, SERVICE);
    expect(why).toEqual({ why: "Softnet runs as root (pid 77, running 03:00, user root, real user ci, saved ID 0)", halt: true });
    const s = computeState({ now: 0, loop: { failing: `${why!.why}, so the loop stopped and starts no VM` } } as never);
    expect(s.word).toBe("Failing");
    expect(s.next).toBe(softnetFix());
    expect(s.notify).toBe(true);
    expect(computeState({ now: 0, loop: { failing: "the loop stopped: something else" } } as never).notify).toBe(false);
  });
});
