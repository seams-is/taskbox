// taskbox on the controller, run by bin/taskbox as the owner's user. One grammar with the box: box
// commands go through forward.ts with --box; box, self, statusline and mcp are the controller's own.
import { existsSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { createInterface } from "node:readline/promises";
import { type CommandSpec, EXIT, type GlobalFlag, parse, usage } from "../command.ts";
import { realClock } from "../clock.ts";
import { envelope } from "../envelope.ts";
import { commandList, registry, shellCommands, firstWords } from "../registry.ts";
import { verifyRelease } from "../release.ts";
import { check } from "./check.ts";
import { grouped, makeKey } from "./signer.ts";
import { isKeyFlow, keyMain, trustingPhase } from "./keyflows.ts";
import { ghAt, notifyOnce, postArgv } from "./notify.ts";
import { ownerScreen } from "./screen.ts";
import { agentShellArgv, fix, setup } from "./setup.ts";
import { eventLine, readEvents } from "./events.ts";
import { asciiJson, forward } from "./forward.ts";
import { agentProblem, findBox, GITHUB_NAME, home, NAME, ownVersion, readConfig, REPO } from "./home.ts";
import { readLines, serve } from "./mcp.ts";
import { AFTER, boxRemove, boxUse, pair } from "./pair.ts";
import { configOrStop, connectBox, type Deps, isStop, tailnetOrStop } from "./reach.ts";
import { ENV, realRun } from "./run.ts";
import { footer, header, type Screen } from "./screens.ts";
import { readSaved, statusLine } from "./statusline.ts";
import { rollback, update, type UpdateDeps, updateNote } from "./update.ts";

// ssh-keygen for verifyRelease, through the controller's runner: a full path, the fixed environment,
// the statement as its whole input, and a time limit.
export const keygen = {
  run: async (cmd: string, args: string[], opts?: { stdin?: string | Uint8Array; timeoutMs?: number }) => {
    const stdin = typeof opts?.stdin === "string" ? new TextEncoder().encode(opts.stdin) : opts?.stdin;
    const r = await realRun([cmd, ...args], { limitMs: opts?.timeoutMs ?? 20_000, maxBytes: 64_000, stdin });
    return { code: r.code ?? 1, stdout: r.stdout, stderr: r.stderr };
  },
};

const NAME_WORD = { name: "NAME", min: 1, max: 1, check: (v: string) => NAME.test(v) };
const spec = (path: string[], summary: string, o: Partial<CommandSpec> = {}): CommandSpec => ({ path, summary, who: ["owner"], ...o });

// The controller's own commands. The box's are in src/cmd/, and run here with --box.
export const CONTROLLER: CommandSpec[] = [
  spec(["box", "add"], "Pairs a box tagged tag:taskbox in this controller's Tailscale, then reads what it still needs.", { args: { name: "NAME", min: 0, max: 1, check: NAME_WORD.check }, options: [{ name: "--agent", value: "ACCOUNT", check: (v) => agentProblem(v) === undefined }, { name: "--jobs-repo", value: "REPO", check: (v) => REPO.test(v) }], flags: ["yes"] }),
  spec(["box", "list"], "The paired boxes: name, Tailscale ID, install ID, agent account, release, reachable.", { flags: ["json"] }),
  spec(["box", "show"], "One pairing, and its last status.", { args: NAME_WORD, flags: ["json"] }),
  spec(["box", "use"], "Sets the box a command goes to when it names none.", { args: NAME_WORD }),
  spec(["box", "remove"], "Forgets a pairing, after its name is typed. Nothing changes on the box.", { args: NAME_WORD }),
  spec(["self", "update"], "Updates this controller's taskbox from signed releases on its channel.", { options: [{ name: "--check" }, { name: "--to", value: "VERSION" }, { name: "--auto" }], flags: ["json"] }),
  spec(["self", "rollback"], "Back to the release kept beside the one in use."),
  spec(["self", "check"], "This controller's own checks, Tailscale first, and each pairing. --fix puts right what it can, after one yes.", { flags: ["json"], options: [{ name: "--fix" }] }),
  spec(["self", "events"], "This controller's own event log: pairings, defaults, self updates.", { flags: ["since", "json"] }),
  spec(["sign"], "Signs a draft release with this Mac's release key and publishes it, through your GitHub session. --fingerprint shows the pinned keys; --revoke a release's signer change.", { args: { name: "VERSION", min: 0, max: 1, check: (v) => /^v?\d{1,4}\.\d{1,4}\.\d{1,4}(-rc\.[1-9]\d{0,3})?$/.test(v) }, options: [{ name: "--fingerprint" }, { name: "--revoke" }, { name: "--key", value: "FILE" }, { name: "--repo", value: "OWNER/NAME", check: (v) => /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/.test(v) }] }),
  spec(["self", "setup"], "Sets up the agents user, the projects folder, their sign-ins and notifications. Re-run, it resumes."),
  spec(["agent", "shell"], "A terminal as the agents user, in the projects folder. With -- COMMAND, that command."),
  spec(["statusline"], "One line for Claude Code's status line, from the last status read."),
  spec(["notify"], "One run of the notifier: what to post. launchd runs it with --post.", { internal: true, options: [{ name: "--post" }] }),
  spec(["mcp"], "The stdio MCP server for Claude Code.", { internal: true }),
  spec(["install"], "The first install, from install-controller.sh.", { internal: true, options: [{ name: "--from", value: "REPO" }, { name: "--bootstrap", value: "FOLDER" }] }),
];

export function help(version: string): string[] {
  const shown = CONTROLLER.filter((s) => !s.internal);
  const box = firstWords(shellCommands().filter((s) => !s.internal));
  return [
    `taskbox ${version} on this controller.`,
    "On this controller:",
    ...shown.map((s) => `  taskbox ${s.path.join(" ")}  ${s.summary}`),
    `On a box, with --box NAME, --box all for reads, or the box use default: ${box.join(", ")}.`,
    commandList().replace(/^Commands: /, "At the box only, as the box shows them: "),
    "Type taskbox and a command with --help for its flags.",
  ];
}

const sinceMs = (v: string | true | undefined, now: number): number | undefined => {
  if (typeof v !== "string") return 0;
  const m = /^([1-9]\d{0,5})([smhd])$/.exec(v);
  if (m) return now - Number(m[1]) * { s: 1e3, m: 6e4, h: 3.6e6, d: 8.64e7 }[m[2] as "s"];
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : undefined;
};

// box list: each pairing, reached at once for its release.
async function boxList(d: Deps): Promise<Screen & { result?: Record<string, unknown> }> {
  const c = configOrStop(d);
  if (isStop(c)) return { lines: [header(null, d.version), c.stop, ...footer("Not paired.", "Nothing changed.", c.next)], code: 1 };
  const ts = await tailnetOrStop(d);
  const rows = await Promise.all(
    c.config.boxes.map(async (b) => {
      const h = isStop(ts) ? ts : await connectBox(d, b, ts.state);
      return { name: b.name, node: b.node, installId: b.installId, agent: b.agent, default: c.config.default === b.node, release: isStop(h) ? null : h.hello.release, reachable: !isStop(h), why: isStop(h) ? h.stop : null };
    }),
  );
  const lines = [header(rows.map((r) => r.name), d.version), ...(rows.length ? rows.map((r) => `${r.name}${r.default ? " (default)" : ""}  ${r.node}  install ${r.installId.slice(0, 8)}  as ${r.agent}  ${r.reachable ? `${r.release ?? "release not known"}, reachable` : `not reached: ${r.why}`}`) : ["No box is paired."])];
  return { lines: [...lines, ...footer(`${rows.length} paired.`, "Listed the pairings.", rows.length ? "Nothing to do." : "Type taskbox box add.")], code: 0, result: { boxes: rows.map(({ why: _w, ...r }) => r) } };
}

function boxShow(d: Deps, sel: string): Screen & { result?: Record<string, unknown> } {
  const c = configOrStop(d);
  if (isStop(c)) return { lines: [header(null, d.version), c.stop, ...footer("Not paired.", "Nothing changed.", c.next)], code: 1 };
  const b = findBox(c.config, sel);
  if (!b) return { lines: [header(null, d.version), `No paired box is named ${sel}.`, ...footer("Nothing read.", "Nothing changed.", "Type taskbox box list.")], code: 1 };
  const last = readSaved(d.home)?.boxes.find((x) => x.node === b.node);
  const lines = [header(b.name, d.version), `Tailscale ID: ${b.node}`, `Install ID: ${b.installId}`, `Agent account: ${b.agent}`, `Paired: ${new Date(b.pairedAt).toISOString().slice(0, 16).replace("T", " ")}`, `Default: ${c.config.default === b.node ? "yes" : "no"}`, `Last status: ${last ? `${last.reached ? (last.state ?? "state not known") : "not reached"} at ${new Date(last.at).toISOString().slice(11, 16)}` : "none read yet"}`];
  return { lines: [...lines, ...footer(`${b.name} paired.`, "Read the pairing.", `Type taskbox status --box ${b.name}.`)], code: 0, result: { name: b.name, node: b.node, installId: b.installId, agent: b.agent, pairedAt: b.pairedAt, default: c.config.default === b.node, last: last ? { at: last.at, reached: last.reached, state: last.state } : null } };
}

// box add: pairing, then what the box still needs, as the box's own commands.
async function boxAdd(d: UpdateDeps, args: string[], opts: Record<string, unknown>, yes: boolean, io: { out: (l: string) => void; draw: (l: string[]) => void }): Promise<number> {
  const p = await pair(d, { name: args[0], agent: typeof opts.agent === "string" ? opts.agent : undefined, yes, ...(typeof opts["jobs-repo"] === "string" ? { jobsRepo: opts["jobs-repo"] } : {}) });
  if (!("box" in p)) {
    for (const l of p.lines) io.out(l);
    return p.code;
  }
  // key: the approver key, made once with Touch ID, and its fingerprint, which the box pins at its own
  // screen. The box shows what it received there; nothing is pinned from this controller's word.
  io.out("key: the approver key, which signs your commands with Touch ID.");
  const k = await makeKey({ run: d.run, home: d.home, uid: d.uid ?? -1, say: io.out, ask: d.ask, tty: d.tty });
  if ("why" in k) {
    io.out(`${k.why} Commands that need Touch ID can't be signed until it is made; the rest goes on.`);
  } else {
    // trusting: the box pins the key at its own screen, from the fingerprint it shows there. This
    // controller shows the whole fingerprint the same way, and waits while the two are compared.
    io.out(`Approver key: ${grouped(k.fingerprint)}`);
    io.out(`trusting: ${p.box.name} takes signed commands once an admin pins this key at the box's own screen, after checking it shows every group above.`);
    // The key is offered to the box, which shows it at key trust approver, or, pinning another
    // controller's key, waits for that controller's key add approver and confirm at its screen.
    await trustingPhase(d, p.box.name, k.key, io.out);
  }
  let exit = 0;
  let ran = 0;
  for (const step of AFTER) {
    // A later release adds these commands; until the box runs them, the phase is skipped and says so.
    const known = parse(registry(), step.argv);
    if (!known.ok || !known.spec.shell) {
      io.out(`${step.phase}: skipped: this release has no taskbox ${step.argv.join(" ")}.`);
      continue;
    }
    io.out(`${step.phase}: taskbox ${step.argv.join(" ")} --box ${p.box.name}`);
    ran++;
    if ((await forward(d, [...step.argv, "--box", p.box.name], io)) !== 0) exit = 1;
  }
  for (const l of footer(`Paired with ${p.box.name}.`, p.fresh ? `Paired with ${p.box.name}.` : ran ? "Read the box again." : "Nothing changed.", exit ? "Fix the first FAIL line: its fix is on it." : "Nothing to do.")) io.out(l);
  return exit ? EXIT.failed : EXIT.ok;
}

export interface Io {
  out: (line: string) => void;
  draw: (lines: string[]) => void;
  rounds?: number;
  keys?: AsyncIterator<string>; // key presses, at a terminal: the owner's screen reads them
}

// What self setup, agent shell and notify need beyond the rest.
export interface More {
  user: string;
  term(argv: string[]): Promise<number>;
  exists(path: string): boolean;
}

// The controller's own answer as an envelope, for --json.
const own = (d: Deps, command: string, s: Screen & { result?: Record<string, unknown> }) => asciiJson(envelope({ command, box: null, at: d.now(), exit: s.code, lines: s.lines, result: s.result ?? {} }));

export async function dispatch(d: UpdateDeps & Partial<More>, argv: string[], io: Io): Promise<number> {
  const print = (s: Screen) => {
    for (const l of s.lines) io.out(l);
    return s.code;
  };
  if (!argv.length) return ownerScreen(d, io);
  // agent shell takes its command after --, word for word.
  if (argv[0] === "agent" && argv[1] === "shell") {
    const cut = argv.indexOf("--");
    if ((cut < 0 ? argv.length : cut) !== 2) return io.out("taskbox agent shell takes -- and a command, or nothing."), EXIT.usage;
    if (!d.term) return io.out("taskbox agent shell needs a terminal."), EXIT.usage;
    return d.term(agentShellArgv(cut < 0 ? [] : argv.slice(cut + 1)));
  }
  if (argv[0] === "--version") return io.out(`taskbox ${d.version}`), EXIT.ok;
  if (argv[0] === "help" || argv[0] === "--help") {
    for (const l of help(d.version)) io.out(l);
    return EXIT.ok;
  }
  // The load test's start and stop do more on the controller than the box's own commands.
  if (argv[0] === "load" && (argv[1] === "start" || argv[1] === "stop") && !argv.includes("--help") && !argv.includes("--json")) {
    const { loadStart, loadStop, ownerGh } = await import("./load.ts");
    const gh = (d as { gh?: import("../hold.ts").Gh }).gh ?? ownerGh(d);
    return (argv[1] === "start" ? loadStart : loadStop)({ ...d, ...(gh ? { gh } : {}) }, argv, io);
  }
  // key rotate and key add: this controller makes and signs what the box needs (keyflows.ts).
  if (isKeyFlow(argv)) return keyMain(d, argv, io);
  const mine = CONTROLLER.some((s) => s.path[0] === argv[0]);
  if (!mine) return forward(d, argv, io);
  const p = parse(CONTROLLER, argv);
  const json = argv.includes("--json");
  if (!p.ok) {
    for (const l of [p.line, p.usage ?? "Type taskbox help."]) io.out(l);
    return EXIT.usage;
  }
  if (p.help) {
    io.out(p.spec.summary);
    io.out(usage(p.spec));
    return EXIT.ok;
  }
  if (p.flags.box !== undefined) {
    io.out(`taskbox ${p.spec.path.join(" ")} runs on this controller, and takes no --box.`);
    return EXIT.usage;
  }
  const f = (g: GlobalFlag) => p.flags[g];
  const key = p.path.join(" ");
  const answer = (s: Screen & { result?: Record<string, unknown> }) => (json ? (io.out(own(d, p.path.join("."), s)), s.code) : print(s));
  switch (key) {
    case "box add":
      return boxAdd(d, p.args, p.opts, f("yes") === true, io);
    case "box list":
      return answer(await boxList(d));
    case "box show":
      return answer(boxShow(d, p.args[0]!));
    case "box use":
      return print(boxUse(d, p.args[0]!));
    case "box remove":
      return print(await boxRemove(d, p.args[0]!));
    case "self update":
      return answer(await update(d, { tag: typeof p.opts.to === "string" ? (p.opts.to.startsWith("v") ? p.opts.to : `v${p.opts.to}`) : undefined, check: p.opts.check === true, auto: p.opts.auto === true }));
    case "self rollback":
      return print(rollback(d));
    case "self check":
      const sd = d.term && d.user && d.exists ? { run: d.run, home: d.home, user: d.user, uid: d.uid ?? -1, userHome: d.userHome, term: d.term, exists: d.exists, say: io.out, ask: d.ask } : undefined;
      if (p.opts.fix) return sd ? fix(sd, d.ask, d.tty) : (io.out("taskbox self check --fix needs a terminal."), EXIT.usage);
      return answer(await check(d, sd));
    case "self events": {
      const since = sinceMs(f("since"), d.now());
      if (since === undefined) return io.out("--since takes a time or a duration, such as 1d."), EXIT.usage;
      const list = readEvents(d.home, since);
      if (json) for (const e of list) io.out(JSON.stringify(e));
      else for (const l of list.length ? list.map(eventLine) : ["No events on this controller yet."]) io.out(l);
      return EXIT.ok;
    }
    case "sign":
      return signCommand(d, p.args[0], p.opts, io);
    case "self setup": {
      if (!d.term || !d.user || !d.exists) return io.out("taskbox self setup needs a terminal."), EXIT.usage;
      return setup({ run: d.run, home: d.home, user: d.user, uid: d.uid ?? -1, userHome: d.userHome, term: d.term, exists: d.exists, say: io.out, ask: d.ask }, d.ask, d.tty);
    }
    case "notify": {
      const gh = d.exists ? ghAt(d.exists) : undefined;
      const notes = await notifyOnce({ ...d, ...(gh ? { gh: async (args: string[], stdin?: string) => {
        const r = await d.run([gh, ...args], { limitMs: 30_000, maxBytes: 200_000, env: { HOME: d.userHome }, ...(stdin !== undefined ? { stdin: new TextEncoder().encode(stdin) } : {}) });
        return { code: r.code ?? 1, stdout: r.stdout, stderr: r.stderr };
      } } : {}) });
      for (const n of notes) {
        if (p.opts.post) await d.run(postArgv(n), { limitMs: 10_000, maxBytes: 4_000 });
        else io.out(asciiJson(n));
      }
      return EXIT.ok;
    }
    case "statusline":
      // Reads status.json only: no SSH call and no Tailscale call. What Claude Code sends on stdin is ignored.
      io.out(statusLine(readSaved(d.home), d.now()));
      return EXIT.ok;
    case "install": {
      const from = /^([^/]+)\/([^/]+)$/.exec(typeof p.opts.from === "string" ? p.opts.from : "");
      const boot = p.opts.bootstrap;
      if (!from || !GITHUB_NAME.test(from[1]!) || !GITHUB_NAME.test(from[2]!) || typeof boot !== "string" || !boot.startsWith("/")) return print({ lines: [header(null, d.version), "Type sh install-controller.sh <org>/<repo>, from the folder you downloaded.", ...footer("Nothing changed.", "Nothing changed.", "Nothing to do.")], code: 1 });
      return print(await update(d, { first: { from: { owner: from[1]!, repo: from[2]! }, bootstrap: boot } }));
    }
    default:
      io.out(`taskbox ${key} runs only as Claude Code starts it.`);
      return EXIT.usage;
  }
}

// taskbox sign (release/sign.ts): the repo is the one this controller updates from, unless named;
// the key is the release key's handle in this controller's folder, unless named.
async function signCommand(d: UpdateDeps, version: string | undefined, opts: Record<string, unknown>, io: { out(l: string): void }): Promise<number> {
  const { existsSync, mkdirSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { fingerprints, GH, revokeTransition, sign } = await import("../release/sign.ts");
  const { pinFile, signersIn } = await import("./update.ts");
  if (opts.fingerprint === true) {
    const file = existsSync(pinFile(d.home)) ? pinFile(d.home) : signersIn(join(d.home.current, "app"));
    for (const l of existsSync(file) ? fingerprints(readFileSync(file, "utf8")) : ["  No release key is pinned on this controller."]) io.out(l);
    return EXIT.ok;
  }
  if (!version) return io.out("taskbox sign takes the release's version, such as 3.0.1."), EXIT.usage;
  const c = readConfig(d.home);
  const repo = typeof opts.repo === "string" ? opts.repo : c.ok && c.config.source ? `${c.config.source.owner}/${c.config.source.repo}` : undefined;
  if (!repo) return io.out("taskbox sign needs the public repo: --repo OWNER/NAME."), EXIT.usage;
  const gh = GH.find((g) => existsSync(g));
  if (!gh) return io.out("taskbox sign uses your own GitHub session through gh, and gh isn't installed on this Mac."), EXIT.failed;
  const key = typeof opts.key === "string" ? opts.key : join(d.home.dir, "release-key", "id_ecdsa_sk_rk");
  if (!existsSync(key)) return io.out(`No release key at ${key}. Name its file with --key.`), EXIT.failed;
  const work = join(d.home.dir, "sign");
  mkdirSync(work, { recursive: true, mode: 0o700 });
  const sd = { run: d.run, gh, key, repo, work, ask: d.ask, out: io.out, tty: d.tty };
  return opts.revoke === true ? revokeTransition(sd, version) : sign(sd, version.replace(/^v/, ""));
}

export function realDeps(): UpdateDeps {
  const userHome = homedir();
  const h = home(userHome);
  let lines: AsyncIterator<string> | undefined;
  return {
    run: realRun,
    home: h,
    version: ownVersion(h),
    now: () => realClock.now(),
    sleep: (ms) => realClock.sleep(ms),
    out: (l) => console.log(l),
    // Lines typed so far are shared by every question. Once input ends, each answer is "", a no.
    ask: async (prompt) => {
      process.stdout.write(prompt);
      lines ??= createInterface({ input: process.stdin, terminal: false })[Symbol.asyncIterator]();
      const next = await lines.next();
      if (next.done) process.stdout.write("\n");
      return next.done ? "" : next.value;
    },
    userHome,
    tty: process.stdin.isTTY === true,
    fetch: (url, init) => fetch(url, init),
    verify: (o) => verifyRelease(keygen, o),
    arch: process.arch,
    uid: process.getuid?.() ?? -1,
  };
}

// Key presses from a terminal in raw mode, one each, until the screen quits.
async function* rawKeys(): AsyncGenerator<string> {
  process.stdin.setRawMode(true);
  try {
    for await (const chunk of process.stdin) yield String(chunk);
  } finally {
    process.stdin.setRawMode(false);
  }
}

export async function controllerMain(argv: string[]): Promise<number> {
  if (process.getuid?.() === 0) {
    console.log("taskbox on a controller runs as your own user, never as root. Type it again as your own user.");
    return EXIT.failed;
  }
  const d = realDeps();
  if (argv[0] === "mcp") {
    if (argv.length > 1) return EXIT.usage;
    // stdout carries the protocol only.
    await serve(d, readLines(Bun.stdin.stream()), (s) => process.stdout.write(s));
    return EXIT.ok;
  }
  // A watched view redraws the whole screen each time; the clear is the controller's own, never the box's.
  const draw = (l: string[]) => process.stdout.write(`\x1b[H\x1b[2J${l.join("\n")}\n`);
  // Ctrl-C while watching stops the watching only.
  // A signed drain or stop is followed here after it is sent, and Ctrl-C stops the following only.
  const watching = !argv.length || argv.some((a) => ["-w", "--watch"].includes(a)) || ["drain", "stop"].includes(argv[0] ?? "");
  if (watching)
    process.on("SIGINT", () => {
      console.log("\nStopped watching. What the box was doing carries on.");
      process.exit(EXIT.interrupted);
    });
  // When taskbox starts, it looks for a newer release alongside the command, and says so after.
  const quiet = !argv.length || ["self", "install", "statusline", "notify", "mcp"].includes(argv[0]!) || argv.includes("--json") || watching;
  const note = quiet ? Promise.resolve(undefined) : updateNote(d).catch(() => undefined);
  const more: More = {
    user: userInfo().username,
    exists: (p) => existsSync(p),
    // A program with this terminal, with the controller's fixed environment and nothing more.
    term: async (a) => await Bun.spawn(a, { stdin: "inherit", stdout: "inherit", stderr: "inherit", env: { ...ENV, HOME: d.userHome } }).exited,
  };
  // The owner's screen reads key presses at a terminal.
  const keys = !argv.length && process.stdin.isTTY ? rawKeys() : undefined;
  const code = await dispatch({ ...d, ...more }, argv, { out: (l) => console.log(l), draw, ...(keys ? { keys } : {}) });
  const n = await note;
  if (n) console.log(n);
  return code;
}

if (import.meta.main) process.exit(await controllerMain(process.argv.slice(2)));
