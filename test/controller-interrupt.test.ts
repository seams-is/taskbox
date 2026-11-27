// Ctrl-C on the controller (controller/main.ts interrupted): the bare screen quits with 0; a command
// that watches the box stops watching only, and names how to watch again and how to cancel.
import { describe, expect, test } from "bun:test";
import { interrupted } from "../src/controller/main.ts";

describe("Ctrl-C on the controller", () => {
  test("the bare screen quits with 0 and says nothing", () => {
    expect(interrupted([])).toEqual({ line: "", exit: 0 });
  });
  test("each command that follows an op names the command that watches again and its opposite", () => {
    expect(interrupted(["drain", "--box", "box-1"])).toEqual({ line: "Stopped watching. What it started carries on at the box. taskbox drain --box box-1 watches again; taskbox resume --box box-1 cancels it.", exit: 130 });
    expect(interrupted(["stop"])!.line).toEndWith("taskbox stop watches again; taskbox start cancels it.");
    expect(interrupted(["load", "start"])!.line).toEndWith("taskbox load stop cancels it.");
    for (const argv of [["update"], ["rollback", "--to", "3.0.0"], ["key", "rotate", "runner"], ["connect", "github"], ["tool", "refresh"]]) expect(interrupted(argv)!.line).toEndWith("taskbox op cancel ID cancels it, and taskbox op list shows the ID.");
    expect(interrupted(["op", "show", "op_01JD8Q000000000000000000DR", "-w"])!.line).toEndWith("watches again; taskbox op cancel op_01JD8Q000000000000000000DR cancels it.");
  });
  test("a watched read names only how to watch again; --detach and plain reads keep Node's own", () => {
    expect(interrupted(["status", "-w"])).toEqual({ line: "Stopped watching. taskbox status -w watches again.", exit: 130 });
    expect(interrupted(["logs", "-f", "--box", "box-1"])!.line).toBe("Stopped watching. taskbox logs -f --box box-1 watches again.");
    expect(interrupted(["drain", "--detach"])).toBeUndefined();
    expect(interrupted(["status"])).toBeUndefined();
  });
});
