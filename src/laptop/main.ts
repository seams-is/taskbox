#!/usr/bin/env bun
// taskbox on the owner's laptop, for workspaces. It is the
// repo's own code, run by Bun from a checkout: no install, no daemon. It talks to the box over
// Tailscale SSH, and signs the owner's steps with the approver key.
//
//   bun src/laptop/main.ts            the owner's screen
//   bun src/laptop/main.ts approve nova-1
import { homedir } from "node:os";
import { connect, isWrapped, wrapped } from "./agents.ts";
import type { LaptopDeps, RunOpts, RunResult } from "./box.ts";
import { approver, type ApproverArgs, ownerDeny, ownerStep } from "./owner.ts";
import { ownerScreen } from "./screen.ts";
import { realClock } from "../clock.ts";

export const LAPTOP_USAGE = [
  "taskbox                                  the owner's screen: each workspace, redrawn every 3 s",
  "taskbox approve <name>                   Touch ID",
  'taskbox deny <name> [--reason "<words>"]',
  "taskbox pause <name> [--now]             Touch ID",
  "taskbox resume <name>                    Touch ID",
  "taskbox end <name>                       Touch ID",
  "taskbox approver --box <box> --agent <account>, once; taskbox approver --rotate <new key>",
  'taskbox queue --as <agent> --why "<words>"',
  "taskbox wait <name>",
  'taskbox progress <name> "<words>" [--step N/M] [--can-pause|--busy], or --saved "<words>"',
  "taskbox release <name>",
  "taskbox connect <name> [-- <command>]",
];

// Flags: each known one once, with its value.
function flags(args: readonly string[], valued: readonly string[], alone: readonly string[]): { pos: string[]; f: Map<string, string | true> } | { no: string } {
  const pos: string[] = [];
  const f = new Map<string, string | true>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith("--")) {
      pos.push(a);
      continue;
    }
    const shown = a.replace(/[^\x20-\x7e]/g, "").slice(0, 20);
    if (f.has(a)) return { no: `${shown} is given twice.` };
    if (alone.includes(a)) f.set(a, true);
    else if (valued.includes(a)) {
      const v = args[i + 1];
      if (v === undefined || v.startsWith("--")) return { no: `${shown} needs a value.` };
      f.set(a, v);
      i++;
    } else return { no: `taskbox doesn't take ${shown} here.` };
  }
  return { pos, f };
}

export async function laptopMain(d: LaptopDeps, argv: readonly string[], o: { rounds?: number } = {}): Promise<number> {
  const [cmd, ...rest] = argv;
  const usage = () => {
    for (const l of LAPTOP_USAGE) d.out(l);
    return 1;
  };
  if (cmd === undefined) return ownerScreen(d, { rounds: o.rounds, clear: true });
  if (cmd === "connect") {
    const cut = rest.indexOf("--");
    const before = cut < 0 ? rest : rest.slice(0, cut);
    if (before.length !== 1) return usage();
    return connect(d, before[0], cut < 0 ? [] : rest.slice(cut + 1));
  }
  if (isWrapped(cmd)) return wrapped(d, argv);
  const owner: Record<string, { valued: string[]; alone: string[] }> = {
    approve: { valued: [], alone: [] },
    pause: { valued: [], alone: ["--now"] },
    resume: { valued: [], alone: [] },
    end: { valued: [], alone: [] },
    deny: { valued: ["--reason"], alone: [] },
    approver: { valued: ["--box", "--agent", "--rotate"], alone: [] },
  };
  const spec = Object.hasOwn(owner, cmd) ? owner[cmd] : undefined;
  if (!spec) return usage();
  const p = flags(rest, spec.valued, spec.alone);
  if ("no" in p) {
    d.out(p.no);
    return usage();
  }
  const val = (k: string) => (typeof p.f.get(k) === "string" ? (p.f.get(k) as string) : undefined);
  if (cmd === "approver") {
    if (p.pos.length) return usage();
    const a: ApproverArgs = { box: val("--box"), agent: val("--agent"), rotate: val("--rotate") };
    if (a.rotate !== undefined && (a.box !== undefined || a.agent !== undefined)) return usage();
    return approver(d, a);
  }
  if (p.pos.length !== 1) return usage();
  const name = p.pos[0]!;
  if (cmd === "deny") return ownerDeny(d, name, val("--reason"));
  if (cmd === "pause") return ownerStep(d, p.f.has("--now") ? "pause-now" : "pause", name);
  return ownerStep(d, cmd as "approve" | "resume" | "end", name);
}

// The real commands. Each gets the environment it is given and no other, so ssh-keygen never sees
// SSH_AUTH_SOCK and nothing reaches an agent.
// The most of a command's stdout and stderr kept. The rest is read and dropped, so a command that
// prints without end can't fill the laptop's memory.
export const STDOUT_MAX = 2_000_000;
export const STDERR_MAX = 64_000;

// A stream read to its end, keeping at most max characters. onLine gets each line as it comes.
async function readCapped(stream: ReadableStream<Uint8Array>, max: number, onLine?: (l: string) => void): Promise<string> {
  let all = "";
  let part = "";
  const dec = new TextDecoder();
  for await (const chunk of stream) {
    const t = dec.decode(chunk, { stream: true });
    if (all.length < max) all += t.slice(0, max - all.length);
    if (onLine) {
      part += t;
      const lines = part.split("\n");
      part = lines.pop() ?? "";
      for (const l of lines) onLine(l);
      if (part.length > 10_000) part = "";
    }
  }
  if (onLine && part) onLine(part);
  return all;
}

export async function realRun(argv: string[], o: RunOpts = {}): Promise<RunResult> {
  const p = Bun.spawn(argv, { cwd: o.cwd, env: o.env ?? baseEnv(), stdin: o.stdin === undefined ? "ignore" : new Blob([o.stdin]), stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const cancel = o.timeoutMs ? realClock.after(o.timeoutMs, () => ((timedOut = true), p.kill(9))) : undefined;
  const [stdout, stderr, code] = await Promise.all([readCapped(p.stdout, STDOUT_MAX, o.onLine), readCapped(p.stderr, STDERR_MAX), p.exited]);
  cancel?.();
  return { code, stdout, stderr, timedOut };
}

function baseEnv(): Record<string, string> {
  const e: Record<string, string> = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: homedir(), LANG: "en_GB.UTF-8" };
  for (const k of ["USER", "LOGNAME"]) if (process.env[k]) e[k] = process.env[k]!;
  if (/^[a-z0-9-]{1,32}$/.test(process.env.TERM ?? "")) e.TERM = process.env.TERM!;
  return e;
}

async function ask(q: string): Promise<string> {
  process.stdout.write(q);
  for await (const line of console) return line;
  return "";
}

if (import.meta.main) {
  const d: LaptopDeps = {
    run: realRun,
    tty: async (argv) => await Bun.spawn(argv, { env: baseEnv(), stdin: "inherit", stdout: "inherit", stderr: "inherit" }).exited,
    out: (l) => console.log(l),
    ask,
    now: () => realClock.now(),
    sleep: (ms) => realClock.sleep(ms),
    home: homedir(),
    env: baseEnv(),
    isTty: process.stdin.isTTY === true,
  };
  process.exit(await laptopMain(d, process.argv.slice(2)));
}
