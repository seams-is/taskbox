// taskbox on the controller, run by bin/taskbox as the owner's user. One grammar with the box: box
// commands go through forward.ts with --box; box, self, statusline and mcp are the controller's own.
import { existsSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { type CommandSpec, EXIT, type GlobalFlag, parse, usage } from "../command.ts";
import { realClock } from "../clock.ts";
import { envelope } from "../envelope.ts";
import { commandList, registry, shellCommands, firstWords } from "../registry.ts";
import { verifyRelease, verifySigned } from "../release.ts";
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
import { boxInstall, HOST } from "./boxinstall.ts";
import { connectScreen } from "./screenshare.ts";
import { templateApply } from "./templates.ts";
import { selfTrials } from "./trials.ts";
import { configOrStop, connectBox, type Deps, isStop, tailnetOrStop } from "./reach.ts";
import { ENV, realRun } from "./run.ts";
import { footer, header, type Screen } from "./screens.ts";
import { readSaved, statusLine } from "./statusline.ts";
import { rollback, update, type UpdateDeps, updateNote } from "./update.ts";
import { HOME_VAR as SIGN_HOME_VAR, SIGN_ROOT } from "../release/signroot.ts";
import { SOURCE_TREE } from "../self.ts";

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
  spec(["box", "add"], "Pairs a box tagged tag:taskbox in this controller's Tailscale, then reads what it still needs.", { args: { name: "NAME", min: 0, max: 1, check: NAME_WORD.check }, options: [{ name: "--agent", value: "ACCOUNT", check: (v) => agentProblem(v) === undefined }, { name: "--jobs-repo", value: "REPO", check: (v) => REPO.test(v) }, { name: "--load-repo", value: "REPO", check: (v) => REPO.test(v) }], flags: ["yes"] }),
  spec(["box", "list"], "The paired boxes: name, Tailscale ID, install ID, agent account, release, reachable.", { flags: ["json"] }),
  spec(["box", "show"], "One pairing, and its last status.", { args: NAME_WORD, flags: ["json"] }),
  spec(["box", "use"], "Sets the box a command goes to when it names none.", { args: NAME_WORD }),
  spec(["box", "remove"], "Forgets a pairing, after its name is typed. Nothing changes on the box.", { args: NAME_WORD }),
  spec(["box", "install"], "Sets up a fresh Mac over LAN SSH, in this terminal: ADMIN@HOST. Run it again to finish an interrupted one.", { args: { name: "ADMIN@HOST", min: 1, max: 1, check: (v) => HOST.test(v) }, options: [{ name: "--settings", value: "REPO", check: (v) => REPO.test(v) }], flags: ["json"] }),
  spec(["template", "apply"], "Opens one pull request in the jobs repo, through your GitHub session, that brings the box's workflows up to date.", { flags: ["json"] }),
  spec(["self", "update"], "Updates this controller's taskbox from signed releases on its channel.", { options: [{ name: "--check" }, { name: "--to", value: "VERSION" }, { name: "--auto" }], flags: ["json"] }),
  spec(["self", "rollback"], "Back to the release kept beside the one in use."),
  spec(["self", "check"], "This controller's own checks, Tailscale first, and each pairing. --fix puts right what it can, after one yes.", { flags: ["json"], options: [{ name: "--fix" }] }),
  spec(["self", "events"], "This controller's own event log: pairings, defaults, self updates.", { flags: ["since", "json"] }),
  spec(["self", "trials"], "The trials before rc.1, one after another, each recording its result. Re-run, it goes on from the first not passed.", { flags: ["json"] }),
  spec(["sign"], "Signs a draft release with the release key and publishes it, through your GitHub session, from its root-owned install. --install makes that install; --setup-key moves the release key to a security key; --fingerprint shows the pinned keys; --revoke a release's signer change.", { args: { name: "VERSION", min: 0, max: 1, check: (v) => /^v?\d{1,4}\.\d{1,4}\.\d{1,4}(-rc\.[1-9]\d{0,3})?$/.test(v) }, options: [{ name: "--fingerprint" }, { name: "--force" }, { name: "--install" }, { name: "--into", value: "DIR", check: (v) => v.startsWith("/") && v.length < 1000 }, { name: "--key", value: "FILE" }, { name: "--repo", value: "OWNER/NAME", check: (v) => /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/.test(v) }, { name: "--revoke" }, { name: "--setup-key" }] }),
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
  const p = await pair(d, { name: args[0], agent: typeof opts.agent === "string" ? opts.agent : undefined, yes, ...(typeof opts["jobs-repo"] === "string" ? { jobsRepo: opts["jobs-repo"] } : {}), ...(typeof opts["load-repo"] === "string" ? { loadRepo: opts["load-repo"] } : {}) });
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
  err?: (line: string) => void; // human text in --json mode: stderr
  rounds?: number;
  keys?: AsyncIterator<string>; // key presses, at a terminal: the owner's screen reads them
}

