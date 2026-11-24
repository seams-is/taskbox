// What a command is, and how a command line is read (v3 design, §2.1 to §2.3). Each noun's commands
// are one file in src/cmd/, found by src/registry.ts, and read by cli.ts, shell.ts and elevate.ts.
// So a later package adds a command by adding a file, and edits no shared one.
//
// A file in src/cmd/ imports types and small helpers only. Its handlers import what they run when
// they run, so the agent account's shell can read every command's name and flags without loading the box.
import type { Paths } from "./config.ts";
import type { OpsDeps } from "./ops.ts";
import type { Sys } from "./sys.ts";

// Exit codes (§2.4). Readers exit 0 whenever they could report: health lives in check.
export const EXIT = { ok: 0, failed: 1, usage: 2, timeout: 3, denied: 4, interrupted: 130 } as const;

// The global flags (§2.2). Every command takes each one it declares, and refuses the others with
// exit 2. --help, --version, --answers and --box are taken by every command.
export const GLOBAL_FLAGS = {
  json: { names: ["--json"] },
  watch: { names: ["-w", "--watch"] },
  follow: { names: ["-f", "--follow"] },
  timeout: { names: ["--timeout"], value: "DURATION" },
  detach: { names: ["--detach"] },
  force: { names: ["--force"] },
  yes: { names: ["-y", "--yes"] },
  dryRun: { names: ["--dry-run"] },
  box: { names: ["--box"], value: "NAME" },
  since: { names: ["--since"], value: "TIME" },
  until: { names: ["--until"], value: "TIME" },
  tail: { names: ["-n", "--tail"], value: "N" },
} as const;
export type GlobalFlag = keyof typeof GLOBAL_FLAGS;
// Taken by every command: --help, --version, --answers (the reader's version, §3.1) and --box.
export const ALWAYS = ["--help", "--version", "--answers", "--box"] as const;

// A duration: 90s, 30m, 1h, 2d, or 0 for no limit (§2.2). In ms, or undefined when it isn't one.
export function duration(v: string): number | undefined {
  if (v === "0") return 0;
  const m = /^([1-9]\d{0,5})([smhd])$/.exec(v);
  if (!m) return undefined;
  return Number(m[1]) * { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "s" | "m" | "h" | "d"];
}
// A memory size in M or G (§2.2). In MiB, or undefined.
export function memory(v: string): number | undefined {
  const m = /^([1-9]\d{0,6})([MG])$/.exec(v);
  return m ? Number(m[1]) * (m[2] === "G" ? 1024 : 1) : undefined;
}
const count = (v: string) => /^[1-9]\d{0,4}$/.test(v);
// A value's check for the global flags that take one. --since and --until take a duration or an ISO time.
const GLOBAL_CHECKS: Partial<Record<GlobalFlag, (v: string) => boolean>> = {
  timeout: (v) => duration(v) !== undefined,
  tail: count,
  since: (v) => duration(v) !== undefined || /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/.test(v),
  until: (v) => duration(v) !== undefined || /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/.test(v),
  box: (v) => /^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/.test(v),
};

// A command's own flag: --away, --to VERSION, --admin NAME given more than once.
export interface Option {
  name: string;
  value?: string; // the value's name in help; none for a flag that is on or off
  check?: (v: string) => boolean;
  repeat?: boolean;
}

// Who may run a command (§2.3), for help and the shell. The checks themselves stay in each handler.
export type Role = "anyone" | "agent" | "pool" | "service" | "admin" | "owner" | "launchd";

export interface CommandSpec {
  path: string[]; // ["job", "list"]; one word for the box's own verbs
  summary: string; // one line, for help
  who: Role[];
  flags?: GlobalFlag[];
  options?: Option[];
  args?: { name: string; min: number; max: number; check?: (v: string) => boolean };
  // The agent account's shell runs it (shell.ts).
  shell?: boolean;
  // It needs root: anyone else's run goes through sudo, or is told to switch users (elevate.ts).
  root?: boolean;
  // Internal: launchd's daemons, the install, hello. Not in help.
  internal?: boolean;
  // A typed confirmation: with no terminal and no --yes it is a usage error (§2.2).
  typed?: boolean;
  // Readers that anyone but the service account and root reads from the copies every user may read (shared.ts).
  sharedReads?: boolean;
  // Its own parser checks every word (the workspace agent's commands, #47). No flag is read here.
  raw?: boolean;
  // For a raw command: the verb #47's parser (workspace/agent.ts) knows it by, where that isn't its
  // first word. workspace end is #47's release.
  agent?: string;
  // Its exit 1 is a verdict (check: a row failed), not a failure of the command: the envelope carries
  // the whole result, with no error.
  verdict?: boolean;
  // Its text is a file to copy (YAML, a policy file): the footer goes to stderr.
  file?: boolean | ((c: Ctx) => boolean);
  // Rules between its words and flags that a flag's own check can't see. A line saying why, or undefined.
  check?: (p: { args: string[]; opts: Values; flags: Partial<Record<GlobalFlag, string | true>> }) => string | undefined;
  // The folder whose settings name the box's accounts, where it isn't the installed one: the first
  // install's downloaded folder.
  namesFrom?: (c: Ctx) => string | undefined;
  // What the footer's Did line says when the handler doesn't say.
  did?: string;
  // Runs before the box's settings are read: the rollback watcher, the lines for hold and share.
  early?: (c: Ctx) => Promise<Outcome>;
  run?: (c: BoxCtx) => Promise<Outcome>;
  // The answer in version 3, for --json (§3.1): the same command's v2.x JSON line. Its fields
  // become the v4 envelope's result.
  // result: the v4 result, where it isn't the v3 line's own fields.
  answer?: (c: BoxCtx) => Promise<{ v3: Record<string, unknown>; exit: number; result?: Record<string, unknown> }>;
  // The envelope's lines made from the result, where running the text form again would repeat slow
  // work (check's rows).
  linesFrom?: (result: Record<string, unknown>) => string[];
}

