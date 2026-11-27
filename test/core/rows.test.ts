import { describe, expect, test } from "bun:test";
import { AWAY_ONLY } from "../../src/away.ts";
import { CHECK_EXTRA, type CheckContext, INSTALL_PREFLIGHT, PRESTART } from "../../src/checks.ts";
import { type Row, rowsFor, rowsProblem } from "../../src/core/rows.ts";
import { TEST_REPO_ROW } from "../../src/loadcmd.ts";
import { SECOND_KEY_ROW } from "../../src/queue.ts";
import { allRows, rows } from "../../src/rows/index.ts";
import { CFG } from "../helpers.ts";

const names = (l: [string, unknown][]) => l.map(([n]) => n);
const ctx = (load = false) => ({ cfg: { ...CFG, ...(load ? { sources: [{ type: "github-actions", appId: 4242, repos: [CFG.jobsFrom, { name: "example-org/load", role: "load", runnerGroup: "taskbox-load" }] }] } : {}) } }) as unknown as CheckContext;

describe("the check-row registry", () => {
  test("each place holds v2's rows in v2's order", () => {
    expect(names(rows("prestart"))).toEqual(names(PRESTART));
    // v3 adds the beats and the guard's passes after the Screen Sharing guard's (rows/away.ts, rows/guard.ts).
    const extra = names(CHECK_EXTRA);
    extra.splice(extra.indexOf("Screen Sharing guard") + 1, 0, "Guard beat", "Key broker beat", "Guard passes", "Op deadlines", "Loop clock");
    // And the access model's two (rows/accounts.ts).
    extra.splice(extra.indexOf("Service account") + 1, 0, "Accounts");
    extra.splice(extra.indexOf("Tailscale") + 1, 0, "Tailnet policy");
    expect(names(rows("check", ctx()))).toEqual([...names(PRESTART), ...extra, SECOND_KEY_ROW, "Sizes", "Tool cache", "Screen Sharing and VM starts", "Workspaces"]);
    expect(names(rows("away", ctx()))).toEqual([...names(AWAY_ONLY), ...names(PRESTART), ...extra]);
    expect(names(rows("preflight"))).toEqual(names(INSTALL_PREFLIGHT));
  });
  test("the test repo's row shows only with a load repo", () => {
    expect(names(rows("check", ctx(true)))).toContain(TEST_REPO_ROW);
    expect(names(rows("check", ctx()))).not.toContain(TEST_REPO_ROW);
    expect(names(rows("check"))).not.toContain(TEST_REPO_ROW);
  });
  test("the same function runs as before", () => {
    const fn = PRESTART.find(([n]) => n === "FileVault")![1];
    expect(rows("prestart").find(([n]) => n === "FileVault")![1]).toBe(fn);
  });
  test("every row is valid where it runs", () => {
    expect(rowsProblem(allRows())).toBeUndefined();
  });
  test("a later package's row takes its place between two, with no edit to v2's lists", () => {
    const fn: Row["fn"] = async () => ({ status: "OK", detail: "" });
    const mine: Row = { name: "Accounts", fn, order: 2005, in: ["check", "away"] };
    const list = rowsFor([...allRows(), mine], "check", ctx());
    const i = names(list).indexOf("Accounts");
    expect(names(list)[i - 1]).toBe(CHECK_EXTRA[0]![0]);
    expect(names(list)[i + 1]).toBe(CHECK_EXTRA[1]![0]);
  });
  test("a name or a number twice in one place is refused", () => {
    const fn: Row["fn"] = async () => ({ status: "OK", detail: "" });
    expect(rowsProblem([{ name: "A", fn, order: 1, in: ["check"] }, { name: "A", fn, order: 2, in: ["check"] }])).toContain("named A");
    expect(rowsProblem([{ name: "A", fn, order: 1, in: ["check"] }, { name: "B", fn, order: 1, in: ["check"] }])).toContain("place 1");
    expect(rowsProblem([{ name: "A", fn, order: 1, in: ["check"] }, { name: "A", fn, order: 1, in: ["preflight"] }])).toBeUndefined();
  });
});
