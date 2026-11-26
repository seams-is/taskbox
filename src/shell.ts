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
import { type CommandSpec, parse } from "./command.ts";
import { realClock } from "./clock.ts";
import { envelope } from "./envelope.ts";
import { firstWords, registry, shellCommands } from "./registry.ts";
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
export function commandFor(line: string, specs: readonly CommandSpec[] = registry()): { args: string[] } | { no: string } {
  const w = words(line.trim());
  if (!w) return { no: "Only taskbox's own commands work here, with plain words and quotes." };
  const args = w[0] === "taskbox" ? w.slice(1) : w;
  if (!args.length) return { args: ["status"] };
  const shell = specs.filter((s) => s.shell);
  const here = `Here you can type: ${firstWords(shell).join(", ")}. Admin work is done at the box, as your admin user.`;
  // An old name taskbox renamed: taskbox says what it is now, if the new one runs here. It goes as
  // its own words alone, and --json, so taskbox's rename line is all that runs.
  const old = renamed(args);
  if (old) {
    const now = parse(specs, old.replacement.split(" "));
    return now.ok && now.spec.shell ? { args: [...old.old.split(" "), ...(args.includes("--json") ? ["--json"] : [])] } : { no: here };
  }
  const p = parse(specs, args);
  if (!p.ok) {
    // A command the shell runs, typed wrong, gets its own line; anything else the shell's list.
    const mine = p.path && p.usage && shell.some((s) => s.path.join(" ") === p.path!.join(" "));
    return mine ? { no: `${p.line} ${p.usage}` } : { no: here };
  }
  if (!p.spec.shell) return { no: here };
  if (p.spec.raw) {
    // Its words are checked here by #47's parser, or it doesn't run: a raw command no parser here
    // knows would reach taskbox unchecked.
    const verb = p.spec.agent ?? p.spec.path[0];
    if (!isAgentCommand(verb)) return { no: here };
    const c = parseAgent([verb, ...p.args]);
    if ("no" in c) return { no: p.spec.agent ? c.no.replaceAll(`taskbox ${verb}`, `taskbox ${p.spec.path.join(" ")}`) : c.no };
  }
  return { args };
}

// What the shell prints for a line it refuses, and its exit: 2, a usage error (§2.4). A line that
// asked for --json gets an error envelope (§3.1). Undefined for a line it runs.
export function refusal(line: string, specs: readonly CommandSpec[] = registry()): { out: string; code: 2 } | undefined {
  const c = commandFor(line, specs);
  if (!("no" in c)) return undefined;
  if (!(words(line.trim()) ?? []).includes("--json")) return { out: c.no, code: 2 };
  return { out: JSON.stringify(envelope({ command: "error", box: null, at: realClock.now(), exit: 2, lines: [c.no], error: { code: "usage", message: c.no, fix: null, who: null } })), code: 2 };
}

const env = () => ({ PATH: "/usr/bin:/bin", HOME: "/var/empty", USER: process.env.USER ?? "", LOGNAME: process.env.USER ?? "", TERM: /^[a-z0-9-]{1,32}$/.test(process.env.TERM ?? "") ? process.env.TERM! : "dumb", LANG: "en_GB.UTF-8" });

async function run(line: string): Promise<number> {
  const no = refusal(line);
  if (no) {
    console.log(no.out);
    return no.code;
  }
  const c = commandFor(line) as { args: string[] };
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
