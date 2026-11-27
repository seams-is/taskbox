// Workspaces: an agent asks for one, the owner approves, and the agent works in a pool account on
// the box (workspace/model.ts). The agent's steps are unsigned requests; the owner's approve, pause,
// resume and end come signed from the controller. workspace clear is an admin's, at the box.
import type { BoxCtx, CommandSpec, Outcome } from "../command.ts";
import { EXIT } from "../command.ts";
import { overSsh } from "../cmdkit.ts";
import { AGENT, cleanWords, isSize, isState, NAME } from "../workspace/model.ts";

const ID = (v: string) => NAME.test(v);
const words = (v: string) => cleanWords(v) === v.replace(/\s+/g, " ").trim() && cleanWords(v) !== undefined;
const run = (name: "requestRun" | "listRun" | "statusRun" | "waitRun" | "progressRun" | "endRun" | "denyRun" | "connectRun") => async (c: BoxCtx) => (await import("../workspace/cmd.ts"))[name](c);

// The owner's steps run only signed: at the box there is nobody to sign for.
const signedOnly = (verb: string) => async (c: BoxCtx): Promise<Outcome> => {
  const line = `taskbox workspace ${verb} needs the owner's signature: run it from the controller.`;
  c.say(line);
  return { exit: EXIT.failed, error: { code: "denied", message: line, fix: null, who: null } };
};

export const commands: CommandSpec[] = [
  {
    path: ["workspace", "request"],
    summary: "Asks for a workspace: --as AGENT, --size light, heavy or whole, and --why.",
    who: ["agent"],
    flags: ["json"],
    options: [
      { name: "--as", value: "AGENT", check: (v) => AGENT.test(v) },
      { name: "--size", value: "SIZE", check: isSize },
      { name: "--why", value: "TEXT", check: words },
    ],
    check: (p) => (p.opts.as === undefined || p.opts.why === undefined ? "workspace request needs --as AGENT and --why TEXT" : undefined),
    shell: true,
    run: run("requestRun"),
  },
  {
    path: ["workspace", "list"],
    summary: "Every workspace: agent, size, account, state and why.",
    who: ["anyone"],
    flags: ["json", "watch"],
    options: [{ name: "--state", value: "STATE", check: isState }],
    check: (p) => (p.flags.json && p.flags.watch ? "-w is for the text form; --json gives one answer" : undefined),
    shell: true,
    run: run("listRun"),
  },
  {
    path: ["workspace", "status"],
    summary: "One workspace: its state and why, the room it holds, and its agent's last words.",
    who: ["anyone"],
    flags: ["json", "watch"],
    args: { name: "ID", min: 1, max: 1, check: ID },
    check: (p) => (p.flags.json && p.flags.watch ? "-w is for the text form; --json gives one answer" : undefined),
    shell: true,
    run: run("statusRun"),
  },
  {
    path: ["workspace", "wait"],
    summary: "Waits for a workspace to be ready, paused or ended, one line per change.",
    who: ["agent"],
    flags: ["json", "timeout"],
    args: { name: "ID", min: 1, max: 1, check: ID },
    options: [{ name: "--for", value: "STATE", check: (v) => v === "ready" || v === "ended" || v === "paused" }],
    shell: true,
    run: run("waitRun"),
  },
  {
    path: ["workspace", "connect"],
    summary: "The account a ready workspace runs as; the controller opens the shell there.",
    who: ["agent"],
    flags: ["json"],
    args: { name: "ID", min: 1, max: 1, check: ID },
    shell: true,
    run: run("connectRun"),
  },
  {
    path: ["workspace", "progress"],
    summary: "The agent's words on its work; the answer says carry on, save or stop.",
    who: ["agent", "pool"],
    flags: ["json"],
    args: { name: "ID TEXT", min: 2, max: 2 },
    options: [
      { name: "--step", value: "N/M", check: (v) => /^(0|[1-9]\d{0,9})\/[1-9]\d{0,9}$/.test(v) && Number(v.split("/")[0]) <= Number(v.split("/")[1]) },
      { name: "--saved" },
    ],
    check: (p) => (!ID(p.args[0] ?? "") ? "the first word is the workspace's id, such as nova-3" : !words(p.args[1] ?? "") ? "the words take letters, digits, spaces and plain punctuation, at most 100" : undefined),
    shell: true,
    run: run("progressRun"),
  },
  {
    path: ["workspace", "end"],
    summary: "Ends a workspace: the agent its own, or the owner any, signed. Its files stay.",
    who: ["agent", "owner"],
    flags: ["json", "force", "signed"],
    args: { name: "ID", min: 1, max: 1, check: ID },
    shell: true,
    unsigned: true,
    run: run("endRun"),
  },
  {
    path: ["workspace", "approve"],
    summary: "Approves a request, at the size asked or a smaller one. Signed by the owner.",
    who: ["owner"],
    flags: ["json", "signed"],
    args: { name: "ID", min: 1, max: 1, check: ID },
    options: [{ name: "--size", value: "SIZE", check: isSize }],
    shell: true,
    run: signedOnly("approve"),
  },
  {
    path: ["workspace", "deny"],
    summary: "Says no to a request. Unsigned: a denial gives nobody anything.",
    who: ["owner"],
    flags: ["json"],
    args: { name: "ID", min: 1, max: 1, check: ID },
    options: [{ name: "--reason", value: "TEXT", check: words }],
    shell: true,
    run: run("denyRun"),
  },
  {
    path: ["workspace", "pause"],
    summary: "Asks the agent to save and pause. Signed by the owner.",
    who: ["owner"],
    flags: ["json", "signed"],
    args: { name: "ID", min: 1, max: 1, check: ID },
    shell: true,
    run: signedOnly("pause"),
  },
  {
    path: ["workspace", "resume"],
    summary: "Puts a paused workspace back in the queue at its size. Signed by the owner.",
    who: ["owner"],
    flags: ["json", "signed"],
    args: { name: "ID", min: 1, max: 1, check: ID },
    shell: true,
    run: signedOnly("resume"),
  },
  {
    path: ["workspace", "clear"],
    summary: "Deletes the files of an agent's pool account, after a typed yes. At the box.",
    who: ["admin"],
    args: { name: "AGENT", min: 1, max: 1, check: (v) => AGENT.test(v) },
    root: true,
    typed: true,
    did: "Ran workspace clear.",
    async run(c) {
      const { lchownSync } = await import("node:fs");
      const { clear } = await import("../workspace/clear.ts");
      if (await overSsh(c)) {
        c.say("taskbox workspace clear works at the box itself. Over SSH it does nothing.");
        return 1;
      }
      return clear({ sys: c.ops.sys, say: c.say, ask: c.ask, chown: (path, u, g) => lchownSync(path, u, g), state: c.p.workspaces, poolRecord: c.p.poolRecord, usersDir: "/Users" }, c.args[0]!);
    },
  },
];
