// dscl as macOS prints it. A key outside Open Directory's standard set, such as IsHidden or
// ShadowHashData, reads back as "dsAttrTypeNative:<key>: <value>", and a key that isn't there reads
// "No such key: <key>" with exit 0. The agent's install steps and its check row must read both.
import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { agentSteps, userKey } from "../src/accounts.ts";
import { agentRow, type CheckContext } from "../src/checks.ts";
import { paths, REMOTE_SHELL } from "../src/config.ts";
import { FakeSys } from "./fake.ts";
import { CFG, tempRoot, testBox } from "./helpers.ts";

const AGENT = "taskbox-agent";
const GUID = "00000000-0000-0000-0000-000000000471";
const NATIVE = new Set(["IsHidden", "ShadowHashData"]);

// One account's directory record, read and written the way macOS's dscl does.
function realDscl(attrs: Record<string, string>, stuck?: string): FakeSys {
  const sys = new FakeSys();
  sys.responders.unshift((cmd, args) => {
    const out = (stdout: string, code = 0) => ({ code, stdout, stderr: "" });
    if (cmd === "/usr/bin/id") return out("471\n");
    if (cmd === "/usr/sbin/dseditgroup") return out("", 67);
    if (cmd === "/usr/sbin/diskutil") return out("");
    if (cmd !== "/usr/bin/dscl") return undefined;
    const key = args[3]!;
    if (args[1] === "-read") {
      if (key === "GeneratedUID") return out(`GeneratedUID: ${GUID}\n`);
      if (attrs[key] === undefined) return out(`No such key: ${key}\n`);
      return out(`${NATIVE.has(key) ? "dsAttrTypeNative:" : ""}${key}: ${attrs[key]}\n`);
    }
    if (args[1] === "-create") {
      attrs[key] = args[4]!;
      return out("");
    }
    if (args[1] === "-delete") {
      if (key === stuck) return out("", 1);
      delete attrs[key];
      return out("");
    }
    return undefined;
  });
  return sys;
}

describe("dscl's own output", () => {
  test("the agent row is OK on an agent the install placed, with IsHidden read as dsAttrTypeNative", async () => {
    const root = tempRoot();
    const p = paths(root, testBox());
    mkdirSync(p.agentHome!, { recursive: true });
    const sys = realDscl({ IsHidden: "1", UserShell: REMOTE_SHELL, NFSHomeDirectory: p.agentHome!, Password: "*" });
    const c: CheckContext = { sys, cfg: CFG, paths: p, uid: 0, serviceUid: undefined, rootUid: process.getuid!() };
    expect(await agentRow(c)).toMatchObject({ status: "OK" });
  });

  test("the agent row still fails an agent on the login window, read as dsAttrTypeNative", async () => {
    const root = tempRoot();
    const p = paths(root, testBox());
    mkdirSync(p.agentHome!, { recursive: true });
    const sys = realDscl({ IsHidden: "0", UserShell: REMOTE_SHELL, NFSHomeDirectory: p.agentHome!, Password: "*" });
    const c: CheckContext = { sys, cfg: CFG, paths: p, uid: 0, serviceUid: undefined, rootUid: process.getuid!() };
    expect((await agentRow(c)).detail).toContain("shows on the login window");
  });

  test("the agent row reads YES as hidden, and a ShadowHashData root can read as a password", async () => {
    const root = tempRoot();
    const p = paths(root, testBox());
    mkdirSync(p.agentHome!, { recursive: true });
    const attrs = { IsHidden: "YES", UserShell: REMOTE_SHELL, NFSHomeDirectory: p.agentHome!, Password: "*" };
    const at = (uid: number, a: Record<string, string>): CheckContext => ({ sys: realDscl({ ...a }), cfg: CFG, paths: p, uid, serviceUid: undefined, rootUid: process.getuid!() });
    expect(await agentRow(at(0, attrs))).toMatchObject({ status: "OK" });
    expect((await agentRow(at(0, { ...attrs, ShadowHashData: "" }))).detail).toBe(`${AGENT} has a password. As your admin user, type taskbox update.`);
    // To any other user, dscl reads ShadowHashData as No such key, so it is read as root only.
    const other = at(502, { ...attrs, ShadowHashData: "" });
    expect(await agentRow(other)).toMatchObject({ status: "OK" });
    expect((other.sys as FakeSys).calls.some((c) => c.args.includes("ShadowHashData"))).toBe(false);
  });

  test("a long value on the line after its key reads as there", async () => {
    const sys = new FakeSys();
    sys.responders.unshift((cmd) => (cmd === "/usr/bin/dscl" ? { code: 0, stdout: "dsAttrTypeNative:ShadowHashData:\n 62706c69 73743030\n", stderr: "" } : undefined));
    expect(await userKey(sys, AGENT, "ShadowHashData")).toBe("62706c69 73743030");
    expect(await userKey(sys, AGENT, "IsHidden")).toBeUndefined();
  });

  const deps = (sys: FakeSys) => ({ sys, say: () => {}, ask: async () => "yes", tty: () => 0, chown: () => {}, again: "Type taskbox update again" });

  test("agentSteps: keys that aren't there read back as gone, with dscl's exit 0", async () => {
    const attrs: Record<string, string> = { UserShell: "/bin/zsh" };
    expect(await agentSteps(deps(realDscl(attrs)) as never, AGENT, REMOTE_SHELL, "/private/var/taskbox-taskbox-agent")).toBeUndefined();
    expect(attrs).toEqual({ UserShell: REMOTE_SHELL, Password: "*", IsHidden: "1", NFSHomeDirectory: "/private/var/taskbox-taskbox-agent" });
  });

  test("agentSteps: a ShadowHashData that won't delete, read back as dsAttrTypeNative, stops the install", async () => {
    const attrs: Record<string, string> = { AuthenticationAuthority: ";ShadowHash;", ShadowHashData: "<62706c69 73743030>" };
    const why = await agentSteps(deps(realDscl(attrs, "ShadowHashData")) as never, AGENT, REMOTE_SHELL, "/private/var/taskbox-taskbox-agent");
    expect(attrs.ShadowHashData).toBeDefined();
    expect(why).toContain("didn't delete taskbox-agent's ShadowHashData");
  });
});
