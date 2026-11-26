// The agents' workspace commands on the controller: queue, wait,
// progress, release and workspaces run the box's own commands over Tailscale SSH as the agent
// account, and connect opens the workspace's pool account. Each line is checked here with the box's
// own parser first, and sent in the one spelling it makes, so the box's shell sees nothing else.
// What the box prints is scrubbed line by line, and its exit comes back: progress's 10 means save.
import { type AgentCmd, parseAgent } from "../workspace/agent.ts";
import { NAME, OPEN, PHASE_WORD } from "../workspace/model.ts";
import { cantReach, type ControllerDeps, onBox, readBox, scrub, SSH_FAILED, sshArgv } from "./box.ts";
import { readController } from "./settings.ts";

export const WRAPPED = ["queue", "wait", "progress", "release", "workspaces"] as const;
export type Wrapped = (typeof WRAPPED)[number];
export const isWrapped = (c: string | undefined): c is Wrapped => (WRAPPED as readonly string[]).includes(c ?? "");

// The words the box gets for a command, in one spelling.
export function boxWords(c: AgentCmd): string[] {
  const json = c.json ? ["--json"] : [];
  switch (c.cmd) {
    case "queue":
      return ["queue", "--as", c.agent, "--why", c.why, ...json];
    case "wait":
      return [c.cmd, c.name, ...json];
    // The box's taskbox workspace end is the agent's release.
    case "release":
      return ["workspace", "end", c.name, ...json];
    case "progress":
      return ["progress", c.name, c.words, ...(c.step ? ["--step", `${c.step.n}/${c.step.m}`] : []), ...(c.mode ? [`--${c.mode}`] : []), ...(c.saved ? ["--saved"] : []), ...json];
    case "workspaces":
      return ["workspaces", ...json];
    default:
      throw new Error("not a wrapped command");
  }
}

// queue, wait, progress, release or workspaces, on the box. wait prints each line as it comes.
export async function wrapped(d: ControllerDeps, args: readonly string[]): Promise<number> {
  const c = parseAgent(args);
  if ("no" in c) {
    d.out(c.no);
    return 1;
  }
  if (!isWrapped(c.cmd)) {
    d.out("Not a command this controller sends for agents.");
    return 1;
  }
  const l = readController(d.home);
  if (!l.ok) {
    d.out(l.why);
    return 1;
  }
  let printed = 0;
  const r = await onBox(d, l.controller.agent, l.controller.box, boxWords(c), {
    // wait runs until the workspace is Active or finished.
    timeoutMs: c.cmd === "wait" ? 0 : undefined,
    onLine: (line) => {
      if (printed++ < 1000) d.out(scrub(line, 400));
    },
  });
  if (r.code === SSH_FAILED) d.out(cantReach(l.controller.box, l.controller.agent));
  return r.code;
}

// connect <name> [-- <command>]: a shell, or one command, in the workspace's pool account. The pool
// account comes from the box's state, and the box's gate opens only while it is Active or Saving.
export async function connect(d: ControllerDeps, name: string | undefined, command: readonly string[]): Promise<number> {
  if (name === undefined || !NAME.test(name)) {
    d.out("Type taskbox connect <name> [-- <command>], such as taskbox connect nova-1.");
    return 1;
  }
  const l = readController(d.home);
  if (!l.ok) {
    d.out(l.why);
    return 1;
  }
  const v = await readBox(d, l.controller.agent, l.controller.box);
  if ("why" in v) {
    d.out(v.why);
    return 1;
  }
  const w = v.workspaces.find((x) => x.name === name);
  if (!w) {
    d.out(`The box has no workspace ${name}.`);
    return 1;
  }
  if (!OPEN.includes(w.phase) || !w.user) {
    d.out(`${name} is ${PHASE_WORD[w.phase]}, so it can't be reached. Type taskbox wait ${name}.`);
    return 1;
  }
  return d.tty(sshArgv(w.user, l.controller.box, command.length ? command.join(" ") : undefined, command.length === 0));
}
