// taskbox tool list, tool refresh and image list, through main on the fake box.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type CliDeps, main } from "../src/cli.ts";
import { paths } from "../src/config.ts";
import { loopState } from "../src/core/paths.ts";
import { readRefresh } from "../src/tools/refresh.ts";
import type { ToolsState } from "../src/tools/state.ts";
import { storeOf } from "../src/tools/store.ts";
import { FakeSys } from "./fake.ts";
import { fakeLaunchd, quietBox, tempRoot, testBox } from "./helpers.ts";

const CI = process.getuid!();
const TOOLS: ToolsState = {
  enabled: true,
  at: 0,
  maxGB: 5,
  bytes: 30e6,
  pins: [{ name: "node-24.22.3.tar.xz", os: "linux", sha256: "1".repeat(64), bytes: 30e6, state: "held" }],
  gens: { linux: "3a7f19c" + "0".repeat(57) },
  bases: [{ kind: "linux", name: "base-linux-3a7f19c00000-dbc204bb40c0", gen: "3a7f19c" + "0".repeat(57), image: "x", bakedAt: 0 }],
  sources: { linux: "base-linux-3a7f19c00000-dbc204bb40c0" },
};

async function run(argv: string[], uid = CI) {
  const sys = new FakeSys();
  quietBox(sys);
  fakeLaunchd(sys);
  const root = tempRoot();
  const p = paths(root, testBox());
  mkdirSync(p.app, { recursive: true });
  writeFileSync(join(p.app, "taskbox.json"), readFileSync(join(import.meta.dir, "../taskbox.example.json"), "utf8"));
  writeFileSync(join(p.app, "versions.json"), readFileSync(join(import.meta.dir, "../versions.json"), "utf8"));
  mkdirSync(dirname(p.jobsFile), { recursive: true, mode: 0o700 });
  writeFileSync(p.installed, JSON.stringify({ commit: "c0ffee0c0ffee0c0ffee0c0ffee0c0ffee0c0ff", files: {} }));
  writeFileSync(p.loopState, JSON.stringify({ tools: TOOLS }));
  const said: string[] = [];
  const errs: string[] = [];
  const deps: CliDeps = {
    sys: () => sys,
    uid,
    serviceUid: async () => CI,
    env: { HOME: "/Users/ci" },
    tty: () => 0,
    user: () => "ci",
    ask: async () => "",
    say: (l) => said.push(l),
    err: (l) => errs.push(l),
    terminal: () => true,
    hostname: () => "taskbox-1.local",
    root,
    chown: () => {},
  };
  const code = await main(argv, deps);
  return { code, said, errs, p };
}

describe("taskbox tool and image", () => {
  test("tool list shows each pin and what each kind's jobs clone", async () => {
    const r = await run(["tool", "list"]);
    expect(r.code).toBe(0);
    expect(r.said[0]).toMatch(/^Tool cache: 1 of 1 pinned in use \(Linux 1\), 30 MB, gen 3a7f19c, baked \d\d:\d\d\.$/);
    expect(r.said.some((l) => l.includes("node-24.22.3.tar.xz") && l.includes("held"))).toBe(true);
    const j = await run(["tool", "list", "--json"]);
    expect(j.code).toBe(0);
    expect(JSON.parse(j.said.join("\n")).result).toMatchObject({ enabled: true, sources: TOOLS.sources });
  });
  test("tool refresh --detach writes the op and the request for the loop; anyone else is told it is the service account's", async () => {
    const r = await run(["tool", "refresh", "--detach"]);
    expect(r.code).toBe(0);
    const ops = readdirSync(loopState(r.p.state).ops);
    expect(ops.length).toBe(1);
    expect(readRefresh(storeOf(join(r.p.state, "tools")))?.op).toBe(ops[0]!.replace(/\.json$/, ""));
    const other = await run(["tool", "refresh", "--detach"], CI + 1);
    expect(other.code).toBe(1);
    expect(other.said.join("\n")).toContain("the service account's, at the box");
    expect(existsSync(join(other.p.state, "tools", "refresh.json"))).toBe(false);
  });
  test("tool refresh --timeout watches, then stops watching with exit 3 while the refresh carries on", async () => {
    const r = await run(["tool", "refresh", "--timeout", "10s"]);
    expect(r.code).toBe(3);
    expect(r.said.at(-4) ?? r.said.join("\n")).toBeDefined();
    expect(r.said.join("\n")).toContain("The refresh carries on.");
  });
  test("image list shows each kind's image and the base VM its jobs clone", async () => {
    const r = await run(["image", "list"]);
    expect(r.code).toBe(0);
    const linux = r.said.find((l) => l.startsWith("Linux"))!;
    expect(linux).toContain("ghcr.io/cirruslabs/ubuntu-runner-arm64");
    expect(linux).toContain("base VM: base-linux-3a7f19c00000-dbc204bb40c0 (gen 3a7f19c");
    expect(r.said.find((l) => l.startsWith("macOS"))).toContain("base VM: none");
    const j = await run(["image", "list", "--json"]);
    expect(JSON.parse(j.said.join("\n")).result.images.map((i: { kind: string; base: string | null }) => [i.kind, i.base])).toEqual([
      ["macos", null],
      ["linux", "base-linux-3a7f19c00000-dbc204bb40c0"],
    ]);
  });
});
