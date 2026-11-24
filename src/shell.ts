#!/usr/bin/env -S /opt/taskbox/bin/bun --no-install --no-env-file --cwd=/ --config=/opt/taskbox/app/bunfig.run.toml
// The remote user's login shell. It runs taskbox's commands that read the box, and hello for a
// controller, and nothing else. No
// other program, no su, no dotfile, no PATH. So a program that reaches remote over Tailscale SSH
// can't plant anything that catches a password, and admin work never goes through remote. It runs
// taskbox by its full path, with a fixed environment.
//
// The commands it runs are those marked shell in the registry (src/cmd/). Each line is parsed here
// as taskbox parses it, so a word or flag a command doesn't take is refused before taskbox runs. The
// workspace agent's commands (#47) are checked in full with workspace/agent.ts's parser too. None of
// them gives anyone more of the box: signed carries the owner's signed steps as base64url, so the word
// filter below stays as strict as it is. v2.6.0's old names pass, so taskbox says what they became.
import { parseLine, firstWords, shellCommands } from "./registry.ts";
import { renamed } from "./renames.ts";
import { isAgentCommand, parseAgent } from "./workspace/agent.ts";

// The first word of each command the shell runs, in the registry's order.
export const shellWords = (): string[] => firstWords(shellCommands());
const TASKBOX = "/opt/taskbox/bin/taskbox";

// One line, as words: plain words, and "double" or 'single' quoted ones. Anything a shell would read
// as more than words (; | & $ ` < > \ ( ) { } * ? ! ~ #, or a newline) refuses the whole line.
export function words(line: string): string[] | undefined {
  if (/[;|&$`<>\\(){}*?!~#\n\r\u0000-\u0008\u000b-\u001f\u007f]/.test(line)) return undefined;
  const out: string[] = [];
  const re = /\s*(?:"([^"]*)"|'([^']*)'|([^\s"']+))/gy;
  let m: RegExpExecArray | null;
  let at = 0;
  while ((m = re.exec(line)) !== null) {
    out.push(m[1] ?? m[2] ?? m[3]!);
    at = re.lastIndex;
  }
  return line.slice(at).trim() === "" ? out : undefined;
}

// The taskbox arguments a line asks for, or why not. "taskbox status" and "status" both work.
export function commandFor(line: string): { args: string[] } | { no: string } {
  const w = words(line.trim());
  if (!w) return { no: "Only taskbox's own commands work here, with plain words and quotes." };
  const args = w[0] === "taskbox" ? w.slice(1) : w;
  if (!args.length) return { args: ["status"] };
  const here = `Here you can type: ${shellWords().join(", ")}. Admin work is done at the box, as your admin user.`;
  // An old name taskbox renamed: taskbox says what it is now, if the new one runs here.
  const old = renamed(args);
  if (old) {
    const now = parseLine(old.replacement.split(" "));
    return now.ok && now.spec.shell ? { args } : { no: here };
  }
  const p = parseLine(args);
  if (!p.ok) return p.path && shellCommands().some((s) => s.path[0] === p.path![0]) ? { no: p.usage ? `${p.line} ${p.usage}` : p.line } : { no: here };
  if (!p.spec.shell) return { no: here };
  const verb = p.spec.agent ?? p.spec.path[0];
  if (p.spec.raw && isAgentCommand(verb)) {
    const c = parseAgent([verb, ...p.args]);
    if ("no" in c) return { no: c.no };
  }
  return { args };
}

const env = () => ({ PATH: "/usr/bin:/bin", HOME: "/var/empty", USER: process.env.USER ?? "", LOGNAME: process.env.USER ?? "", TERM: /^[a-z0-9-]{1,32}$/.test(process.env.TERM ?? "") ? process.env.TERM! : "dumb", LANG: "en_GB.UTF-8" });

async function run(line: string): Promise<number> {
  const c = commandFor(line);
  if ("no" in c) {
    console.log(c.no);
    return 1;
  }
  // No command here reads input, so none gets the session's: a line typed after it is the shell's.
  const p = Bun.spawn([TASKBOX, ...c.args], { stdin: "ignore", stdout: "inherit", stderr: "inherit", env: env() });
  return await p.exited;
}

if (import.meta.main) {
  // sshd and Tailscale SSH start a login shell as "-c <line>" for a command, and with no line for a
  // session. Login flags are ignored.
  const argv = process.argv.slice(2).filter((a) => !["-l", "--login", "-i"].includes(a));
  if (argv[0] === "-c") process.exit(await run(argv[1] ?? ""));
  if (argv.length) process.exit(await run(argv.join(" ")));
  console.log(`taskbox. Type ${shellWords().join(", ")}, or exit.`);
  // Bun reads stdin a line at a time and stops at its end, whether it's a terminal or a pipe.
  process.stdout.write("taskbox> ");
  for await (const line of console) {
    if (/^\s*(exit|logout|quit)\s*$/.test(line)) break;
    if (line.trim()) await run(line);
    process.stdout.write("taskbox> ");
  }
  process.stdout.write("\n");
  process.exit(0);
}
