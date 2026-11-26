// The controller's way to every box command: --box cut from the line, the line the box gets, a
// stream read line by line, and self update --check and self rollback.
import { describe, expect, test } from "bun:test";
import { mkdirSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { envelope } from "../src/envelope.ts";
import { cutBox, lineFor, streamReader } from "../src/controller/forward.ts";
import { readEvents } from "../src/controller/events.ts";
import { registry } from "../src/registry.ts";
import { readEnvelopes } from "../src/schema.ts";
import { rollback } from "../src/controller/update.ts";
import { CEILING, deps, INSTALL_ID, World } from "./controller-fake.ts";

const spec = (path: string) => registry().find((s) => s.path.join(" ") === path)!;
const env = (o: { final: boolean; exit?: number; lines?: string[]; installId?: string }) => JSON.stringify(envelope({ command: "event", box: { name: "taskbox-1", installId: o.installId ?? INSTALL_ID, release: "3.0.0" }, at: 0, exit: o.exit ?? 0, lines: o.lines ?? ["x"], final: o.final }));

describe("the line", () => {
  test("--box is cut in either spelling, once, and must be a name or all", () => {
    expect(cutBox(["status", "--box", "taskbox-2", "--json"])).toEqual({ sel: "taskbox-2", rest: ["status", "--json"] });
    expect(cutBox(["status", "--box=all"])).toEqual({ sel: "all", rest: ["status"] });
    expect(cutBox(["status"])).toEqual({ sel: undefined, rest: ["status"] });
    for (const bad of [["status", "--box"], ["status", "--box", "a;b"], ["status", "--box", "a", "--box=b"]]) expect(cutBox(bad)).toHaveProperty("no");
  }, CEILING);

  test("the box gets --json in the version agreed, and the agent's own verbs as typed", () => {
    expect(lineFor(spec("job list"), ["job", "list", "-n", "5"], 4)).toBe("job list -n 5 --json --answers 4");
    expect(lineFor(spec("workspaces"), ["workspaces", "--json"], 4)).toBe("workspaces --json");
    expect(lineFor(spec("check"), ["check", "--away"], 4)).toBe("check --away --json --answers 4");
    // A word the box's shell would split differently is never sent.
    expect(() => lineFor(spec("workspace end"), ["workspace", "end", 'a"b'], 4)).toThrow();
  }, CEILING);
});

describe("a stream", () => {
  test("each envelope as its line comes, until the final one", () => {
    const seen: string[][] = [];
    const st = streamReader(INSTALL_ID, (e) => seen.push(e.lines));
    st.onLine(env({ final: false, lines: ["one"] }));
    st.onLine("");
    st.onLine(env({ final: true, lines: ["two"], exit: 3 }));
    st.onLine(env({ final: true, lines: ["after the end"] }));
    expect(seen).toEqual([["one"], ["two"]]);
    expect(st.end("taskbox-1")).toMatchObject({ exit: 3 });
  }, CEILING);

  test("a stream with no final line, or a line the schema refuses, stops", () => {
    const a = streamReader(INSTALL_ID, () => {});
    a.onLine(env({ final: false }));
    expect(a.end("taskbox-1")).toMatchObject({ exit: 1, stop: { stop: "taskbox-1's stream ended before its last line." } });
    const b = streamReader(INSTALL_ID, () => {});
    b.onLine(env({ final: false, installId: "f".repeat(32) }));
    b.onLine(env({ final: true }));
    expect(b.end("taskbox-1")).toMatchObject({ exit: 1, stop: { stop: "taskbox-1's stream stopped with an answer taskbox doesn't read (another install's answer)." } });
  }, CEILING);

  test("the schema reads part of a stream, and still refuses a final line before the end", () => {
    expect(readEnvelopes(`${env({ final: false })}\n`, { stream: true }).ok).toBe(false);
    expect(readEnvelopes(`${env({ final: false })}\n`, { stream: true, partial: true }).ok).toBe(true);
    expect(readEnvelopes(`${env({ final: true })}\n${env({ final: false })}\n`, { stream: true, partial: true }).ok).toBe(false);
  }, CEILING);
});

describe("self rollback", () => {
  test("moves current to the kept release, and says so in the controller's events", () => {
    const d = deps(new World());
    for (const t of ["v2.1.0", "v2.2.0"]) {
      mkdirSync(join(d.home.releases, t, "app", "src", "controller"), { recursive: true });
      writeFileSync(join(d.home.releases, t, "bun"), "");
      writeFileSync(join(d.home.releases, t, "app", "src", "controller", "main.ts"), "");
    }
    symlinkSync(join("releases", "v2.2.0"), d.home.current);
    const s = rollback(d);
    expect(s.code).toBe(0);
    expect(readlinkSync(d.home.current)).toBe(join("releases", "v2.1.0"));
    expect(readEvents(d.home).map((e) => e.type)).toEqual(["self.rolled-back"]);
    // Nothing else kept: nothing to roll back to.
    expect(rollback(d).code).toBe(0);
    expect(rollback(deps(new World())).lines[1]).toBe("This controller's taskbox has no release in use taskbox can read.");
  }, CEILING);
});
