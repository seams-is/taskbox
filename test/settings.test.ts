// The settings' layers: the code's defaults, the product file, the box's overlay, then box.json, each
// over the last for the keys its class lets it hold. A key outside its layer's class is passed over
// alone, and a layer that fails is set aside with the rest kept.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { boxSettingsRow, type CheckContext } from "../src/checks.ts";
import { awayOf, DEFAULT_AWAY, DEFAULT_TIMINGS, forKind, sourceOf, timingsOf } from "../src/config.ts";
import { classOf, KEY_CLASSES } from "../src/settings/classes.ts";
import { layeredConfig } from "../src/settings/layers.ts";
import { CFG } from "./helpers.ts";

const LINUX = { label: "taskbox-linux", image: `ghcr.io/cirruslabs/ubuntu-runner-arm64@sha256:${"1".repeat(64)}`, vmCpus: 4, vmMemoryMB: 8192 };
const PRODUCT = { ...CFG, linux: LINUX, vmsAtOnce: 2 } as unknown as Record<string, unknown>;
const SOURCE = { type: "github-actions" as const, appId: 5150, repos: ["example-org/app"], app: "example-org-box-jobs" };
const overlay = (settings: Record<string, unknown>) => ({ name: "boxes/taskbox-1.json", settings });

describe("the layers", () => {
  test("the code's defaults stand under every file: a file sets only what it names", () => {
    const c = layeredConfig(PRODUCT, {});
    expect(timingsOf(c)).toEqual(DEFAULT_TIMINGS);
    expect(awayOf(c)).toEqual(DEFAULT_AWAY);
    const t = layeredConfig({ ...PRODUCT, timings: { floorMinutes: 20 }, away: { githubFailures: 5 } }, {});
    expect(timingsOf(t)).toEqual({ ...DEFAULT_TIMINGS, floorMinutes: 20 });
    expect(awayOf(t)).toEqual({ ...DEFAULT_AWAY, githubFailures: 5 });
  });

  // Each row: the layers, then a key's value as the settings in force read it.
  const rows: [string, { overlay?: Record<string, unknown>; box?: Record<string, unknown> }, (c: ReturnType<typeof layeredConfig>) => unknown, unknown][] = [
    ["the product file alone", {}, (c) => c.vmsAtOnce, 2],
    ["the overlay over the product file", { overlay: { vmsAtOnce: 1, runnerNamePrefix: "box-2" } }, (c) => [c.vmsAtOnce, c.runnerNamePrefix], [1, "box-2"]],
    ["a nested box key in the overlay, the rest of its object kept", { overlay: { linux: { vmMemoryMB: 4096 } } }, (c) => forKind(c, "linux").vmMemoryMB === 4096 && forKind(c, "linux").label === LINUX.label, true],
    ["the overlay's accounts", { overlay: { accounts: { service: "runner", agent: "runner-agent", people: [] } } }, (c) => c.accounts.service, "runner"],
    ["box.json's source over the product file's", { box: { sources: [SOURCE] } }, (c) => sourceOf(c), SOURCE],
    ["box.json over the overlay over the product file", { overlay: { vmsAtOnce: 1 }, box: { sources: [{ type: "none" }] } }, (c) => [c.vmsAtOnce, sourceOf(c).type], [1, "none"]],
  ];
  for (const [name, layers, read, want] of rows) {
    test(name, () => {
      const c = layeredConfig(PRODUCT, { ...(layers.overlay ? { overlay: overlay(layers.overlay) } : {}), ...(layers.box ? { box: { settings: layers.box } } : {}) });
      expect(read(c)).toEqual(want);
      expect(c.boxIgnored).toBeUndefined();
    });
  }

  test("a key outside its layer's class is passed over alone, and the rest of that layer is used", () => {
    const c = layeredConfig(PRODUCT, {
      overlay: overlay({ $comment: "taskbox-1", image: "ghcr.io/x/y@sha256:" + "2".repeat(64), linux: { image: "z", vmCpus: 2 }, sources: [SOURCE], someday: 1, vmsAtOnce: 1 }),
      box: { settings: { sources: [SOURCE], vmsAtOnce: 4, accounts: { service: "x" } } },
    });
    expect(c.image).toBe(CFG.image);
    expect(forKind(c, "linux").image).toBe(LINUX.image);
    expect(forKind(c, "linux").vmCpus).toBe(2);
    expect(c.vmsAtOnce).toBe(1);
    expect(sourceOf(c)).toEqual(SOURCE);
    expect(c.accounts.service).toBe(CFG.accounts.service);
    expect(c.boxIgnored).toEqual(["boxes/taskbox-1.json: image", "boxes/taskbox-1.json: linux.image", "boxes/taskbox-1.json: sources", "boxes/taskbox-1.json: someday", "box.json: vmsAtOnce", "box.json: accounts"]);
    expect(c.overlayKeys).toEqual(["linux.vmCpus", "vmsAtOnce"]);
    expect(c.boxKeys).toEqual(["sources"]);
  });

  test("a layer that fails is set aside, with the layers that pass kept and the reason said", () => {
    const c = layeredConfig(PRODUCT, { overlay: overlay({ vmMemoryMB: 100 }), box: { settings: { sources: [SOURCE] } } });
    expect(c.vmMemoryMB).toBe(CFG.vmMemoryMB);
    expect(c.overlayProblem).toBe("with boxes/taskbox-1.json, vmMemoryMB is 4096 to 24576");
    expect(sourceOf(c)).toEqual(SOURCE);
    const b = layeredConfig(PRODUCT, { overlay: overlay({ vmsAtOnce: 1 }), box: { settings: { sources: [{ ...SOURCE, repos: ["example-org/other"] }] } } });
    expect(b.vmsAtOnce).toBe(1);
    expect(b.boxProblem).toMatch(/^with box\.json, a github-actions source's repos names jobsFrom/);
    expect(sourceOf(b)).toEqual({ type: "none" });
  });

  test("the product file must pass on its own: nothing over it stands in for it", () => {
    const { vmMemoryMB: _, ...missing } = PRODUCT;
    expect(() => layeredConfig(missing, { overlay: overlay({ vmMemoryMB: 8192 }) })).toThrow("vmMemoryMB is 4096 to 24576");
  });

  test("no file sets what taskbox sets", () => {
    for (const k of ["boxIgnored", "overlayKeys", "overlayProblem"]) expect(() => layeredConfig({ ...PRODUCT, [k]: [] }, {})).toThrow(/set by taskbox/);
  });
});

describe("every key has a class", () => {
  test("each key in the example, nested keys too, has one", () => {
    const example = JSON.parse(readFileSync(join(import.meta.dir, "../taskbox.example.json"), "utf8")) as Record<string, unknown>;
    const missing: string[] = [];
    const walk = (o: Record<string, unknown>, at: string) => {
      for (const [k, v] of Object.entries(o)) {
        const path = at + k;
        if (k !== "$comment" && classOf(path) === undefined) missing.push(path);
        if (v && typeof v === "object" && !Array.isArray(v) && Object.keys(KEY_CLASSES).some((c) => c.startsWith(`${path}.`))) walk(v as Record<string, unknown>, `${path}.`);
      }
    };
    walk(example, "");
    expect(missing).toEqual([]);
  });

  test("a nested key takes its parent's class unless it has its own", () => {
    expect(classOf("linux")).toBe("product");
    expect(classOf("linux.image")).toBe("product");
    expect(classOf("linux.vmMemoryMB")).toBe("box");
    expect(classOf("accounts.people")).toBe("box");
    expect(classOf("sources")).toBe("local");
    expect(classOf("nothing")).toBeUndefined();
  });
});

describe("the Box settings row", () => {
  const row = (cfg: ReturnType<typeof layeredConfig>) => boxSettingsRow({ cfg, paths: { boxSettings: "/opt/taskbox-state/box.json" } } as unknown as CheckContext);

  test("a key passed over is a warning that names it; a layer set aside fails", async () => {
    expect(await row(layeredConfig(PRODUCT, { box: { settings: { sources: [SOURCE] } } }))).toEqual({ status: "OK", detail: "/opt/taskbox-state/box.json sets sources" });
    expect(await row(layeredConfig(PRODUCT, { box: { settings: { sources: [SOURCE], image: "x" } } }))).toEqual({ status: "WARN", detail: "passed over, since each is outside its layer's keys: box.json: image" });
    const failed = await row(layeredConfig(PRODUCT, { overlay: overlay({ vmMemoryMB: 100 }) }));
    expect(failed).toEqual({ status: "FAIL", detail: "this box's overlay is set aside, and the other layers are used: with boxes/taskbox-1.json, vmMemoryMB is 4096 to 24576" });
  });
});
