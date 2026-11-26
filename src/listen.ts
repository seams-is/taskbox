#!/usr/bin/env -S /opt/taskbox/bin/bun --no-install --no-env-file --cwd=/ --config=/opt/taskbox/app/bunfig.run.toml
// taskbox connect github's listener. It runs as the person at the browser (the owner on the controller,
// the admin at the box), never as root: root never parses HTTP. It reads its setup as one line of
// JSON on stdin, so no token is on a command line, serves on 127.0.0.1 only, and writes JSON lines on
// stdout: {"port":N} once it listens, then {"code":...,"state":...} or {"timeout":true}, and ends.
// It answers two requests at most (the start page, then GitHub's redirect), checks Host exactly,
// compares tokens in constant time, and ends at /done, a signal, its parent's exit, or its time.
import { spawnSync } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Clock, realClock } from "./clock.ts";
import { type AppRole, CODE, manifestFor, pageHeaders, ROLES, startPage } from "./connect.ts";

// open: the listener opens its own start page in the browser, through a private file, so the page
// token is never on a command line any local user can read.
export type ListenSetup = { role: AppRole; org: string; appName: string; state: string; pageToken: string; minutes: number; open?: boolean };
export type ListenEvent = { port: number } | { code: string; state: string } | { timeout: true } | { parent: true };

export const LISTEN_MINUTES_MAX = 60;
const TOKEN = /^[0-9a-f]{64}$/;

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

// A setup read from stdin, or why it isn't one.
export function setupProblem(v: unknown): string | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return "not a setup";
  const s = v as Record<string, unknown>;
  if (!ROLES.includes(s.role as AppRole)) return "no role";
  if (typeof s.org !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(s.org)) return "no org";
  if (typeof s.appName !== "string" || !/^[a-z0-9][a-z0-9-]{0,33}$/.test(s.appName)) return "no App name";
  if (typeof s.state !== "string" || !TOKEN.test(s.state) || typeof s.pageToken !== "string" || !TOKEN.test(s.pageToken)) return "no tokens";
  if (!Number.isInteger(s.minutes) || (s.minutes as number) < 1 || (s.minutes as number) > LISTEN_MINUTES_MAX) return "no time";
  if (s.open !== undefined && typeof s.open !== "boolean") return "bad open";
  return undefined;
}

// Deletes the start file, which holds the token: once /start is served, on a signal, at exit, or
// after 30 s, whichever comes first (Tart run of #34: root's SIGTERM skipped the exit handler).
let dropStart: () => void = () => {};

// A file only this user can read, which sends the browser to the start page: open is given the
// file's name, never the token.
export function openPrivately(url: string, opener: (file: string) => void = (f) => void spawnSync("/usr/bin/open", [f], { env: {}, stdio: "ignore" }), clock: Clock = realClock): void {
  const dir = mkdtempSync(join(tmpdir(), "taskbox-connect-"));
  const file = join(dir, "start.html");
  writeFileSync(file, `<!doctype html><meta http-equiv="refresh" content="0;url=${url.replace(/[^A-Za-z0-9:/._-]/g, "")}"><title>taskbox</title>`, { mode: 0o600 });
  opener(file);
  const gone = () => rmSync(dir, { recursive: true, force: true });
  dropStart = gone;
  clock.after(30_000, gone, { unref: true });
  process.on("exit", gone);
}

// The start file gone, and the listener ended, on SIGTERM, SIGINT (Ctrl-C) or SIGHUP.
export function endOnSignals(): void {
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(sig, () => {
      dropStart();
      process.exit(143);
    });
  }
}

export interface ServeOpts {
  opener?: (file: string) => void;
  clock?: Clock;
  // Whether the process that started the listener is still there, asked each second. A SIGKILL of the
  // command ends the listener within a second this way.
  parentAlive?: () => boolean;
}

// Serves the start page once and takes one redirect, then stops. A request with a wrong host, path,
// method or token is answered 404 and isn't one of the two, so a favicon or a stranger can't use one
// up. Every answer carries the page's headers.
export function serveOnce(s: ListenSetup, emit: (e: ListenEvent) => void, o: ServeOpts = {}): { stop(): void; port: number } {
  const why = setupProblem(s);
  if (why) throw new Error(`bad setup: ${why}`);
  const clock = o.clock ?? realClock;
  let answered = 0;
  let started = false;
  let done = false;
  const no = () => new Response("Not found", { status: 404, headers: pageHeaders() });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      // DNS rebinding: only the literal address and this port.
      if (done || answered >= 2 || req.headers.get("host") !== `127.0.0.1:${server.port}` || req.method !== "GET") return no();
      if (u.pathname.startsWith("/start/")) {
        if (started || !same(u.pathname.slice(7), s.pageToken)) return no();
        started = true;
        answered++;
        dropStart();
        const m = manifestFor(s.role, s.org, s.appName, server.port as number);
        return new Response(startPage(s.org, s.state, m, s.role), { headers: pageHeaders() });
      }
      if (u.pathname === "/done") {
        const code = u.searchParams.get("code") ?? "";
        const state = u.searchParams.get("state") ?? "";
        if (!started || !same(state, s.state) || !CODE.test(code)) return no();
        answered++;
        done = true;
        emit({ code, state });
        clock.after(50, () => stop());
        return new Response("<!doctype html><title>taskbox</title><p>The App is made. Go back to the terminal.</p>", { headers: pageHeaders() });
      }
      return no();
    },
  });
  const end = (e: ListenEvent) => {
    if (!done) {
      done = true;
      emit(e);
    }
    stop();
  };
  const cancel = clock.after(s.minutes * 60_000, () => end({ timeout: true }));
  const watch = o.parentAlive ? clock.every(1000, () => (o.parentAlive!() ? undefined : end({ parent: true }))) : () => {};
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    cancel();
    watch();
    server.stop(true);
  };
  emit({ port: server.port as number });
  if (s.open) openPrivately(`http://127.0.0.1:${server.port}/start/${s.pageToken}`, o.opener, clock);
  return { stop, port: server.port as number };
}

// The parent at the start: once it is gone, launchd (pid 1) or another adopts the listener.
export function parentWatch(ppid = process.ppid, now: () => number = () => process.ppid): () => boolean {
  return () => now() === ppid && ppid !== 1;
}

if (import.meta.main) {
  const line = await new Response(Bun.stdin.stream()).text();
  let setup: ListenSetup;
  try {
    setup = JSON.parse(line.split("\n")[0]!) as ListenSetup;
  } catch {
    process.exit(2);
  }
  if (setupProblem(setup)) process.exit(2);
  endOnSignals();
  const out = (e: ListenEvent) => process.stdout.write(`${JSON.stringify(e)}\n`);
  serveOnce(
    setup,
    (e) => {
      out(e);
      if (!("port" in e)) realClock.after(100, () => process.exit(0));
    },
    { parentAlive: parentWatch() },
  );
}
