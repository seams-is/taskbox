// Undo, then update: a release from before workspaces runs on a box that has the pool account. Its
// record code rewrites accounts.json with only the roles it knows. The pool and its group live in
// pool.json, which that code never reads or writes, so the next install still finds them taskbox's.
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { POOL_USER } from "../src/access.ts";
import { type AccountDeps, placePool, planPool, readRecord, writeRecord } from "../src/accounts.ts";
import { GATE_SHELL, paths } from "../src/config.ts";
import { type PoolRecord, readPoolRecord } from "../src/pin.ts";
import * as old from "./fixtures/old/accounts.ts";
import { Dir } from "./fake-dir.ts";
import { tempRoot, testBox } from "./helpers.ts";

const ME = process.getuid!();

function box() {
  const dir = new Dir().user("taskbox", { uid: 502, attrs: {} }).user("taskbox-agent", { uid: 470, attrs: {} }).user("pat", { uid: 503, attrs: {} });
  const p = paths(tempRoot(), testBox());
  mkdirSync(dirname(p.poolHome), { recursive: true });
  mkdirSync(dirname(p.cronDeny), { recursive: true });
  writeFileSync(p.cronDeny, "");
  writeFileSync(p.atDeny, "");
  const sys = dir.sys();
  // The older release adds a person to Screen Sharing's list with dseditgroup, which takes.
  sys.responders.push((cmd, args) => (cmd === "/usr/sbin/dseditgroup" && args.slice(0, 3).join(" ") === "-o edit -a" && args.at(-1) === "com.apple.access_screensharing" ? { code: 0, stdout: "", stderr: "" } : undefined));
  const d: AccountDeps = { sys, say: () => {}, ask: async () => "yes", tty: () => 0, chown: () => {}, rootUid: ME };
  return { dir, p, sys, d };
}

describe("a release from before workspaces, after an undo", () => {
  test("its Screen Sharing and remove rewrites of accounts.json leave pool.json as it was, and the next install still sees the pool as taskbox's", async () => {
    const { p, sys, d } = box();
    // The box with workspaces: the service and agent in accounts.json, the pool in pool.json.
    writeRecord(d, p.accountsRecord, { inUse: { service: "taskbox" }, made: { taskbox: { role: "service", uid: 502 }, "taskbox-agent": { role: "agent", uid: 470 } } });
    expect(await placePool(d, p, POOL_USER, POOL_USER, GATE_SHELL)).toBe(471);
    const before = readFileSync(p.poolRecord, "utf8");

    // The older release's install changes Screen Sharing's list, with its own code.
    const failed = await old.applyScreenSharing({ ...d } as old.AccountDeps, { make: false, add: ["pat"], drop: [], others: [], nested: false }, p.accountsRecord);
    expect(failed).toEqual([]);
    // Its remove keeps the record while an account is left, written as its removeAccounts writes it.
    const rec = old.readRecord(p.accountsRecord);
    old.writeRecord({ chown: () => {}, rootUid: 0 }, p.accountsRecord, { made: rec.made, screenSharing: { added: ["pat"] } });

    expect(readFileSync(p.poolRecord, "utf8")).toBe(before);
    expect(readRecord(p.accountsRecord).made).toEqual({ taskbox: { role: "service", uid: 502 }, "taskbox-agent": { role: "agent", uid: 470 } });
    // The update back: the pool is taskbox's, and nothing about it changes.
    expect(await planPool(sys, readPoolRecord(p.poolRecord, ME), POOL_USER, POOL_USER)).toEqual({ make: false });
    const n = sys.calls.length;
    expect(await placePool(d, p, POOL_USER, POOL_USER, GATE_SHELL)).toBe(471);
    expect(sys.calls.slice(n).filter((c) => c.cmd === "/usr/bin/dscl" && (c.args[1] === "-create" || c.args[1] === "-delete"))).toEqual([]);
    expect((readPoolRecord(p.poolRecord, ME) as PoolRecord).groups).toEqual({ [POOL_USER]: { gid: 470 } });
  });

  test("why: that code drops any role it doesn't know from accounts.json", async () => {
    const { p, d } = box();
    mkdirSync(dirname(p.accountsRecord), { recursive: true });
    writeFileSync(p.accountsRecord, JSON.stringify({ made: { taskbox: { role: "service", uid: 502 }, [POOL_USER]: { role: "pool", uid: 471 } }, groups: { [POOL_USER]: { gid: 471 } } }));
    await old.applyScreenSharing({ ...d } as old.AccountDeps, { make: false, add: ["pat"], drop: [], others: [], nested: false }, p.accountsRecord);
    const after = JSON.parse(readFileSync(p.accountsRecord, "utf8"));
    expect(Object.keys(after.made)).toEqual(["taskbox"]);
    expect(after.groups).toBeUndefined();
    // And this release never reads a pool entry from accounts.json.
    writeFileSync(p.accountsRecord, JSON.stringify({ made: { [POOL_USER]: { role: "pool", uid: 471 } } }));
    expect(readRecord(p.accountsRecord).made).toEqual({});
  });
});
