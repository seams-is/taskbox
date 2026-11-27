// The remote user's login shell: taskbox's commands that read the box, nothing else.
import { describe, expect, test } from "bun:test";
import { commandFor, refusal, words } from "../src/shell.ts";
import { readEnvelopes } from "../src/schema.ts";

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
    for (const line of ["su admin", "su -", "sudo -i", "taskbox remove", "taskbox unlock", "bash", "/bin/zsh", "scp -t /tmp", "sftp-server", "status; su admin", "status && sh", "status | sh", "status $(id)", "status `id`", "status > /tmp/x", "hold --reason 'a\\nb'", "status\nsu", "cd /tmp", "export PATH=/tmp"]) {
      expect("no" in commandFor(line)).toBe(true);
    }
  });
  test("passes v2.6.0's old names whose new command it runs, so taskbox says what they became", () => {
    for (const line of ["watch", "watch --once", "jobs 50", "timings", "log", "away --json", "watchdog", "canary", "load", "load workflow", "load on", "load off", "stop --drain", "undo"]) expect({ line, ok: "args" in commandFor(line) }).toEqual({ line, ok: true });
    // The new command is the service account's or root's: refused here, as before.
    for (const line of ["clean"]) expect({ line, no: "no" in commandFor(line) }).toEqual({ line, no: true });
  });
  test("refuses a flag or word the command doesn't take, with the command's own line", () => {
    expect(commandFor("status --force")).toEqual({ no: "taskbox status doesn't take --force. Usage: taskbox status [--state FOLDER] [--json] [--watch]" });
    for (const line of ["status myproject", "job list -n x", "job list --tail", "job", "check --away --away", "logs --json=1", "template show nothing", "policy show --nope", "connect github", "key reset approver"]) expect({ line, no: "no" in commandFor(line) }).toEqual({ line, no: true });
  });
  test("takes the workspace commands, each word checked by the registry's parser", () => {
    for (const line of [
      'taskbox workspace request --as nova --size light --why "Render the launch video"',
      "workspace request --as nova --why 'Render the launch video' --json",
      "workspace wait nova-1 --for ready --timeout 10m",
      "workspace status nova-1 --json",
      "workspace list --state requested",
      'workspace progress nova-1 "Frame 1200 of 4000" --step 1200/4000',
      'workspace progress nova-1 "Saved after frame 1800" --saved',
      "workspace end nova-1",
      'workspace deny nova-2 --reason "after 6pm"',
      "workspace connect nova-1",
      "workspace approve nova-1 --size light --signed eyJhY3Rpb24iOiJhcHByb3ZlIn0.U1NIU0lHAAAAAQ_-",
    ]) {
      const c = commandFor(line);
      expect({ line, ok: "args" in c }).toEqual({ line, ok: true });
    }
    expect(commandFor('workspace request --as nova --why "Render it"')).toEqual({ args: ["workspace", "request", "--as", "nova", "--why", "Render it"] });
  });
  test("refuses a workspace command with bad words, a missing part, or anything the word filter refuses", () => {
    for (const line of [
      "workspace request",
      "workspace request --as nova",
      'workspace request --as nova --why "a" --size huge',
      'workspace request --as ../x --why "a"',
      "workspace wait",
      "workspace wait nova",
      "workspace wait nova-1 nova-2",
      "workspace wait nova-1; id",
      "workspace wait nova-1 --for gone",
      'workspace progress nova-1 "x" --step 9/4',
      "workspace progress nova-1",
      "workspace end",
      "workspace end nova-1 --now",
      "workspace deny nova-2 extra",
      'workspace deny nova-2 --reason "$(id)"',
      'workspace progress nova-1 "Frame 1 \\ 2"',
      "workspace request --as nova --why `id`",
      "queue --as nova --why x",
      "workspaces",
    ]) {
      expect({ line, no: "no" in commandFor(line) }).toEqual({ line, no: true });
    }
  });
  test("words: quotes keep spaces; an unclosed quote is refused", () => {
    expect(words(`a "b c" 'd e' f`)).toEqual(["a", "b c", "d e", "f"]);
    expect(words(`a "b`)).toBeUndefined();
  });
});

describe("the shell", () => {
  // A raw command whose words no parser here checks never reaches taskbox.
  test("a raw shell command that isn't one of the workspace agent's verbs is refused", async () => {
    const { registry } = await import("../src/registry.ts");
    const specs = [...registry(), { path: ["later"], summary: "x", who: ["agent"], shell: true, raw: true, run: async () => 0 } as never];
    expect("no" in commandFor("later anything at all", specs)).toBe(true);
  });

  // An old name reaches taskbox as its own words alone, so taskbox's rename line is all that runs.
  test("an old name passes as its own words, and --json, and nothing else", () => {
    expect(commandFor("jobs --anything /etc/passwd")).toEqual({ args: ["jobs"] });
    expect(commandFor("jobs 50 --json x")).toEqual({ args: ["jobs", "50", "--json"] });
    expect(commandFor("watch --once")).toEqual({ args: ["watch", "--once"] });
  });

  // A refusal is a usage error, exit 2, and an envelope when the line asked for --json.
  test("a refusal is exit 2, and with --json an error envelope", () => {
    expect(refusal("status --force")).toEqual({ out: "taskbox status doesn't take --force. Usage: taskbox status [--state FOLDER] [--json] [--watch]", code: 2 });
    const r = refusal("logs -f --json");
    expect(r?.code).toBe(2);
    const e = JSON.parse(r!.out);
    expect([e.answers, e.ok, e.exit, e.error.code]).toEqual([4, false, 2, "usage"]);
    expect(readEnvelopes(r!.out).ok).toBe(true);
    expect(refusal("status")).toBeUndefined();
  });

  // Nit: the usage of a command the shell doesn't run, or a noun's other verbs, isn't shown here.
  test("a line naming a command the shell doesn't run gets the shell's own list", () => {
    for (const line of ["remove --x", "workspace", "workspace rule"]) {
      const c = commandFor(line);
      expect({ line, no: "no" in c ? c.no : "" }).toEqual({ line, no: expect.stringMatching(/^Here you can type: /) });
    }
  });

  // Nit: workspace end's refusal names workspace end, not release.
  test("workspace end's refusal names its own command", () => {
    const c = commandFor("workspace end nova-1 --as x");
    expect("no" in c && c.no).toContain("taskbox workspace end");
    expect("no" in c && c.no).not.toContain("taskbox release");
  });
});
