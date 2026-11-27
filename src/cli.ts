#!/usr/bin/env -S /opt/taskbox/bin/bun --no-install --no-env-file --cwd=/ --config=/opt/taskbox/app/bunfig.run.toml
// taskbox: the commands at the box, the daemons, and the first install (run by install.sh). Each
// command is a file in src/cmd/ (registry.ts). This file reads the line, renames and usage, finds
// the box's accounts and paths, gates root's commands, runs the command, and writes its footer or
// its answers envelope.
import { serviceName, setServiceName } from "./names.ts";
import { lchownSync, lstatSync, readdirSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { boxNames, PROJECT_NAME, paths, readJson } from "./config.ts";
import { readRecord } from "./accounts.ts";
import { errorAnswer, readInstallId } from "./answers.ts";
import { type BoxCtx, type CliDeps, type CommandSpec, type Ctx, type ErrorBody, EXIT, type Outcome, usage } from "./command.ts";
import { elevation, isAdmin } from "./elevate.ts";
import { agree, type BoxId, cleanLine, envelope, errorFromV3, gapError, nextOf, resultOf, versionsOf } from "./envelope.ts";
import { commandList, parseLine, pathOf } from "./registry.ts";
import { renamed } from "./renames.ts";
import { sharedPaths, sharedProblem } from "./shared.ts";
import { realSys } from "./sys.ts";
import { Stop } from "./install.ts";

export type { CliDeps } from "./command.ts";
export { watcherOps } from "./cmd/daemons.ts";

async function serviceUid(service: string): Promise<number | undefined> {
  const p = Bun.spawnSync(["/usr/bin/id", "-u", service], { env: {} });
  return p.exitCode === 0 ? Number(p.stdout.toString().trim()) : undefined;
}

// Lines typed so far, shared by every question, so piped answers aren't lost between questions.
// Once input has ended, each question gets "", which every caller reads as no.
let lines: AsyncIterator<string> | undefined;
async function ask(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  lines ??= createInterface({ input: process.stdin, terminal: false })[Symbol.asyncIterator]();
  const next = await lines.next();
  if (next.done) process.stdout.write("\n");
  return next.done ? "" : next.value;
}

function chownReal(path: string, uid: number, gid: number, recursive = false): void {
  if (recursive) {
    const r = Bun.spawnSync(["/usr/sbin/chown", "-R", `${uid}:${gid}`, path], { env: {} });
    if (r.exitCode !== 0) throw new Stop(`chown failed on ${path}`);
  } else lchownSync(path, uid, gid);
}

// A command that reads the terminal itself: sudo's and fdesetup's password prompts. No environment.
function tty(argv: string[]): number {
  return Bun.spawnSync(argv, { stdin: "inherit", stdout: "inherit", stderr: "inherit", env: {} }).exitCode ?? 1;
}

const realDeps = (): CliDeps => ({
  sys: realSys,
  uid: process.getuid?.() ?? -1,
  serviceUid,
  env: process.env,
  tty,
  user: () => userInfo().username,
  ask,
  say: (l) => console.log(l),
  err: (l) => console.error(l),
  terminal: () => process.stdin.isTTY === true,
  hostname,
  root: "/",
});

// The Mac's name as MagicDNS gives it: the host name's first label, lower case, or null.
function boxName(deps: CliDeps): string | null {
  const n = (deps.hostname?.() ?? hostname()).split(".")[0]!.toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(n) ? n : null;
}

// The box's accounts from taskbox.json, or why they can't be read. rollback goes back to the kept
// install, so it reads that install's names when these can't be read.
function namesFor(spec: CommandSpec, dir: string, app: string): { project: string; service: string } | string {
  try {
    return boxNames(dir);
  } catch (e) {
    if (spec.path[0] === "rollback") {
      try {
        return boxNames(`${app.replace(/\/app$/, "")}.prev/app`);
      } catch {}
      // Settings from before v2.7.0 on both sides. This runs as the admin, before sudo, so it reads
      // what any user may: root's accounts record (0644), then which home holds a .taskbox folder
      // owned by that home's own account (the folder is 0700, but its owner shows in the listing).
      try {
        const project = readJson<{ project?: unknown }>(join(app, "taskbox.json")).project;
        if (typeof project === "string" && PROJECT_NAME.test(project)) {
          const recorded = readRecord("/opt/taskbox-state/accounts.json").inUse?.service;
          if (recorded) return { project, service: recorded };
          const owners = readdirSync("/Users").filter((n) => {
            if (n.startsWith(".") || n === "Shared") return false;
            try {
              const st = lstatSync(join("/Users", n, ".taskbox"));
              return st.isDirectory() && st.uid === lstatSync(join("/Users", n)).uid;
            } catch {
              return false;
            }
          });
          if (owners.length === 1) return { project, service: owners[0]! };
        }
      } catch {}
    }
    return (e as Error).message;
  }
}

// An error envelope, or the same in version 3's words, for a reader that asked for --json.
function errorJson(c: { deps: CliDeps; answers: number }, command: string, exit: number, error: ErrorBody, v3word: Parameters<typeof errorAnswer>[0]): string {
  if (c.answers === 3) return JSON.stringify(errorAnswer(v3word));
  return JSON.stringify(envelope({ command, box: null, at: c.deps.sys("/").now(), exit, lines: [error.message], error }));
}

// A failed command's error, from its own lines: the first line of its text, and its Next as the fix.
function errorOf(exit: number, lines: string[]): ErrorBody | null {
  if (exit === 0) return null;
  const body = lines.filter((l) => l !== "" && !/^(Now|Did|Next): /.test(l));
  const next = lines.findLast((l) => l.startsWith("Next: "));
  return { code: exit === EXIT.usage ? "usage" : exit === EXIT.timeout ? "timeout" : exit === EXIT.denied ? "denied" : "failed", message: body[0] ?? lines[0] ?? "The command failed.", fix: next ? next.slice(6) : null, who: null };
}

export async function main(argv: string[], deps: CliDeps = realDeps()): Promise<number> {
  const say = deps.say;
  const err = deps.err ?? ((l: string) => console.error(l));
  const APP = join(deps.root, "opt/taskbox/app");
  const words = argv.length ? argv : ["status"];
  const json = words.includes("--json");
  const now = () => deps.sys("/").now();

  // taskbox --help: the commands.
  if (words[0] === "--help" || words[0] === "help") {
    say(commandList());
    say("Type taskbox and a command with --help for its flags.");
    return EXIT.ok;
  }

  // Each of v2.6.0's old names prints one line and exits 2. Said before anything is read, so it needs no settings.
  const old = renamed(
    words,
    (() => {
      try {
        return boxNames(APP).service;
      } catch {
        return serviceName();
      }
    })(),
  );
  if (old) {
    say(json ? JSON.stringify(envelope({ command: "error", box: null, at: now(), exit: EXIT.usage, lines: [old.line], error: { code: "renamed", message: old.line, fix: `taskbox ${old.replacement}`, who: null, replacement: old.replacement } })) : old.line);
    return EXIT.usage;
  }

  const parsed = parseLine(words, deps.specs);
  if (!parsed.ok) {
    const lines = [parsed.line, parsed.usage ?? commandList()];
    say(json ? JSON.stringify(envelope({ command: parsed.path ? parsed.path.join(".") : "error", box: null, at: now(), exit: EXIT.usage, lines, error: { code: "usage", message: parsed.line, fix: parsed.usage ?? null, who: null } })) : lines.join("\n"));
    return EXIT.usage;
  }
  const spec = parsed.spec;
  if (parsed.help) {
    say(spec.summary);
    say(usage(spec));
    return EXIT.ok;
  }
  // --version: this taskbox's release, from its install record.
  if (parsed.version) {
    let tag: unknown;
    try {
      tag = readJson<{ tag?: unknown }>(join(deps.root, "opt/taskbox/installed.json")).tag;
    } catch {}
    say(`taskbox ${typeof tag === "string" ? cleanLine(tag).slice(0, 30) : "(release not known)"}`);
    return EXIT.ok;
  }
  // The answers version this reader takes: one number, or for hello the list it reads.
  const theirs = parsed.answers === undefined ? [4] : versionsOf(parsed.answers);
  if (!theirs || (spec.path[0] !== "hello" && theirs.length !== 1)) {
    say(`--answers takes a version, such as 4${spec.path[0] === "hello" ? ", or the versions you read, such as 4,3" : ""}.`);
    return EXIT.usage;
  }
  const answers = agree(theirs);

  const base: Ctx = {
    argv: words,
    spec,
    args: parsed.args,
    opts: parsed.opts,
    flags: parsed.flags,
    json: parsed.flags.json === true,
    answers: answers ?? 4,
    deps,
    uid: deps.uid,
    env: deps.env,
    say,
    err,
    ask: deps.ask,
    tty: deps.tty,
    chown: deps.chown ?? chownReal,
    root: deps.root,
    app: APP,
  };
  if (base.json && answers === undefined) {
    const e = gapError(theirs);
    say(JSON.stringify(envelope({ command: spec.path.join("."), box: null, at: now(), exit: EXIT.failed, lines: [e.message], error: e })));
    return EXIT.failed;
  }

  if (spec.first) {
    const exit = await spec.first(base);
    if (exit !== undefined) return exit;
  }
  if (spec.early) return exitOf(await spec.early(base));

  // The project this box serves, from taskbox.json: one per box.
  const names = namesFor(spec, spec.namesFrom?.(base) ?? APP, APP);
  if (typeof names === "string") {
    say(base.json ? errorJson(base, spec.path.join("."), EXIT.failed, errorFromV3("state-unreadable"), "state-unreadable") : `${names}, so taskbox can't run. Nothing to do: agents fix it.`);
    return EXIT.failed;
  }
  const own = paths(deps.root, names);
  const S = own.service;
  // Every line the owner reads names this account (names.ts).
  setServiceName(S);
  const cu = await deps.serviceUid(S);
  const { uid } = deps;
  // Anyone but the service account and root reads the copies every user may read (shared.ts), from a folder that is
  // its alone. A folder that isn't is read as no state at all, and said once.
  const reader = uid !== cu && uid !== 0;
  const shared = reader && spec.sharedReads === true;
  const why = reader ? sharedProblem(own, cu) : undefined;
  // With --json, a controller reads one line of JSON: an error in taskbox's own words, no path.
  if (shared && why && base.json) {
    say(errorJson(base, spec.path.join("."), EXIT.failed, errorFromV3("state-unreadable"), "state-unreadable"));
    return EXIT.failed;
  }
  if (shared && why) say(`The box's state can't be shown to you: ${why}. Nothing to do: agents fix it.`);
  const p = shared ? sharedPaths(why ? { ...own, shared: "/nonexistent/taskbox-state" } : own) : own;
  const sys = deps.sys(uid === cu ? p.serviceHome : (deps.env.HOME ?? "/"));
  const view = reader ? sharedPaths(why ? { ...own, shared: "/nonexistent/taskbox-state" } : own) : own;
  const c: BoxCtx = { ...base, names, own, p, S, cu, view, ops: { sys, paths: p, uid, serviceUid: cu, say, ask: deps.ask } };
  const name = boxName(deps);

  // On a box, --box must name this box, so a script written for the controller runs here unchanged.
  if (typeof c.flags.box === "string" && c.flags.box.toLowerCase() !== name) {
    const line = `This is ${name ?? "this box"}: --box ${cleanLine(c.flags.box).slice(0, 63)} names another box.`;
    say(c.json ? errorJson(c, spec.path.join("."), EXIT.usage, { code: "usage", message: line, fix: null, who: null }, "usage") : line);
    return EXIT.usage;
  }

  // The owner's signed step: the agent account's shell carries it to the guard through the agent
  // spool, and the guard's handler for this action applies it (core/asker.ts, core/dispatch.ts).
  // The command's own run never runs then, and the Touch ID was the confirmation. A command that
  // takes --signed, run without it, runs only for the service account and root, unless its unsigned
  // run is a request that gives nobody more (spec.unsigned).
  if ((spec.flags ?? []).includes("signed")) {
    if (typeof c.flags.signed === "string") {
      const { signedRun } = await import("./core/asker.ts");
      const s: CommandSpec = { path: spec.path, summary: spec.summary, who: spec.who, ...(spec.flags ? { flags: spec.flags } : {}), shell: true, run: signedRun, did: "Sent the signed request." };
      const sc: BoxCtx = { ...c, spec: s };
      return sc.json ? answer(sc, name) : text(sc, say);
    }
    if (uid !== cu && uid !== 0 && !spec.unsigned) {
      // One an admin may run at the box goes through sudo, as root's commands do.
      if (spec.who.includes("admin") && !deps.env.SSH_CONNECTION && !deps.env.SSH_CLIENT && (await isAdmin(sys, deps.user()))) {
        const e = elevation(pathOf(spec), words.slice(spec.path.length), true);
        (c.json ? err : say)(e.say);
        return e.argv ? deps.tty(e.argv) : EXIT.failed;
      }
      const line = `taskbox ${pathOf(spec)} from here needs an approver key's signature: run it from the controller.`;
      say(c.json ? errorJson(c, spec.path.join("."), EXIT.failed, { code: "denied", message: line, fix: null, who: null }, "usage") : line);
      return EXIT.failed;
    }
  }

  if (spec.root) {
    if (uid !== 0) {
      const e = elevation(pathOf(spec), words.slice(spec.path.length), await isAdmin(sys, deps.user()));
      (c.json ? err : say)(e.say);
      return e.argv ? deps.tty(e.argv) : EXIT.failed;
    }
    const by = deps.env.SUDO_USER;
    if (!by || by === "root") {
      say(`Log in as your admin user, then type taskbox ${pathOf(spec)}.`);
      return EXIT.failed;
    }
  }

  // A typed confirmation with no terminal and no --yes is a usage error.
  if (spec.typed && c.flags.yes === undefined && !(deps.terminal?.() ?? true)) {
    // A command with --yes asks a typed yes; one without needs a person at the terminal itself (remove's
    // typed name and deletes, unlock's fdesetup).
    const line = (spec.flags ?? []).includes("yes") ? `taskbox ${pathOf(spec)} asks for a typed yes, and there is no terminal here. Add --yes to answer it.` : `taskbox ${pathOf(spec)} asks a person at the terminal, and there is no terminal here. Run it at the box's own terminal.`;
    say(c.json ? errorJson(c, spec.path.join("."), EXIT.usage, { code: "usage", message: line, fix: null, who: "at-the-box" }, "usage") : line);
    return EXIT.usage;
  }

  if (spec.raw) return exitOf(await spec.run!(c));
  if (!c.json) return text(c, say);
  return answer(c, name);
}

const exitOf = (o: Outcome) => (typeof o === "number" ? o : o.exit);

// The footer every command's text ends with: Now, Did and Next. A handler that wrote its own
// keeps it; one that didn't gets one here, on stderr beside a file.
async function withFooter(c: BoxCtx, said: string[], o: Outcome, to: (l: string) => void): Promise<void> {
  if (c.spec.internal && c.spec.path[0] !== "hello") return;
  if (said.findLast((l) => l.trim() !== "")?.startsWith("Next: ")) return;
  const { stateNow } = await import("./ops.ts");
  const { footer } = await import("./state.ts");
  const out: { did?: string; next?: string } = typeof o === "number" ? {} : o;
  const lines = footer(await stateNow({ ...c.ops, paths: c.view }), out.did ?? c.spec.did ?? "Nothing changed.", out.next);
  for (const l of lines) to(l);
}

async function text(c: BoxCtx, say: (l: string) => void): Promise<number> {
  const said: string[] = [];
  const tee = (l: string) => {
    said.push(l);
    say(l);
  };
  const t: BoxCtx = { ...c, say: tee, ops: { ...c.ops, say: tee } };
  const o = await c.spec.run!(t);
  const file = typeof c.spec.file === "function" ? c.spec.file(c) : c.spec.file === true;
  await withFooter(t, said, o, file ? c.err : tee);
  return exitOf(o);
}

// Which box answers: its name, install ID and release.
function boxOf(c: BoxCtx, name: string | null): BoxId {
  let release: string | null = null;
  try {
    const tag = readJson<{ tag?: unknown }>(c.own.installed).tag;
    release = typeof tag === "string" && /^v\d{1,4}\.\d{1,4}\.\d{1,4}(-rc\.\d{1,4})?$/.test(tag) ? tag.slice(1) : null;
  } catch {}
  return { name, installId: readInstallId(c.own.installId) ?? null, release };
}

// --json: one envelope. Its lines are the text form's, footer included; its result is the
// command's own fields, the same as its version 3 line. A reader that asked for version 3 gets that line.
async function answer(c: BoxCtx, name: string | null): Promise<number> {
  const spec = c.spec;
  const command = spec.path.join(".");
  const quiet: BoxCtx = { ...c, json: false };
  if (c.answers === 3) {
    if (!spec.answer) {
      c.say(JSON.stringify(errorAnswer("usage")));
      return EXIT.usage;
    }
    const a = await spec.answer(quiet);
    c.say(JSON.stringify(a.v3));
    return a.exit;
  }
  let result: Record<string, unknown> | null = null;
  let error: ErrorBody | null = null;
  let changed = false;
  let lines: string[];
  let exit: number;
  const a = spec.answer ? await spec.answer(quiet) : undefined;
  if (a && a.v3.kind === "error") {
    error = errorFromV3(a.v3.error);
    lines = [error.message];
    exit = a.exit || EXIT.failed;
  } else {
    if (a) result = a.result ?? resultOf(a.v3);
    const said: string[] = [];
    const push = (l: string) => void said.push(l);
    // A streaming command's changes go out as they come, each its own envelope, before the final one.
    const stream = spec.streams && (c.flags.watch || c.flags.follow) ? (ls: string[], r?: Record<string, unknown>) => c.say(JSON.stringify(envelope({ command, box: boxOf(c, name), at: c.ops.sys.now(), exit: 0, result: r ?? {}, lines: ls, final: false }))) : undefined;
    const t: BoxCtx = { ...quiet, say: push, err: push, ops: { ...c.ops, say: push }, ...(stream ? { stream } : {}) };
    let o: Outcome;
    if (a && spec.linesFrom) {
      said.push(...spec.linesFrom(result!));
      o = { exit: a.exit };
    } else o = await spec.run!(t);
    await withFooter(t, said, o, push);
    lines = said;
    exit = a ? a.exit : exitOf(o);
    if (typeof o !== "number") {
      changed = o.changed ?? false;
      if (!a && o.result) result = o.result;
      if (o.error) error = o.error;
    }
    if (!a && result === null) result = {};
    if (!spec.verdict) error ??= errorOf(exit, lines);
  }
  const box = boxOf(c, name);
  const known = (w: string[]) => {
    const r = parseLine(w, c.deps.specs);
    return r.ok && !r.spec.internal ? pathOf(r.spec) : undefined;
  };
  c.say(JSON.stringify(envelope({ command, box, at: c.ops.sys.now(), exit, changed, result, lines, error, next: nextOf(lines, known) })));
  return exit;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
