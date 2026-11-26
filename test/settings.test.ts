// The settings' layers: the code's defaults, the product file, then box.json for the keys of its
// class. A key outside the class is passed over alone, and a box.json that fails is set aside.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { boxSettingsRow, type CheckContext } from "../src/checks.ts";
import { awayOf, DEFAULT_AWAY, DEFAULT_TIMINGS, sourceOf, timingsOf } from "../src/config.ts";
import { classOf } from "../src/settings/classes.ts";
import { layeredConfig } from "../src/settings/layers.ts";
import { CFG } from "./helpers.ts";

const PRODUCT = { ...CFG, vmsAtOnce: 2 } as unknown as Record<string, unknown>;
const SOURCE = { type: "github-actions" as const, appId: 5150, repos: ["example-org/app"], app: "example-org-box-jobs" };
const box = (settings: Record<string, unknown>) => ({ settings });

describe("the layers", () => {
  test("the code's defaults stand under the product file: it sets only what it names", () => {
    const c = layeredConfig(PRODUCT);
    expect(timingsOf(c)).toEqual(DEFAULT_TIMINGS);
    expect(awayOf(c)).toEqual(DEFAULT_AWAY);
    const t = layeredConfig({ ...PRODUCT, timings: { floorMinutes: 20 }, away: { githubFailures: 5 } });
    expect(timingsOf(t)).toEqual({ ...DEFAULT_TIMINGS, floorMinutes: 20 });
    expect(awayOf(t)).toEqual({ ...DEFAULT_AWAY, githubFailures: 5 });
  });

  test("box.json's source is over the product file's", () => {
    const c = layeredConfig({ ...PRODUCT, sources: [{ type: "none" }] }, box({ sources: [SOURCE] }));
    expect(sourceOf(c)).toEqual(SOURCE);
    expect(c.boxKeys).toEqual(["sources"]);
    expect(c.boxIgnored).toBeUndefined();
  });

  test("a key outside box.json's class is passed over alone, and its source is still used", () => {
    const c = layeredConfig(PRODUCT, box({ $comment: "x", sources: [SOURCE], vmsAtOnce: 4, image: "x", someday: 1 }));
    expect(c.vmsAtOnce).toBe(2);
    expect(c.image).toBe(CFG.image);
    expect(sourceOf(c)).toEqual(SOURCE);
    expect(c.boxIgnored).toEqual(["vmsAtOnce", "image", "someday"]);
  });

  test("no key reaches an object's prototype: such keys are passed over, and nothing else changes", () => {
    const text = '{"sources":[],"__proto__":{"approverKey":"x"},"constructor":{"prototype":{"approverKey":"x"}},"sources.__proto__.approverKey":"x","prototype":1}';
    const c = layeredConfig(PRODUCT, box(JSON.parse(text) as Record<string, unknown>));
    expect(({} as { approverKey?: string }).approverKey).toBeUndefined();
    expect(Object.hasOwn(Object.prototype, "approverKey")).toBe(false);
    expect(c.approverKey).toBeUndefined();
    expect(c.boxIgnored).toEqual(["__proto__", "constructor", "sources.__proto__.approverKey", "prototype"]);
  });

  test("a box.json that fails over the product file is set aside, with the reason said", () => {
    const c = layeredConfig(PRODUCT, box({ sources: [{ ...SOURCE, repos: ["example-org/other"] }] }));
    expect(c.boxProblem).toMatch(/^with box\.json, a github-actions source's repos names jobsFrom/);
    expect(sourceOf(c)).toEqual({ type: "none" });
  });

  test("the product file must pass on its own: box.json can't stand in for it", () => {
    expect(() => layeredConfig({ ...PRODUCT, sources: [{ ...SOURCE, repos: ["example-org/other"] }] }, box({ sources: [SOURCE] }))).toThrow("repos names jobsFrom");
  });

  test("no file sets what taskbox sets", () => {
    expect(() => layeredConfig({ ...PRODUCT, boxIgnored: [] })).toThrow(/set by taskbox/);
  });
});

describe("every key has a class", () => {
  test("each key in the example has one", () => {
    const example = JSON.parse(readFileSync(join(import.meta.dir, "../taskbox.example.json"), "utf8")) as Record<string, unknown>;
    expect(Object.keys(example).filter((k) => k !== "$comment" && classOf(k) === undefined)).toEqual([]);
  });

  test("only taskbox's own keys have one", () => {
    expect(classOf("sources")).toBe("local");
    expect(classOf("image")).toBe("product");
    for (const k of ["nothing", "__proto__", "constructor", "toString", "linux.image"]) expect({ k, c: classOf(k) }).toEqual({ k, c: undefined });
  });
});

describe("the Box settings row", () => {
  const row = (cfg: ReturnType<typeof layeredConfig>) => boxSettingsRow({ cfg, paths: { boxSettings: "/opt/taskbox-state/box.json" } } as unknown as CheckContext);

  test("names the keys box.json sets, warns of each passed over, and fails with both when it is set aside", async () => {
    expect(await row(layeredConfig(PRODUCT, box({ sources: [SOURCE] })))).toEqual({ status: "OK", detail: "/opt/taskbox-state/box.json sets sources" });
    expect(await row(layeredConfig(PRODUCT, box({ sources: [SOURCE], image: "x" })))).toEqual({ status: "WARN", detail: "passed over, since box.json may hold only its own keys: image" });
    const failed = await row(layeredConfig(PRODUCT, box({ sources: [{ ...SOURCE, repos: ["example-org/other"] }], image: "x" })));
    expect(failed.status).toBe("FAIL");
    expect(failed.detail).toMatch(/is set aside, and the release's settings are used: with box\.json, .*\. Passed over, since box\.json may hold only its own keys: image\.$/);
  });
});
