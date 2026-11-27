// taskbox update, rollback, release list and release show at the box. An admin's
// update or rollback runs as root through sudo: it says what would happen, takes the typed yes,
// puts the request in root's admin spool, and follows the op the guard begins, as drain does
// (opcmd.ts followOp): Ctrl-C stops the watching only. The owner's come signed from the controller
// (handlers/update.ts), where the touch is the yes. --check and release list only read.
import { tmpdir } from "node:os";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { BoxCtx, ErrorBody, Outcome } from "../command.ts";
import { duration, EXIT } from "../command.ts";
import { argsOf } from "../core/statement.ts";
import { rootStateOf } from "../core/paths.ts";
import { loadConfig } from "../config.ts";
import { publicRelease } from "../hop.ts";
import { askGuard, followOp, onInterrupt, WATCH_MS } from "../opcmd.ts";
import { bare, compareVersions, describeStatement, parseStatement, verifySigned } from "../release.ts";
import { updateOf } from "../settings/update.ts";
import { readSigners, runningOf, updateFiles } from "./box.ts";
import { listedReleases, type Listed, pick } from "./pick.ts";
import { frozenLine, isBad, keptInstalls, readMarks, statementOf } from "./records.ts";
import { type UpdateKind, updateArgsProblem } from "./start.ts";
import { dirname } from "node:path";

const err = (code: ErrorBody["code"], message: string, who: ErrorBody["who"] = null): ErrorBody => ({ code, message, fix: null, who });
const clean = (t: string, n = 120) => t.replace(/[^\x20-\x7e]/g, " ").slice(0, n);

async function listed(c: BoxCtx): Promise<Listed[] | string> {
  const cfg = loadConfig(c.p.app, c.p.boxSettings);
  if (!cfg.publicRepo) return "taskbox.json names no publicRepo, so no release can be read";
  try {
    const res = await c.ops.sys.fetch(`https://api.github.com/repos/${cfg.publicRepo}/releases?per_page=100`, { redirect: "error", signal: c.ops.sys.timeout(30_000), headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "taskbox" } });
    if (!res.ok) return `GitHub answered ${res.status} for the public repo's releases`;
    return listedReleases(await res.json());
  } catch {
    return "GitHub couldn't be reached for the public repo's releases";
  }
}

const rootOf = (c: BoxCtx) => c.deps.rootUid ?? 0;

// update --check: what the box would take next, on its channel. Nothing is installed.
async function check(c: BoxCtx, args: Record<string, unknown>): Promise<Outcome> {
  const cfg = loadConfig(c.p.app, c.p.boxSettings);
  const u = updateOf(cfg);
  let installed: string;
  try {
    installed = runningOf(c.own, rootOf(c)).version;
  } catch (e) {
    c.say(`${clean((e as Error).message)}.`);
    return { exit: EXIT.failed, error: err("failed", (e as Error).message) };
  }
  const l = await listed(c);
  if (typeof l === "string") {
    c.say(`${l}.`);
    return { exit: EXIT.failed, error: err("unreachable", l) };
  }
  const marks = readMarks(updateFiles(rootStateOf(c.own)).marks, rootOf(c));
  const p = pick({ listed: l, installed, channel: u.channel, marks, ...(typeof args.to === "string" ? { to: args.to } : {}), ...(args.repair ? { repair: true } : {}) });
  c.say(`This box runs ${installed}, on the ${u.channel} channel. ${u.auto ? `It updates itself in its window, ${u.window} its own time.` : "update.auto is off, so it updates only when asked."}`);
  const frozen = frozenLine(marks, c.ops.sys.now());
  if (frozen) c.say(`WARN ${frozen}.`);
  const next = p.kind === "take" ? p.version : null;
  c.say(p.kind === "take" ? `It would take ${p.version} next.` : `${p.why[0]!.toUpperCase()}${p.why.slice(1)}.`);
  return { exit: p.kind === "refuse" ? EXIT.failed : EXIT.ok, result: { installed, channel: u.channel, available: next }, did: "Nothing installed.", next: next ? "taskbox update" : "Nothing to do." };
}