// An error, as the envelope carries it (§3.1, §3.5).
export const ERROR_CODES = ["usage", "renamed", "denied", "expired", "not-found", "busy", "refused-over-ssh", "signature", "unreachable", "timeout", "failed", "stale-state", "needs-confirm"] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];
export const WHO = ["waits", "from-away", "at-the-box"] as const;
export interface ErrorBody {
  code: ErrorCode;
  message: string;
  fix: string | null;
  who: (typeof WHO)[number] | null;
  replacement?: string;
}

// What a handler gives back: an exit code, or the code with what the envelope says.
export type Outcome =
  | number
  | {
      exit: number;
      result?: Record<string, unknown>;
      changed?: boolean;
      did?: string;
      next?: string;
      error?: ErrorBody;
    };

// What main reads from the world. Tests pass their own; the process entry passes none.
export interface CliDeps {
  sys(home: string): Sys;
  uid: number;
  serviceUid(service: string): Promise<number | undefined>;
  env: Record<string, string | undefined>;
  tty(argv: string[]): number;
  user(): string;
  ask(prompt: string): Promise<string>;
  say(line: string): void;
  root: string; // where /opt/taskbox and the other paths are: / on a box
  // Who owns what the root commands write. Tests pass their own; the box's is chown.
  chown?(path: string, uid: number, gid: number, recursive?: boolean): void;
  // Human text in --json mode, and a footer beside a file: stderr. Tests record it.
  err?(line: string): void;
  // Whether a person can answer a typed confirmation. Tests that leave it out have one.
  terminal?(): boolean;
  // This Mac's name, for the envelope's box.name. The real one reads the host name.
  hostname?(): string;
  // Tests: whether the guard's watch goes on. launchd's guard runs until it is stopped.
  guardTicks?(): boolean;
}

export type Values = Record<string, string | true | string[]>;

export interface Ctx {
  argv: string[];
  spec: CommandSpec;
  args: string[]; // the positional words after the path
  opts: Values; // the command's own flags, by name without the dashes
  flags: Partial<Record<GlobalFlag, string | true>>;
  json: boolean;
  answers: number; // the answers version this reader takes (§3.1)
  deps: CliDeps;
  uid: number;
  env: Record<string, string | undefined>;
  say(line: string): void;
  err(line: string): void;
  ask(prompt: string): Promise<string>;
  tty(argv: string[]): number;
  chown(path: string, uid: number, gid: number, recursive?: boolean): void;
  root: string;
  app: string; // /opt/taskbox/app under root
}

// The box's own context, read once settings are: which accounts, which paths, what the reader may see.
export interface BoxCtx extends Ctx {
  names: { project: string; service: string };
  own: Paths; // the box's own paths
  p: Paths; // what this user reads: the own paths, or the copies every user may read
  S: string; // the service account
  cu: number | undefined; // its uid
  ops: OpsDeps;
}

export type Parsed =
  | { ok: true; spec: CommandSpec; path: string[]; args: string[]; opts: Values; flags: Partial<Record<GlobalFlag, string | true>>; help: boolean; version: boolean; answers?: string }
  | { ok: false; line: string; usage?: string; path?: string[] };

// The usage line help prints, and every usage error ends with.
export function usage(s: CommandSpec): string {
  const parts = [`taskbox ${s.path.join(" ")}`];
  if (s.args) parts.push(s.args.min ? s.args.name : `[${s.args.name}]`);
  for (const o of s.options ?? []) parts.push(`[${o.name}${o.value ? ` ${o.value}` : ""}]${o.repeat ? "..." : ""}`);
  for (const f of s.flags ?? []) {
    const g = GLOBAL_FLAGS[f];
    parts.push(`[${g.names.at(-1)}${"value" in g ? ` ${g.value}` : ""}]`);
  }
  return `Usage: ${parts.join(" ")}`;
}

