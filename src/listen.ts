#!/usr/bin/env -S /opt/taskbox/bin/bun --no-install --no-env-file --cwd=/ --config=/opt/taskbox/app/bunfig.run.toml
// taskbox connect github's listener (connect-github design, sections 2 and 11). Run as the admin,
// never root, by taskbox connect: root never parses HTTP. It reads its setup as one line of JSON on
// stdin, so no token is on a command line, serves on 127.0.0.1 only, and writes JSON lines on stdout:
// {"port":N} once it listens, then {"code":...,"state":...} or {"timeout":true}, and ends.
import { spawnSync } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Clock, realClock } from "./clock.ts";
import { manifestFor, pageHeaders, startPage } from "./connect.ts";

// open: the listener opens its own start page in the admin's browser, through a private file, so the
// page token is never on a command line any local user can read (security review, M1).
export type ListenSetup = { org: string; appName: string; state: string; pageToken: string; minutes: number; open?: boolean };
export type ListenEvent = { port: number } | { code: string; state: string } | { timeout: true };

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

// A file only the admin can read, which sends the browser to the start page: open is given the
// file's name, never the token.
// Deletes the start file, which holds the token: once /start is served, on a signal, at exit, or
// after 30 s, whichever comes first (Tart run of #34: root's SIGTERM skipped the exit handler).
let dropStart: () => void = () => {};

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

// The start file gone, and the listener ended, on SIGTERM (root's stop) or SIGINT (Ctrl-C).
export function endOnSignals(): void {
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(sig, () => {
      dropStart();
      process.exit(143);
    });
  }
}
const TOKEN = /^[0-9a-f]{64}$/;

// Serves the start page once and takes one redirect, then stops. A request with a wrong host, path or
// token is answered 404 and doesn't count, so a favicon or a stranger can't use up a request.
export function serveOnce(s: ListenSetup, emit: (e: ListenEvent) => void, opener?: (file: string) => void, clock: Clock = realClock): { stop(): void; port: number } {
  if (!TOKEN.test(s.state) || !TOKEN.test(s.pageToken)) throw new Error("bad setup");
  let started = false;
  let done = false;
  const no = () => new Response("Not found", { status: 404, headers: pageHeaders() });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      // DNS rebinding: only the literal address and this port.
      if (req.headers.get("host") !== `127.0.0.1:${server.port}` || req.method !== "GET" || done) return no();
      if (u.pathname.startsWith("/start/")) {
        if (started || !same(u.pathname.slice(7), s.pageToken)) return no();
        started = true;
        dropStart();
        const m = manifestFor(s.org, s.appName, server.port as number);
        return new Response(startPage(s.org, s.state, m), { headers: pageHeaders() });
      }
      if (u.pathname === "/done") {
        const code = u.searchParams.get("code") ?? "";
        const state = u.searchParams.get("state") ?? "";
        if (!started || !same(state, s.state) || !/^[A-Za-z0-9_-]{1,100}$/.test(code)) return no();
        done = true;
        emit({ code, state });
        clock.after(50, () => stop());
        return new Response("<!doctype html><title>taskbox</title><p>The App is made. Go back to Terminal.</p>", { headers: pageHeaders() });
      }
      return no();
    },
  });
  const cancel = clock.after(s.minutes * 60_000, () => {
    if (!done) {
      done = true;
      emit({ timeout: true });
    }
    stop();
  });
  const stop = () => {
    cancel();
    server.stop(true);
  };
  emit({ port: server.port as number });
  if (s.open) openPrivately(`http://127.0.0.1:${server.port}/start/${s.pageToken}`, opener, clock);
  return { stop, port: server.port as number };
}

if (import.meta.main) {
  const line = await new Response(Bun.stdin.stream()).text();
  let setup: ListenSetup;
  try {
    setup = JSON.parse(line.split("\n")[0]!) as ListenSetup;
  } catch {
    process.exit(2);
  }
  endOnSignals();
  const out = (e: ListenEvent) => process.stdout.write(`${JSON.stringify(e)}\n`);
  serveOnce(setup, (e) => {
    out(e);
    if (!("port" in e)) realClock.after(100, () => process.exit(0));
  });
}