export async function updateRun(c: BoxCtx, kind: UpdateKind): Promise<Outcome> {
  const args = argsOf(c) as Record<string, unknown>;
  if (typeof c.args[0] === "string" && args.to === undefined) args.to = bare(c.args[0]);
  delete args.words;
  if (typeof args.to === "string") args.to = bare(args.to);
  const checking = kind === "update" && (c.opts.check === true || c.flags.dryRun !== undefined);
  delete args.check;
  delete args.dryRun;
  const bad = updateArgsProblem(kind, args);
  if (bad) {
    c.say(`${bad[0]!.toUpperCase()}${bad.slice(1)}.`);
    return { exit: EXIT.usage, error: err("usage", bad) };
  }
  if (checking) return check(c, args);
  // As root through sudo, from an admin: the cli elevates an admin's run at the box.
  const admin = c.uid === 0 || c.uid === rootOf(c);
  const name = c.env.SUDO_USER;
  const { isAdmin } = await import("../elevate.ts");
  if (!admin || !name || name === "root" || !/^[a-z_][a-z0-9_.-]{0,31}$/.test(name) || !(await isAdmin(c.ops.sys, name).catch(() => false))) {
    const line = `Log in as your admin user at the box, then type taskbox ${kind}; or run it from the controller, which signs it.`;
    c.say(line);
    return { exit: EXIT.failed, error: err("denied", line, "at-the-box") };
  }
  // What it would do, then the typed yes.
  let installed: string;
  try {
    installed = runningOf(c.own, rootOf(c)).version;
  } catch (e) {
    c.say(`${clean((e as Error).message)}.`);
    return { exit: EXIT.failed, error: err("failed", (e as Error).message) };
  }
  if (kind === "update") {
    const l = await listed(c);
    if (typeof l === "string") {
      c.say(`${l}. Nothing was installed.`);
      return { exit: EXIT.failed, error: err("unreachable", l) };
    }
    const cfg = loadConfig(c.p.app, c.p.boxSettings);
    const p = pick({ listed: l, installed, channel: updateOf(cfg).channel, marks: readMarks(updateFiles(rootStateOf(c.own)).marks, rootOf(c)), ...(typeof args.to === "string" ? { to: args.to } : {}), ...(args.repair ? { repair: true } : {}) });
    if (p.kind !== "take") {
      c.say(`${p.why[0]!.toUpperCase()}${p.why.slice(1)}. Nothing was installed.`);
      return { exit: p.kind === "refuse" ? EXIT.failed : EXIT.ok, changed: false, did: "Nothing installed." };
    }
    args.to = p.version;
    c.say(`This updates the box from ${installed} to ${p.version}: it checks the release's signature, waits for running jobs to finish, installs it, then proves it, and goes back by itself if the proof fails. taskbox op cancel cancels it before its swap.`);
  } else {
    const kept = keptInstalls(dirname(c.own.opt), rootOf(c)).filter((k) => k.record.version !== installed);
    const to = typeof args.to === "string" ? args.to : kept.find((k) => compareVersions(k.record.version, installed) < 0)?.record.version;
    c.say(`This takes the box back from ${installed} to ${to ?? "the install before"}, with the settings it was installed with, narrowed where the box's state is narrower now. Running jobs finish first.`);
  }
  if (c.flags.yes === undefined) {
    if (c.deps.terminal?.() === false) {
      const line = `${kind} asks a typed yes, and there is no terminal here. Add -y to answer it.`;
      c.say(line);
      return { exit: EXIT.usage, error: err("usage", line, "at-the-box") };
    }
    if ((await c.ask("Type yes to go on: ")).trim().toLowerCase() !== "yes") {
      c.say("Nothing changed.");
      return { exit: EXIT.failed, did: "Nothing changed." };
    }
  }
  const r = await askGuard(c, "admin", kind, args);
  if (!r.ok) return r.out;
  const o = r.outcome;
  c.say(o.said);
  if (!o.ok) return { exit: EXIT.failed, result: { request: r.id, ...(o.op ? { op: o.op } : {}) }, error: err(o.code ?? "failed", o.said) };
  if (!o.op || c.flags.detach !== undefined) {
    if (o.op) c.say(`Its op is ${o.op}. taskbox op show ${o.op} -w watches it.`);
    return { exit: EXIT.ok, changed: true, result: { request: r.id, ...(o.op ? { op: o.op } : {}) } };
  }
  const limit = typeof c.flags.timeout === "string" ? duration(c.flags.timeout)! : 0;
  c.say(`Ctrl-C stops watching; the ${kind} carries on. taskbox op show ${o.op} -w watches it again.`);
  const interrupt = onInterrupt();
  try {
    const f = await followOp(c, o.op, { polls: limit ? Math.ceil(limit / WATCH_MS) : 0, interrupt, again: `taskbox op show ${o.op} -w`, undo: `taskbox op cancel ${o.op}`, done: kind === "update" ? "Installed and proved." : "Rolled back." });
    return { ...f, changed: true };
  } finally {
    interrupt.off();
  }
}

