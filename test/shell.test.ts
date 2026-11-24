// The remote user's login shell: taskbox's commands that read the box, nothing else.
import { describe, expect, test } from "bun:test";
import { commandFor, words } from "../src/shell.ts";

describe("remote's shell", () => {
  test("takes taskbox's reading commands, with or without the word taskbox", () => {
    expect(commandFor("status")).toEqual({ args: ["status"] });
    expect(commandFor("taskbox job list -n 50")).toEqual({ args: ["job", "list", "-n", "50"] });
    expect(commandFor("logs --json")).toEqual({ args: ["logs", "--json"] });
    expect(commandFor("template show box-check")).toEqual({ args: ["template", "show", "box-check"] });
    expect(commandFor("taskbox hello")).toEqual({ args: ["hello"] });
    expect(commandFor("  ")).toEqual({ args: ["status"] });
  });
  test("refuses su, other programs, admin commands and anything a shell would read as more than words", () => {
    for (const line of ["su admin", "su -", "sudo -i", "taskbox update", "taskbox rollback", "taskbox remove", "taskbox unlock", "taskbox stop", "bash", "/bin/zsh", "scp -t /tmp", "sftp-server", "status; su admin", "status && sh", "status | sh", "status $(id)", "status `id`", "status > /tmp/x", "hold --reason 'a\\nb'", "status\nsu", "cd /tmp", "export PATH=/tmp", 'taskbox hold --for 3h --reason "x"', "share"]) {
      expect("no" in commandFor(line)).toBe(true);
    }
  });
  test("passes v2.6.0's old names whose new command it runs, so taskbox says what they became", () => {
    for (const line of ["watch", "watch --once", "jobs 50", "timings", "log", "away --json", "watchdog", "canary", "load", "load workflow"]) expect({ line, ok: "args" in commandFor(line) }).toEqual({ line, ok: true });
    // The new command is the service account's or root's: refused here, as before.
    for (const line of ["clean", "undo", "stop --drain", "load on", "load off"]) expect({ line, no: "no" in commandFor(line) }).toEqual({ line, no: true });
  });
  test("refuses a flag or word the command doesn't take, with the command's own line", () => {
    expect(commandFor("status --force")).toEqual({ no: "taskbox status doesn't take --force. Usage: taskbox status [--state FOLDER] [--json] [--watch]" });
    for (const line of ["status myproject", "job list -n x", "job list --tail", "job", "check --away --away", "logs --json=1", "template show nothing", "policy show", "connect github", "key reset approver"]) expect({ line, no: "no" in commandFor(line) }).toEqual({ line, no: true });
  });
  test("takes the agent's workspace commands, each checked in full", () => {
    for (const line of [
      'taskbox queue --as nova --why "Render the launch video"',
      "queue --as nova --why 'Render the launch video' --json",
      "wait nova-1",
      "taskbox wait nova-1 --json",
      'progress nova-1 "Frame 1200 of 4000" --step 1200/4000 --can-pause',
      'progress nova-1 "Building shaders" --busy',
      'progress nova-1 --saved "Saved after frame 1800"',
      "release nova-1",
      'deny nova-2 --as laptop --reason "after 6pm"',
      "signed eyJhY3Rpb24iOiJhcHByb3ZlIn0 U1NIU0lHAAAAAQ_-",
      "workspaces",
      "taskbox workspaces --json",
    ]) {
      const c = commandFor(line);
      expect({ line, ok: "args" in c }).toEqual({ line, ok: true });
    }
    expect(commandFor('queue --as nova --why "Render it"')).toEqual({ args: ["queue", "--as", "nova", "--why", "Render it"] });
  });
  test("refuses a workspace command with bad words, a missing part, or anything the word filter refuses", () => {
    for (const line of [
      "queue",
      "queue --as nova",
      'queue --as nova --why "a" --size huge',
      'queue --as ../x --why "a"',
      "wait",
      "wait nova",
      "wait nova-1 nova-2",
      "wait nova-1; id",
      'progress nova-1 "x" --can-pause --busy',
      'progress nova-1 "x" --step 9/4',
      "progress nova-1",
      'progress nova-1 --saved "x" --busy',
      "release",
      "release nova-1 --now",
      "deny nova-2",
      "deny nova-2 --as owner",
      "deny nova-2 --as taskbox",
      'deny nova-2 --as owner --reason "$(id)"',
      "signed a+b c",
      "signed eyJ4IjoxfQ",
      "signed eyJ4IjoxfQ== c2ln",
      "workspaces nova-1",
      'progress nova-1 "Frame 1 \\ 2"',
      "queue --as nova --why `id`",
    ]) {
      expect({ line, no: "no" in commandFor(line) }).toEqual({ line, no: true });
    }
  });
  test("words: quotes keep spaces; an unclosed quote is refused", () => {
    expect(words(`a "b c" 'd e' f`)).toEqual(["a", "b c", "d e", "f"]);
    expect(words(`a "b`)).toBeUndefined();
  });
});