// What self setup, agent shell and notify need beyond the rest.
export interface More {
  user: string;
  term(argv: string[]): Promise<number>;
  exists(path: string): boolean;
}

// A controller flow run with --json: its own lines go to stderr, the box's envelopes it read are kept,
// and one envelope of the controller's making goes to stdout at the end, with the box's last result.
export async function asOneEnvelope(d: Deps, command: string, io: Io, flow: (jio: Io) => Promise<number>): Promise<number> {
  const lines: string[] = [];
  let fromBox: Record<string, unknown> | null = null;
  const err = io.err ?? (() => {});
  const jio: Io = {
    out: (l) => {
      if (l.startsWith('{"answers":')) {
        try {
          const e = JSON.parse(l) as { result?: unknown };
          fromBox = e.result && typeof e.result === "object" ? (e.result as Record<string, unknown>) : null;
          return;
        } catch {}
      }
      lines.push(l);
      err(l);
    },
    draw: (ls) => ls.forEach(err),
    ...(io.rounds !== undefined ? { rounds: io.rounds } : {}),
  };
  const code = await flow(jio);
  const last = lines.findLast((l) => l.trim() !== "" && !l.startsWith("Next: ")) ?? "";
  io.out(asciiJson(envelope({ command, box: null, at: d.now(), exit: code, lines, result: { box: fromBox }, error: code ? { code: code === EXIT.usage ? "usage" : code === EXIT.denied ? "denied" : "failed", message: last.slice(0, 120) || "It stopped.", fix: lines.find((l) => l.startsWith("Next: "))?.slice(6) ?? null, who: null } : null })));
  return code;
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
  // The load test's start and stop do more on the controller than the box's own commands: the
  // dispatch and the cancels go through the owner's GitHub session, with --json too.
  if (argv[0] === "load" && (argv[1] === "start" || argv[1] === "stop") && !argv.includes("--help")) {
    const { loadStart, loadStop, ownerGh } = await import("./load.ts");
    const gh = (d as { gh?: import("../hold.ts").Gh }).gh ?? ownerGh(d);
    const run = argv[1] === "start" ? loadStart : loadStop;
    const ld = { ...d, ...(gh ? { gh } : {}) };
    if (!argv.includes("--json")) return run(ld, argv, io);
    return asOneEnvelope(d, `load.${argv[1]}`, io, (jio) => run(ld, argv, jio));
  }
  // key rotate and key add: this controller makes and signs what the box needs (keyflows.ts).
  if (isKeyFlow(argv)) return keyMain(d, argv, io);
  // connect github from here: this controller's browser makes the box's Apps (connect.ts).
  if (argv[0] === "connect" && argv[1] === "github" && !argv.includes("--help")) {
    const { connectFromController } = await import("./connect.ts");
    if (!argv.includes("--json")) return connectFromController(d, argv, io.out);
    return asOneEnvelope(d, "connect.github", io, (jio) => connectFromController(d, argv, jio.out));
  }
  // workspace connect --screen opens Screen Sharing here, from the account the box names.
  if (argv[0] === "workspace" && argv[1] === "connect" && argv.includes("--screen") && !argv.includes("--help")) {
    const p = parse(registry(), argv);
    if (!p.ok) return io.out(p.line), io.out(p.usage ?? "Type taskbox help."), EXIT.usage;
    const box = typeof p.flags.box === "string" ? p.flags.box : undefined;
    if (!argv.includes("--json")) return connectScreen(d, p.args[0]!, box, io.out);
    return asOneEnvelope(d, "workspace.connect", io, (jio) => connectScreen(d, p.args[0]!, box, jio.out));
  }
  // The controller's own: a command it names whole, or a word only it has (box, self).
  const mine = CONTROLLER.some((s) => s.path.every((w, i) => argv[i] === w)) || (CONTROLLER.some((s) => s.path[0] === argv[0]) && !registry().some((s) => s.path[0] === argv[0]));
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
  // template apply reads one box's values; the rest are this controller's alone.
  if (p.flags.box !== undefined && p.path.join(" ") !== "template apply") {
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
    case "box install": {
      const settings = typeof p.opts.settings === "string" ? p.opts.settings : undefined;
      // Then box add for the new box, and connect github from this controller's browser.
      const after = async (name: string, out: (l: string) => void) => {
        const added = await boxAdd(d, [name], {}, false, { ...io, out });
        if (added !== EXIT.ok) return added;
        const { connectFromController } = await import("./connect.ts");
        return connectFromController(d, ["connect", "github", "--box", name], out);
      };
      const bd = { ...d, after };
      if (!json) return boxInstall(bd, p.args[0]!, settings, io.out);
      return asOneEnvelope(d, "box.install", io, (jio) => boxInstall(bd, p.args[0]!, settings, jio.out));
    }
    case "template apply":
    {
      const box = typeof f("box") === "string" ? (f("box") as string) : undefined;
      if (!json) return templateApply(d, box, io.out);
      return asOneEnvelope(d, "template.apply", io, (jio) => templateApply(d, box, jio.out));
    }
    case "self trials": {
      const t = await selfTrials(d, json, io.out);
      if (json) io.out(own(d, "self.trials", { lines: t.lines, code: t.code, result: t.result }));
      return t.code;
    }
    case "self update":
      return answer(await update(d, { tag: typeof p.opts.to === "string" ? (p.opts.to.startsWith("v") ? p.opts.to : `v${p.opts.to}`) : undefined, check: p.opts.check === true, auto: p.opts.auto === true }));
    case "self rollback":
      return print(await rollback(d));
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

// Where taskbox sign runs from, and how this copy hands over to the root-owned one.
export interface SignEnv {
  root: string; // the root-owned install (release/signroot.ts)
  uid: number; // its owner: 0
  here: string; // this copy's app folder
  argv: string[]; // this run's words, to hand over
  pwd?: string; // the folder taskbox was typed in, for --setup-key's checkout
  elevate: string[];
  ghPaths: string[];
  fidoPaths: string[];
  handOver(argv: string[]): Promise<number>;
}
const APP_HERE = SOURCE_TREE ?? "";
export async function realSignEnv(): Promise<SignEnv> {
  const { FIDO_KEYGEN, SIGN_ROOT } = await import("../release/signroot.ts");
  const { GH } = await import("../release/sign.ts");
  return {
    root: SIGN_ROOT,
    uid: 0,
    here: APP_HERE,
    argv: process.argv.slice(2),
    ...(process.env.PWD?.startsWith("/") ? { pwd: process.env.PWD } : {}),
    elevate: ["/usr/bin/sudo"],
    ghPaths: GH,
    fidoPaths: FIDO_KEYGEN,
    handOver: (argv) => Bun.spawn(argv, { stdin: "inherit", stdout: "inherit", stderr: "inherit" }).exited,
  };
}

// taskbox sign (release/sign.ts). --fingerprint and --install run from any copy; everything else runs
// from the root-owned install only, after it checks itself (signroot.ts), so no process of this user
// can change what is shown and signed. This user's copy hands over to it.
export async function signCommand(d: UpdateDeps, version: string | undefined, opts: Record<string, unknown>, io: { out(l: string): void }, env?: SignEnv): Promise<number> {
  const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const { enclaveSigner, fidoSigner, fingerprints, revokeTransition, sign } = await import("../release/sign.ts");
  const { installProblem, installSigner, layout } = await import("../release/signroot.ts");
  const { FIDO_HANDLE, setupKey } = await import("../release/setupkey.ts");
  const { RELEASE_APP, blobApplication, signerFingerprint, signerLines } = await import("../release.ts");
  const { readPin } = await import("./signers.ts");
  const e = env ?? (await realSignEnv());
  if (opts.fingerprint === true) {
    // This controller's own pin only, never a release's signers file.
    const pin = readPin(d.home);
    for (const l of typeof pin === "string" ? ["  No release key is pinned on this controller."] : fingerprints(pin.pinned)) io.out(l);
    return EXIT.ok;
  }
  const L = layout(e.root);
  const installArgs = { root: e.root, uid: e.uid, elevate: e.elevate, ghPaths: e.ghPaths, fidoPaths: e.fidoPaths };
  if (opts.install === true) return installSigner({ ...d, out: io.out }, installArgs);
  if (e.here !== L.app) {
    if (!existsSync(L.wrapper)) {
      if (opts["setup-key"] !== true) return io.out(`taskbox sign runs only from its root-owned install, and ${e.root} has none. Type taskbox sign --install: it asks for your password once.`), EXIT.failed;
      const code = await installSigner({ ...d, out: io.out }, installArgs);
      if (code !== 0) return code;
    }
    const words = opts["setup-key"] === true && typeof opts.into !== "string" && e.pwd ? [...e.argv, "--into", e.pwd] : e.argv;
    return e.handOver([L.wrapper, ...words]);
  }
  if (!version) return io.out("taskbox sign takes the release's version, such as 3.0.1."), EXIT.usage;
  const work = join(d.home.dir, "sign");
  mkdirSync(work, { recursive: true, mode: 0o700 });
  const checked = await installProblem(e.root, e.uid, d.signed, work);
  if ("why" in checked) return io.out(`taskbox sign won't run from ${e.root}: ${checked.why}. Type taskbox sign --install again.`), EXIT.failed;
  const repo = checked.record.repo;
  if (typeof opts.repo === "string" && opts.repo !== repo) return io.out(`This install of taskbox sign signs for ${repo} only.`), EXIT.usage;
  const keyDir = join(d.home.dir, "release-key");
  const fido = existsSync(L.keygen) ? (key: string) => fidoSigner({ keygen: L.keygen, helper: L.helper, lib: L.lib }, key) : undefined;
  const pin = readPin(d.home);
  const pinned = typeof pin === "string" ? "" : pin.pinned;
  const appOf = (pubFile: string) => {
    const b = /^\S+ ([A-Za-z0-9+/]+={0,2})/.exec(existsSync(pubFile) ? readFileSync(pubFile, "utf8") : "")?.[1];
    return b ? { app: blobApplication(Buffer.from(b, "base64")), line: `taskbox-release namespaces="taskbox-release" sk-ecdsa-sha2-nistp256@openssh.com ${b}` } : undefined;
  };
  if (opts["setup-key"] === true) {
    if (!fido) return io.out("The security key needs OpenSSH with security key support, and this install has none: brew install openssh, then taskbox sign --install again."), EXIT.failed;
    if (typeof pin === "string") return io.out(pin), EXIT.failed;
    if (typeof opts.into !== "string") return io.out("taskbox sign --setup-key writes into taskbox's checkout: name it with --into DIR."), EXIT.usage;
    const today = new Date(d.now()).toISOString().slice(0, 10);
    mkdirSync(keyDir, { recursive: true, mode: 0o700 });
    return setupKey({ run: d.run, keygen: fido(join(keyDir, FIDO_HANDLE)).argv, keyDir, oldSigner: enclaveSigner(join(keyDir, "id_ecdsa_sk_rk")), newSigner: fido(join(keyDir, FIDO_HANDLE)), pinned, into: opts.into, version: version.replace(/^v/, ""), force: opts.force === true, work, ask: d.ask, out: io.out, tty: d.tty, signed: d.signed, today });
  }
  // The key: --key, else the security key's once this controller pins it, else the Secure Enclave key.
  const ykPinned = (() => {
    const k = appOf(join(keyDir, `${FIDO_HANDLE}.pub`));
    return !!k && k.app === RELEASE_APP && signerLines(pinned).some((l) => signerFingerprint(l) === signerFingerprint(k.line));
  })();
  const key = typeof opts.key === "string" ? opts.key : join(keyDir, ykPinned ? FIDO_HANDLE : "id_ecdsa_sk_rk");
  if (!existsSync(key)) return io.out(`No release key at ${key}. Name its file with --key.`), EXIT.failed;
  const onKey = appOf(`${key}.pub`)?.app === RELEASE_APP;
  if (onKey && !fido) return io.out("That key is on a security key, and this install has no OpenSSH for it: brew install openssh, then taskbox sign --install again."), EXIT.failed;
  const signer = onKey ? fido!(key) : enclaveSigner(key);
  // gh's token, read once by the install's own gh; then gh runs with it and an empty config.
  const t = await d.run([L.gh, "auth", "token"], { limitMs: 30_000, maxBytes: 8_000, env: { HOME: d.userHome } });
  const token = t.stdout.trim();
  if (t.code !== 0 || !/^[A-Za-z0-9_]{20,255}$/.test(token)) return io.out("gh has no GitHub session on this Mac: type gh auth login, then taskbox sign again."), EXIT.failed;
  const ghDir = mkdtempSync(join(work, "gh-"));
  try {
    const sd = { run: d.run, gh: L.gh, ghEnv: { GH_TOKEN: token, GH_CONFIG_DIR: ghDir, HOME: ghDir }, signer, repo, work, ask: d.ask, out: io.out, tty: d.tty };
    return opts.revoke === true ? await revokeTransition(sd, version) : await sign(sd, version.replace(/^v/, ""));
  } finally {
    rmSync(ghDir, { recursive: true, force: true });
  }
}

export function realDeps(): UpdateDeps {
  // From taskbox sign's root-owned install, bun runs with an empty HOME and the wrapper names the
  // signing user's (release/signroot.ts).
  const signHome = process.env[SIGN_HOME_VAR];
  const userHome = APP_HERE === join(SIGN_ROOT, "app") && signHome?.startsWith("/") ? signHome : homedir();
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
    signed: (o) => verifySigned(keygen, o),
    arch: process.arch,
    uid: process.getuid?.() ?? -1,
  };
}

// The commands that follow an op on the box until it ends, and the command that cancels each.
const FOLLOWS: Record<string, string> = {
  drain: "taskbox resume",
  stop: "taskbox start",
  "load start": "taskbox load stop",
  update: "taskbox op cancel ID",
  rollback: "taskbox op cancel ID",
  "connect github": "taskbox op cancel ID",
  "key rotate": "taskbox op cancel ID",
  "tool refresh": "taskbox op cancel ID",
  "image pull": "taskbox op cancel ID",
  "selftest run": "taskbox op cancel ID",
  "box add": "",
};

// What Ctrl-C does on this controller: the bare screen quits with 0; a command that watches the box
// stops watching only, with 130, naming the command that watches again and the one that cancels.
// Undefined: Node's own.
export function interrupted(argv: readonly string[]): { line: string; exit: number } | undefined {
  if (!argv.length) return { line: "", exit: EXIT.ok };
  if (argv.includes("--detach")) return undefined;
  const path = argv.slice(0, 2).join(" ");
  const verb = path in FOLLOWS ? path : argv[0]!;
  const watches = argv.some((a) => ["-w", "--watch", "-f", "--follow"].includes(a));
  if (!(verb in FOLLOWS) && !watches) return undefined;
  const plain = argv.every((a) => /^[A-Za-z0-9][\w@.:/=-]{0,80}$|^-{1,2}[a-z-]{1,20}$/.test(a));
  const again = plain ? `taskbox ${argv.join(" ")}` : "The same command";
  const at = argv.indexOf("--box");
  const box = plain && at >= 0 && argv[at + 1] ? ` --box ${argv[at + 1]}` : "";
  // op show ID -w: that op's own cancel.
  const id = argv[0] === "op" && argv[1] === "show" && plain ? argv[2] : undefined;
  const opposite = id ? `taskbox op cancel ${id}` : FOLLOWS[verb];
  const undo = !opposite ? "" : opposite.endsWith(" ID") ? `; ${opposite}${box} cancels it, and taskbox op list${box} shows the ID` : `; ${opposite}${box} cancels it`;
  const what = id || verb in FOLLOWS ? " What it started carries on at the box." : "";
  return { line: `Stopped watching.${what} ${again} watches again${undo}.`, exit: EXIT.interrupted };
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
  const stop = interrupted(argv);
  const watching = stop !== undefined;
  if (stop)
    process.on("SIGINT", () => {
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      if (stop.line) console.log(`\n${stop.line}`);
      process.exit(stop.exit);
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
  const code = await dispatch({ ...d, ...more }, argv, { out: (l) => console.log(l), draw, err: (l) => console.error(l), ...(keys ? { keys } : {}) });
  const n = await note;
  if (n) console.log(n);
  return code;
}

if (import.meta.main) process.exit(await controllerMain(process.argv.slice(2)));