const clean = (v: string) => v.replace(/[^\x20-\x7e]/g, "").slice(0, 40);

// One command line against the commands. The path is the longest run of leading words that names a
// command; every word after it is a flag, a flag's value, or one of the command's own words.
export function parse(specs: readonly CommandSpec[], argv: readonly string[]): Parsed {
  let spec: CommandSpec | undefined;
  for (const s of specs) if (s.path.every((w, i) => argv[i] === w) && (!spec || s.path.length > spec.path.length)) spec = s;
  if (!spec) {
    const first = argv[0] ?? "";
    const nouns = specs.filter((s) => s.path.length > 1 && s.path[0] === first && !s.internal);
    if (nouns.length) return { ok: false, line: `taskbox ${clean(first)} takes ${[...new Set(nouns.map((s) => s.path[1]!))].join(", ")}.`, path: [first] };
    return { ok: false, line: `No command ${clean(first)}.` };
  }
  const path = spec.path;
  const rest = argv.slice(path.length);
  if (spec.raw) return { ok: true, spec, path, args: [...rest], opts: {}, flags: {}, help: false, version: false };
  const name = `taskbox ${path.join(" ")}`;
  const bad = (line: string): Parsed => ({ ok: false, line, usage: usage(spec), path });
  const flags: Partial<Record<GlobalFlag, string | true>> = {};
  const opts: Values = {};
  const args: string[] = [];
  let help = false;
  let version = false;
  let answers: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const word = rest[i]!;
    if (!word.startsWith("-") || word === "-") {
      args.push(word);
      continue;
    }
    const eq = word.indexOf("=");
    const flag = eq > 0 && word.startsWith("--") ? word.slice(0, eq) : word;
    const inline = eq > 0 && word.startsWith("--") ? word.slice(eq + 1) : undefined;
    const take = (what: string): string | Parsed => {
      if (inline !== undefined) return inline;
      const v = rest[i + 1];
      if (v === undefined || (v.startsWith("-") && v !== "0")) return bad(`${flag} needs ${what}.`);
      i++;
      return v;
    };
    if (flag === "--help") help = true;
    else if (flag === "--version") version = true;
    else if (flag === "--answers") {
      const v = take("a version, such as 4");
      if (typeof v !== "string") return v;
      answers = v;
    } else {
      const g = (Object.keys(GLOBAL_FLAGS) as GlobalFlag[]).find((k) => (GLOBAL_FLAGS[k].names as readonly string[]).includes(flag));
      const o = (spec.options ?? []).find((x) => x.name === flag);
      if (g) {
        // --box goes with every command: on a box it must name that box (§2.1), checked once settings are read.
        if (g !== "box" && !(spec.flags ?? []).includes(g)) return bad(`${name} doesn't take ${flag}.`);
        if (flags[g] !== undefined) return bad(`${flag} is given twice.`);
        const def = GLOBAL_FLAGS[g];
        if ("value" in def) {
          const v = take(def.value === "N" ? "a number" : def.value === "DURATION" ? "a time, such as 90s, 30m or 1h" : `a ${def.value.toLowerCase()}`);
          if (typeof v !== "string") return v;
          if (GLOBAL_CHECKS[g] && !GLOBAL_CHECKS[g]!(v)) return bad(`${flag} doesn't take ${clean(v)}.`);
          flags[g] = v;
        } else if (inline !== undefined) return bad(`${flag} takes no value.`);
        else flags[g] = true;
      } else if (o) {
        const key = o.name.replace(/^-+/, "");
        if (opts[key] !== undefined && !o.repeat) return bad(`${flag} is given twice.`);
        if (o.value) {
          const v = take(o.value.toLowerCase().replace(/_/g, " "));
          if (typeof v !== "string") return v;
          if (o.check && !o.check(v)) return bad(`${flag} doesn't take ${clean(v)}.`);
          opts[key] = o.repeat ? [...((opts[key] as string[] | undefined) ?? []), v] : v;
        } else if (inline !== undefined) return bad(`${flag} takes no value.`);
        else opts[key] = true;
      } else return bad(`${name} doesn't take ${clean(flag)}.`);
    }
  }
  if (!help && !version) {
    const a = spec.args;
    const max = a?.max ?? 0;
    if (args.length > max) return bad(max ? `${name} takes at most ${max === 1 ? `one ${a!.name}` : `${max} words`}.` : `${name} takes no word after it, and ${clean(args[0]!)} isn't a flag.`);
    if (a && args.length < a.min) return bad(`${name} needs ${a.name}.`);
    if (a?.check) for (const v of args) if (!a.check(v)) return bad(`${name} doesn't take ${clean(v)}.`);
    const why = spec.check?.({ args, opts, flags });
    if (why) return bad(why);
  }
  return { ok: true, spec, path, args, opts, flags, help, version, ...(answers !== undefined ? { answers } : {}) };
}
