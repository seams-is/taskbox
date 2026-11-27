// Workspaces: an agent asks for one, the owner approves, and the agent works in a pool account on
// the box (workspace/model.ts). The agent's steps are unsigned requests; the owner's approve, pause,
// resume and end come signed from the controller. workspace clear is an admin's, at the box.
import type { BoxCtx, CommandSpec, Outcome } from "../command.ts";
import { EXIT } from "../command.ts";
import { overSsh } from "../cmdkit.ts";
import { CLAIM, FINGERPRINT, PROOF } from "../workspace/claim.ts";
import { AGENT, cleanWords, isSize, isState, NAME } from "../workspace/model.ts";
import { parseWindow, RULE_ID } from "../workspace/standing.ts";

const ID = (v: string) => NAME.test(v);
const words = (v: string) => cleanWords(v) === v.replace(/\s+/g, " ").trim() && cleanWords(v) !== undefined;
const run = (name: "requestRun" | "listRun" | "statusRun" | "waitRun" | "progressRun" | "endRun" | "denyRun" | "connectRun" | "ruleListRun") => async (c: BoxCtx) => (await import("../workspace/cmd.ts"))[name](c);

// The owner's steps run only signed: at the box there is nobody to sign for.
const signedOnly = (verb: string) => async (c: BoxCtx): Promise<Outcome> => {
  const line = `taskbox workspace ${verb} needs an approver key's signature: run it from the controller.`;
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
      // The claim key's public half, which the controller makes and keeps; at the box, the request makes one.
      { name: "--claim", value: "KEY", check: (v) => CLAIM.test(v) },
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
    options: [{ name: "--proof", value: "PROOF", check: (v) => PROOF.test(v) }],
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
      { name: "--downsized" },
      { name: "--can-pause" },
      { name: "--busy" },
      { name: "--proof", value: "PROOF", check: (v) => PROOF.test(v) },
    ],
    check: (p) => (!ID(p.args[0] ?? "") ? "the first word is the workspace's id, such as nova-3" : !words(p.args[1] ?? "") ? "the words take letters, digits, spaces and plain punctuation, at most 100" : p.opts.downsized && !p.opts.saved ? "--downsized goes with --saved" : p.opts["can-pause"] && p.opts.busy ? "--can-pause and --busy don't go together" : undefined),
    shell: true,
    run: run("progressRun"),
  },
  {
    path: ["workspace", "end"],
    summary: "Ends a workspace: the agent its own, or any, signed from the controller. Its files stay.",
    who: ["agent", "owner"],
    flags: ["json", "force", "signed"],
    args: { name: "ID", min: 1, max: 1, check: ID },
    options: [{ name: "--proof", value: "PROOF", check: (v) => PROOF.test(v) }],
    shell: true,
    unsigned: true,
    run: run("endRun"),
  },
  {
    path: ["workspace", "approve"],
    summary: "Approves a request, at the size asked or a smaller one. Signed from the controller.",
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
    summary: "Asks the agent to save and pause, or to drop to Light (--to light). --now stops it now. Signed.",
    who: ["owner"],
    flags: ["json", "signed", "yes"],
    args: { name: "ID", min: 1, max: 1, check: ID },
    options: [
      { name: "--to", value: "SIZE", check: (v) => v === "light" },
      { name: "--now" },
    ],
    check: (p) => (p.opts.to !== undefined && p.opts.now !== undefined ? "--to light and --now don't go together" : undefined),
    shell: true,
    run: signedOnly("pause"),
  },
  {
    path: ["workspace", "resume"],
    summary: "Puts a paused workspace back in the queue at its size. Signed from the controller.",
    who: ["owner"],
    flags: ["json", "signed"],
    args: { name: "ID", min: 1, max: 1, check: ID },
    shell: true,
    run: signedOnly("resume"),
  },
  {
    path: ["workspace", "jump"],
    summary: "Moves an approved workspace to the front of its queue. Interrupts nothing. Signed.",
    who: ["owner"],
    flags: ["json", "signed"],
    args: { name: "ID", min: 1, max: 1, check: ID },
    shell: true,
    run: signedOnly("jump"),
  },
  {
    path: ["workspace", "rush"],
    summary: "Front of the queue, and what stands in its way saves and steps aside. --force also stops CI's jobs in its way. Signed.",
    who: ["owner"],
    flags: ["json", "signed", "force", "yes"],
    args: { name: "ID", min: 1, max: 1, check: ID },
    shell: true,
    run: signedOnly("rush"),
  },
  {
    path: ["workspace", "rule", "add"],
    summary: "A standing rule: an agent's matching requests approve themselves. Signed, then confirm at the box.",
    who: ["owner"],
    flags: ["json", "signed"],
    options: [
      { name: "--agent", value: "AGENT", check: (v) => AGENT.test(v) },
      { name: "--size", value: "SIZE", check: (v) => v === "light" || v === "heavy" },
      { name: "--window", value: "HH:MM-HH:MM", check: (v) => parseWindow(v) !== undefined },
      { name: "--expires", value: "DURATION", check: (v) => /^([1-9]|[12]\d|30)d$|^([1-9]\d{0,2})h$/.test(v) },
      { name: "--key", value: "FINGERPRINT", check: (v) => FINGERPRINT.test(v) },
    ],
    check: (p) => (["agent", "size", "window", "expires"].some((k) => p.opts[k] === undefined) ? "rule add needs --agent, --size, --window and --expires (at most 30d)" : undefined),
    shell: true,
    run: signedOnly("rule add"),
  },
  {
    path: ["workspace", "rule", "list"],
    summary: "The standing rules: agent, size, window, expiry, uses, claim key and signer.",
    who: ["anyone"],
    flags: ["json"],
    shell: true,
    run: run("ruleListRun"),
  },
  {
    path: ["workspace", "rule", "delete"],
    summary: "Removes a standing rule at once. Signed.",
    who: ["owner"],
    flags: ["json", "signed"],
    args: { name: "ID", min: 1, max: 1, check: (v) => RULE_ID.test(v) },
    shell: true,
    run: signedOnly("rule delete"),
  },
  {
    path: ["workspace", "clear"],
    summary: "Deletes the files of an agent's pool account, after a typed yes: at the box, or signed from the controller.",
    who: ["admin", "owner"],
    flags: ["signed", "yes", "json"],
    args: { name: "AGENT", min: 1, max: 1, check: (v) => AGENT.test(v) },
    // The owner's comes signed through the agent shell; unsigned, an admin at the box runs it through
    // sudo (cli.ts), and nobody else.
    shell: true,
    typed: true,
    did: "Ran workspace clear.",
    async run(c) {
      if (c.uid !== 0) {
        c.say("taskbox workspace clear is an admin's at the box, or signed from the controller.");
        return 1;
      }
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
