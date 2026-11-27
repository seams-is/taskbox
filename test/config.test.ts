// taskbox.json: the settings for labels, sources, classes and timings (v2.4.0), and the keys an
// earlier release reads.
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { assetUrl, type Config, DEFAULT_TIMINGS, labelsFor, loadConfig, releaseRepoOf, sourceOf, timingsOf } from "../src/config.ts";
import { sourceLine } from "../src/ops.ts";
import { CFG, settingsText, tempRoot } from "./helpers.ts";

// The box's settings without its own job source, so each test sets the source it means.
const base = () => {
  const { sources: _, ...rest } = JSON.parse(settingsText());
  return rest;
};
function load(over: Record<string, unknown>, linux?: Record<string, unknown>, warn?: (line: string) => void): () => Config {
  const dir = tempRoot();
  const c = base();
  const merged = { ...c, ...over, ...(linux ? { linux: { ...c.linux, ...linux } } : {}) };
  writeFileSync(join(dir, "taskbox.json"), JSON.stringify(merged));
  return () => loadConfig(dir, undefined, 0, warn);
}

describe("the settings", () => {
  test("each kind's labels list starts with its label, holds its merge label, and no two kinds share one", () => {
    const c = load({})();
    expect(labelsFor(c, "macos")[0]).toBe(c.label);
    expect(load({ labels: ["taskbox-macos-merge", "taskbox-macos"] })).toThrow("labels starts with label");
    expect(load({ labels: ["taskbox-macos"] })).toThrow("labels includes mergeLabel");
    expect(load({}, { labels: ["taskbox-linux", "taskbox-linux-merge", "taskbox-macos"] })).toThrow("no two kinds share a label");
    expect(load({ labels: ["taskbox-macos", "taskbox-macos-merge", "self-hosted"] })).toThrow("every runner has");
    expect(load({ labels: ["taskbox-macos", "taskbox-macos-merge", "a;b"] })).toThrow("labels is 1 to 8");
    // Any label in GitHub's shape, beyond taskbox-: the code names none.
    expect(labelsFor(load({ labels: ["taskbox-macos", "taskbox-macos-merge", "ios-big"] })(), "macos")).toEqual(["taskbox-macos", "taskbox-macos-merge", "ios-big", "example-box-macos"]);
  });
  test("sources: one, github-actions on jobsFrom with its own App, or none; the old actionsAppId must agree", () => {
    const c = base();
    expect(sourceOf(load({ sources: [{ type: "none" }] })())).toEqual({ type: "none" });
    expect(sourceOf(load({ sources: [{ type: "github-actions", appId: 4242, repos: [c.jobsFrom] }] })())).toEqual({ type: "github-actions", appId: 4242, repos: [c.jobsFrom] });
    // The old setting alone still reads as a source.
    expect(sourceOf(load({ actionsAppId: 4242 })())).toEqual({ type: "github-actions", appId: 4242, repos: [c.jobsFrom] });
    expect(load({ actionsAppId: 1, sources: [{ type: "github-actions", appId: 4242, repos: [c.jobsFrom] }] })).toThrow("differ");
    expect(load({ sources: [{ type: "github-actions", appId: c.appId, repos: [c.jobsFrom] }] })).toThrow("never the first App's");
    expect(load({ sources: [{ type: "github-actions", appId: 4242, repos: ["other/repo"] }] })).toThrow("jobsFrom");
    expect(load({ sources: [{ type: "gitlab" }] })).toThrow("github-actions or none");
    expect(load({ sources: [{ type: "none" }, { type: "none" }] })).toThrow("one job source");
    expect(load({ sources: [{ type: "github-actions", appId: 4242, repos: [c.jobsFrom], token: "x" }] })).toThrow("no setting token");
  });
  test("classes: short names, never jobs, each with an event list, a label match or both", () => {
    expect(load({ classes: [{ name: "merge", when: { event: ["merge_group"] } }] })().classes).toHaveLength(1);
    expect(load({ classes: [{ name: "jobs", when: { event: ["merge_group"] } }] })).toThrow("never jobs");
    expect(load({ classes: [{ name: "merge", when: {} }] })).toThrow("needs when.event");
    expect(load({ classes: [{ name: "merge", when: { label: { contains: "x" } } }] })).toThrow("equals, startsWith or endsWith");
    expect(load({ classes: [{ name: "merge", when: { event: ["Merge Group"] } }] })).toThrow("event names");
  });
  test("classes refuse unknown keys, so a typo can't make a label-only rule; labels differ without case", () => {
    expect(load({ classes: [{ name: "merge", when: { events: ["merge_group"], label: { endsWith: "-merge" } } }] })).toThrow("when has no setting events");
    expect(load({ classes: [{ name: "merge", rank: 1, when: { event: ["merge_group"] } }] })).toThrow("has no setting rank");
    expect(load({ labels: ["taskbox-macos", "taskbox-macos-merge", "TASKBOX-MACOS"] })).toThrow("names a label twice");
    expect(load({}, { labels: ["taskbox-linux", "taskbox-linux-merge", "Taskbox-Macos-Merge"] })).toThrow("no two kinds share a label");
  });
  test("no two kinds share a label when a kind leaves labels out, as the example does", () => {
    // Each kind then registers label and mergeLabel. A Linux VM that also registered the macOS
    // label would take macOS jobs.
    const ex = JSON.parse(settingsText());
    const loadEx = (over: Record<string, unknown>, linux: Record<string, unknown> = {}) => {
      const dir = tempRoot();
      writeFileSync(join(dir, "taskbox.json"), JSON.stringify({ ...ex, ...over, linux: { ...ex.linux, ...linux } }));
      return () => loadConfig(dir);
    };
    expect(loadEx({})).not.toThrow();
    expect(loadEx({}, { labels: ["taskbox-linux", "taskbox-linux-merge", "taskbox-macos"] })).toThrow("no two kinds share a label");
    expect(loadEx({ labels: ["taskbox-macos", "taskbox-macos-merge", "Taskbox-Linux-Merge"] })).toThrow("no two kinds share a label");
  });
  test("a Linux VM never registers the macOS labels, when Linux leaves its own out", () => {
    const ex = JSON.parse(settingsText());
    const cfg = (over: Record<string, unknown>, linux: Record<string, unknown>) => {
      const dir = tempRoot();
      writeFileSync(join(dir, "taskbox.json"), JSON.stringify({ ...ex, ...over, linux: { ...linux } }));
      return loadConfig(dir);
    };
    const { mergeLabel: _, ...linuxNoMerge } = ex.linux;
    // macOS sets a labels list, and Linux has none of its own.
    const a = cfg({ labels: ["taskbox-macos", "taskbox-macos-merge", "taskbox-macos-big"] }, ex.linux);
    expect(labelsFor(a, "linux")).toEqual(["taskbox-linux", "taskbox-linux-merge", "example-box-linux"]);
    expect(labelsFor(a, "macos")).toEqual(["taskbox-macos", "taskbox-macos-merge", "taskbox-macos-big", "example-box-macos"]);
    // Linux leaves mergeLabel out, so it registers only its own label.
    const b = cfg({}, linuxNoMerge);
    expect(labelsFor(b, "linux")).toEqual(["taskbox-linux", "example-box-linux"]);
  });
  test("timings: each a whole number within its bounds, defaults for the rest", () => {
    expect(timingsOf(load({ timings: { giveWayMinutes: 5 } })())).toEqual({ ...DEFAULT_TIMINGS, giveWayMinutes: 5 });
    expect(load({ timings: { giveWayMinutes: 0 } })).toThrow("giveWayMinutes is 1 to 60");
    // v2.6.1: a key it doesn't know is passed over with a line, so a later
    // release's taskbox.json can add one.
    const said: string[] = [];
    expect(timingsOf(load({ timings: { speed: 1, giveWayMinutes: 5 } }, undefined, (l) => said.push(l))())).toEqual({ ...DEFAULT_TIMINGS, giveWayMinutes: 5 });
    expect(said).toEqual(["taskbox.json: timings has no setting speed that this release reads, so it is passed over"]);
    expect(load({ timings: { speed: 1, giveWayMinutes: 0 } })).toThrow("giveWayMinutes is 1 to 60");
  });
  test("releaseRepo and publicRepo (v2.6.1): names in GitHub's shape, and v2 releases read from releaseRepo", () => {
    const c = load({ releaseRepo: "example-releases", publicRepo: "example-org/taskbox" })();
    expect(releaseRepoOf(c)).toBe("example-releases");
    expect(assetUrl(c, 7)).toBe("https://api.github.com/repos/example-org/example-releases/releases/assets/7");
    expect(releaseRepoOf(load({})())).toBe("taskbox");
    expect(load({ releaseRepo: "a/b" })).toThrow("releaseRepo is the name of the repo in org");
    expect(load({ publicRepo: "taskbox" })).toThrow("publicRepo is the public repo");
    expect(load({ publicRepo: "example-org/taskbox?x" })).toThrow("publicRepo is the public repo");
  });
  test("check's source line names the classes, and says they wait when there is no source", () => {
    expect(sourceLine({ ...CFG, classes: [{ name: "merge", when: { event: ["merge_group"] } }] })).toBe("none: the box follows the jobs its VMs take. The classes (merge) wait for a source");
    expect(sourceLine({ ...CFG, actionsAppId: 4242, classes: [{ name: "merge", when: { event: ["merge_group"] } }] })).toBe("github-actions, App 4242, 1 repo. Classes: merge, then jobs");
  });
});

describe("taskbox.json from v2.3.0 on", () => {
  test("taskbox.json keeps every key v2.3.0's loadConfig needs, beside the new ones", () => {
    const c = base();
    for (const k of ["label", "slots", "vmsAtOnce", "jobsFrom", "runnerGroup", "image", "vmCpus", "vmMemoryMB"]) expect(c[k]).toBeDefined();
    expect(c.slots).toBe(1);
    const labels = labelsFor(load({})(), "macos");
    expect(labels[0]).toBe(c.label);
    if (c.mergeLabel) expect(labels).toContain(c.mergeLabel);
  });
});
