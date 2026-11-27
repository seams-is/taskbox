// v2.6.1's own agent shell, verbatim from public main (1d3ba77), for the controller's N-1 contract test.
// The remote user's login shell. It runs taskbox's commands that read the box, and hello for a
// controller, and nothing else. No
// other program, no su, no dotfile, no PATH. So a program that reaches remote over Tailscale SSH
// can't plant anything that catches a password, and admin work never goes through remote. It runs
// taskbox by its full path, with a fixed environment.

export const SHELL_COMMANDS = ["status", "watch", "jobs", "timings", "load", "log", "logins", "check", "hello", "away", "watchdog", "canary"];
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
  if (!SHELL_COMMANDS.includes(args[0]!)) return { no: `Here you can type: ${SHELL_COMMANDS.join(", ")}. Admin work is done at the box, as your admin user.` };
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
  console.log(`taskbox. Type ${SHELL_COMMANDS.join(", ")}, or exit.`);
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
