// The remote user's login shell: taskbox's commands that read the box, nothing else.
import { describe, expect, test } from "bun:test";
import { commandFor, words } from "../src/shell.ts";

describe("remote's shell", () => {
  test("takes taskbox's reading commands, with or without the word taskbox", () => {
    expect(commandFor("status")).toEqual({ args: ["status"] });
    expect(commandFor("taskbox jobs 50")).toEqual({ args: ["jobs", "50"] });
    expect(commandFor("taskbox hello")).toEqual({ args: ["hello"] });
    expect(commandFor("  ")).toEqual({ args: ["status"] });
  });
  test("refuses su, other programs, admin commands and anything a shell would read as more than words", () => {
    for (const line of ["su admin", "su -", "sudo -i", "taskbox update", "taskbox undo", "taskbox remove", "taskbox unlock", "taskbox stop", "bash", "/bin/zsh", "scp -t /tmp", "sftp-server", "status; su admin", "status && sh", "status | sh", "status $(id)", "status `id`", "status > /tmp/x", "hold --reason 'a\\nb'", "status\nsu", "cd /tmp", "export PATH=/tmp", 'taskbox hold --for 3h --reason "x"', "share"]) {
      expect("no" in commandFor(line)).toBe(true);
    }
  });
  test("words: quotes keep spaces; an unclosed quote is refused", () => {
    expect(words(`a "b c" 'd e' f`)).toEqual(["a", "b c", "d e", "f"]);
    expect(words(`a "b`)).toBeUndefined();
  });
});
