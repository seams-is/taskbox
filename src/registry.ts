// The command registry: every file in src/cmd/ exports `commands`, a list of CommandSpec. cli.ts runs
// them, shell.ts lets the agent account run those marked shell, and elevate.ts re-runs those marked
// root through sudo. A later package adds its noun as one more file there, and one line in each list
// of src/cmd/index.ts, which imports them all so the compiled engine reads nothing from disk.
import { commandFiles } from "./cmd/index.ts";
import { type CommandSpec, GLOBAL_FLAGS, type GlobalFlag, parse, type Parsed } from "./command.ts";

// A statement's action (core/statement.ts ACTION): a word, or two with a dot.
const ACTION = /^[a-z][a-z0-9-]{0,31}(\.[a-z][a-z0-9-]{0,31})?$/;

// One file of src/cmd/, as src/cmd/index.ts names it: its name and what it exports.
export interface CommandFile {
  file: string;
  module: { commands?: unknown };
}
const WORD = /^[a-z][a-z0-9-]{0,30}$/;
const ALL_NAMES = new Set<string>([...Object.values(GLOBAL_FLAGS).flatMap((g) => [...g.names]), "--help", "--version", "--answers"]);

// Why a list of commands can't be the registry, or undefined. Each path is unique, and none is a
// verb with words of its own that a longer path starts with: `release NAME` beside `release list`
// would read `list` as a name.
export function registryProblem(specs: readonly CommandSpec[]): string | undefined {
  const seen = new Set<string>();
  for (const s of specs) {
    const key = s.path.join(" ");
    if (!s.path.length || !s.path.every((w) => WORD.test(w))) return `a command's path isn't words: ${JSON.stringify(s.path)}`;
    if (seen.has(key)) return `two commands are taskbox ${key}`;
    seen.add(key);
    if (!s.run === !s.early) return `taskbox ${key} needs one of run and early`;
    for (const f of s.flags ?? []) if (!(f in GLOBAL_FLAGS)) return `taskbox ${key} names a global flag that isn't one: ${f}`;
    const own = new Set<string>();
    for (const o of s.options ?? []) {
      if (!/^--[a-z][a-z0-9-]*$/.test(o.name)) return `taskbox ${key}'s flag ${o.name} isn't a long flag`;
      if (ALL_NAMES.has(o.name)) return `taskbox ${key}'s flag ${o.name} is a global flag`;
      if (own.has(o.name)) return `taskbox ${key} has ${o.name} twice`;
      own.add(o.name);
    }
    if (s.args && (s.args.min < 0 || s.args.max < s.args.min)) return `taskbox ${key}'s words are out of order`;
    if (s.root && s.shell) return `taskbox ${key} can't be both root's and the agent shell's`;
    if (s.answer && !(s.flags ?? []).includes("json")) return `taskbox ${key} has an answer but no --json`;
    // A signed step reaches the guard only through the agent account's shell, and runs no handler here.
    if ((s.flags ?? []).includes("signed")) {
      if (!s.shell || s.raw || s.early || s.first) return `taskbox ${key} takes --signed, so it must be the agent shell's, with no raw words, early or first`;
      // Its path is the statement's action, and its words go in the args as words.
      if (!ACTION.test(s.path.join("."))) return `taskbox ${key} takes --signed, and a statement can't name ${s.path.join(".")}`;
      if ((s.options ?? []).some((o) => o.name === "--words")) return `taskbox ${key} takes --signed, so it can't have a flag named --words`;
    }
  }
  for (const s of specs) {
    if (!s.args?.max && !s.raw) continue;
    const longer = specs.find((t) => t !== s && t.path.length > s.path.length && s.path.every((w, i) => t.path[i] === w));
    if (longer) return `taskbox ${s.path.join(" ")} takes words, and taskbox ${longer.path.join(" ")} starts with it`;
  }
  return undefined;
}

// Every command, from the files given, in file order. Throws when one doesn't fit.
export function loadRegistry(files: readonly CommandFile[] = commandFiles): CommandSpec[] {
  const specs: CommandSpec[] = [];
  for (const { file, module: m } of [...files].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))) {
    if (!Array.isArray(m.commands)) throw new Error(`src/cmd/${file} exports no commands`);
    specs.push(...(m.commands as CommandSpec[]));
  }
  const why = registryProblem(specs);
  if (why) throw new Error(`The command registry: ${why}`);
  return specs;
}

let cached: CommandSpec[] | undefined;
export function registry(): CommandSpec[] {
  cached ??= loadRegistry();
  return cached;
}

export const parseLine = (argv: readonly string[], specs: readonly CommandSpec[] = registry()): Parsed => parse(specs, argv);

// The commands the agent account's shell runs, and those that need root, by their paths.
export const shellCommands = (specs = registry()) => specs.filter((s) => s.shell);
export const rootCommands = (specs = registry()) => specs.filter((s) => s.root);
export const pathOf = (s: CommandSpec) => s.path.join(" ");
// The first word of each command a list holds, once each, in order: what help and the shell name.
export const firstWords = (specs: readonly CommandSpec[]) => [...new Set(specs.map((s) => s.path[0]!))];
export const takes = (s: CommandSpec, f: GlobalFlag) => (s.flags ?? []).includes(f);

// The commands a person may type, for help and for a command that isn't one.
export function commandList(specs: readonly CommandSpec[] = registry()): string {
  const shown = specs.filter((s) => !s.internal);
  return `Commands: ${firstWords(shown.filter((s) => !s.root)).join(", ")}, and as your admin user: ${firstWords(shown.filter((s) => s.root)).join(", ")}.`;
}