// release list: the releases on the box's channel (all with --all), each marked installed, kept or bad.
export async function releaseList(c: BoxCtx): Promise<Outcome> {
  const cfg = loadConfig(c.p.app, c.p.boxSettings);
  const u = updateOf(cfg);
  const l = await listed(c);
  if (typeof l === "string") {
    c.say(`${l}.`);
    return { exit: EXIT.ok, result: { releases: [] }, error: err("unreachable", l) };
  }
  let installed: string | undefined;
  try {
    installed = runningOf(c.own, rootOf(c)).version;
  } catch {}
  const kept = new Set(keptInstalls(dirname(c.own.opt), rootOf(c)).map((k) => k.record.version));
  const marks = readMarks(updateFiles(rootStateOf(c.own)).marks, rootOf(c));
  const all = c.opts.all === true;
  const rows = l
    .filter((r) => all || u.channel === "beta" || !r.version.includes("-rc."))
    .map((r) => ({ version: r.version, publishedAt: new Date(r.publishedAt).toISOString(), installed: r.version === installed, kept: kept.has(r.version), bad: isBad(marks, r.version) }));
  for (const r of rows) c.say(`${r.version.padEnd(14)} ${r.publishedAt.slice(0, 10)}${r.installed ? "  installed" : ""}${r.kept && !r.installed ? "  kept" : ""}${r.bad ? "  bad" : ""}`);
  if (!rows.length) c.say(`The public repo has no release on ${u.channel} yet.`);
  return { exit: EXIT.ok, result: { channel: u.channel, releases: rows } };
}

// release show VERSION: its signed statement. A kept install's comes from its record, verified when
// it was installed; any other is read from the public repo and its signature checked first.
export async function releaseShow(c: BoxCtx): Promise<Outcome> {
  const version = bare(c.args[0]!);
  const k = keptInstalls(dirname(c.own.opt), rootOf(c)).find((x) => x.record.version === version);
  let text: string | undefined;
  if (k) text = k.record.statement;
  else {
    const cfg = loadConfig(c.p.app, c.p.boxSettings);
    if (!cfg.publicRepo) {
      c.say("taskbox.json names no publicRepo, so no release can be read.");
      return { exit: EXIT.failed, error: err("failed", "no publicRepo") };
    }
    const work = mkdtempSync(join(tmpdir(), "taskbox-show-"));
    try {
      const rel = await publicRelease(c.ops.sys, cfg.publicRepo, `v${version}`);
      let pinned: string;
      try {
        pinned = readSigners(updateFiles(rootStateOf(c.own)).signers, "", rootOf(c)).pinned || readFileSync(join(c.own.app, "signers/allowed_signers"), "utf8");
      } catch {
        pinned = "";
      }
      const v = await verifySigned({ run: (cmd, a, o) => c.ops.sys.run(cmd, a, o) }, { message: rel.statement, signature: rel.signature, pinned, workRoot: work });
      if (!v.ok) {
        c.say(`${version}'s statement can't be shown: ${v.why}.`);
        return { exit: EXIT.failed, error: err("signature", v.why) };
      }
      text = new TextDecoder().decode(rel.statement);
    } catch (e) {
      c.say(`${version} can't be read: ${clean((e as Error).message)}.`);
      return { exit: EXIT.failed, error: err("not-found", (e as Error).message) };
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
  const s = parseStatement(text);
  if (!s) {
    c.say(`${version}'s statement isn't one taskbox reads.`);
    return { exit: EXIT.failed, error: err("failed", "unreadable statement") };
  }
  for (const l of describeStatement(s)) c.say(l);
  return { exit: EXIT.ok, result: { statement: s as unknown as Record<string, unknown>, kept: !!k } };
}

export { statementOf };
