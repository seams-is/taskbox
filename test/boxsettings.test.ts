import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBoxFile } from "../src/boxsettings.ts";
import { loadConfig, sourceOf } from "../src/config.ts";
import { CFG } from "./helpers.ts";

const me = process.getuid!();
const SOURCE = { type: "github-actions" as const, appId: 5150, repos: ["example-org/app"], app: "example-org-box-jobs" };

// A release folder with taskbox.json, and a state folder for box.json, both in a temp folder.
function setup(release: object, box?: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "taskbox-boxset-"));
  writeFileSync(join(dir, "taskbox.json"), JSON.stringify(release));
  const state = join(dir, "state");
  mkdirSync(state, { mode: 0o755 });
  chmodSync(state, 0o755);
  const file = join(state, "box.json");
  if (box !== undefined) writeFileSync(file, typeof box === "string" ? box : JSON.stringify(box), { mode: 0o644 });
  return { dir, file };
}

describe("the box file", () => {
  test("missing is no settings", () => {
    const { file } = setup(CFG);
    expect(readBoxFile(file, me)).toEqual({});
  });

  test("a link, a file others can write, or one not root's is set aside with a reason", () => {
    expect(readBoxFile(setup(CFG, "not json").file, me).problem).toBe("box.json isn't JSON");
    const open = setup(CFG, { sources: [SOURCE] });
    chmodSync(open.file, 0o666);
    expect(readBoxFile(open.file, me).problem).toBe("box.json isn't root's alone");
    expect(readBoxFile(setup(CFG, { sources: [SOURCE] }).file, me + 1).problem).toMatch(/isn't root's alone/);
    const linked = setup(CFG);
    writeFileSync(join(linked.dir, "elsewhere.json"), JSON.stringify({ sources: [SOURCE] }));
    symlinkSync(join(linked.dir, "elsewhere.json"), linked.file);
    expect(readBoxFile(linked.file, me).problem).toBe("box.json can't be read");
  });
});

describe("layering", () => {
  test("the box's source wins, and the release's actionsAppId from before never meets it", () => {
    const { dir, file } = setup({ ...CFG, actionsAppId: 4242 }, { sources: [SOURCE] });
    const c = loadConfig(dir, file, me);
    expect(sourceOf(c)).toEqual(SOURCE);
    expect(c.actionsAppId).toBeUndefined();
    expect(c.boxKeys).toEqual(["sources"]);
    expect(c.boxProblem).toBeUndefined();
  });

  test("a box file that fails once layered never stops loadConfig: the release's settings are used, and the reason kept", () => {
    // A source for another repo than the release's jobsFrom, as after a release that changed it.
    const { dir, file } = setup(CFG, { sources: [{ ...SOURCE, repos: ["example-org/other"] }] });
    const c = loadConfig(dir, file, me);
    expect(sourceOf(c)).toEqual({ type: "none" });
    expect(c.boxProblem).toMatch(/^with box.json, a github-actions source's repos names jobsFrom/);
  });

  test("a key the box file may not hold is passed over alone: its source is still used", () => {
    const { dir, file } = setup(CFG, { sources: [SOURCE], image: "x", accounts: { service: "taskbox" } });
    const c = loadConfig(dir, file, me);
    expect(sourceOf(c)).toEqual(SOURCE);
    expect(c.image).toBe(CFG.image);
    expect(c.boxKeys).toEqual(["sources"]);
    expect(c.boxIgnored).toEqual(["box.json: image", "box.json: accounts"]);
    expect(c.boxProblem).toBeUndefined();
  });

  test("disconnect's none is a source of its own: the release's is ignored", () => {
    const { dir, file } = setup({ ...CFG, sources: [{ type: "github-actions", appId: 4242, repos: ["example-org/app"] }] }, { sources: [{ type: "none" }] });
    expect(sourceOf(loadConfig(dir, file, me))).toEqual({ type: "none" });
  });

  test("a release's file can't claim what taskbox sets", () => {
    const { dir } = setup({ ...CFG, boxKeys: ["sources"] });
    expect(() => loadConfig(dir)).toThrow(/set by taskbox/);
  });
});
