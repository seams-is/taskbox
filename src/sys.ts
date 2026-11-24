// Everything that touches the machine goes through Sys, so tests can fake it.
import { connect } from "node:net";
import { networkInterfaces } from "node:os";
import { type Clock, realClock } from "./clock.ts";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  stdin?: string | Uint8Array;
  timeoutMs?: number;
  env?: Record<string, string>; // added to childEnv's, never in place of it
  cwd?: string; // the child's folder; the caller's when absent
  group?: boolean; // the child leads a process group of its own, and a timeout kills the whole group
}

export interface Proc {
  exited: Promise<number>;
  done?: Promise<number>; // exited, once all output has been read
  kill(): void;
  pid?: number;
}

export interface SpawnOptions {
  stdin?: string | Uint8Array;
  env?: Record<string, string>; // added to the fixed child environment
  onLine?: (line: string) => void;
  // The child leads a process group of its own, so launchd's bootout of the caller's job, which ends
  // the job's process group, doesn't end it (core/child.ts).
  group?: boolean;
  // Lines the child writes on fd 3, a pipe of its own: a channel apart from its output, which the
  // programs it runs can't write to (core/child.ts). Bun passes a child only fds 0 to 2.
  onReport?: (line: string) => void;
}

// The longest line spawn passes on; the rest of a longer one is dropped.
export const LINE_MAX = 64 * 1024;

export type ProbeResult = "refused" | "open" | "timeout" | "error";

// The machine's clock is part of it: now, sleep and every timer (clock.ts).
export interface Sys extends Clock {
  run(cmd: string, args: string[], opts?: RunOptions): Promise<RunResult>;
  spawn(cmd: string, args: string[], opts?: SpawnOptions): Proc;
  fetch(url: string, init?: RequestInit): Promise<Response>;
  tcpProbe(host: string, port: number, timeoutMs: number): Promise<ProbeResult>;
  localIPv4(): string[];
}

// Children get this environment and nothing else. Nothing is inherited, so
// SENTRY_DSN, CIRRUS_SENTRY_TAGS and anything else in the caller's
// environment never reaches Tart or Softnet.
export function childEnv(home: string): Record<string, string> {
  return {
    // Softnet's own folder first, where Tart finds it (tart.ts).
    PATH: "/opt/taskbox/softnet:/opt/taskbox/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: home,
    LANG: "en_US.UTF-8",
  };
}

function assertNotTest(): void {
  if (process.env.TASKBOX_TEST === "1") {
    throw new Error("the real Sys was used inside a test");
  }
}

export function realSys(home: string): Sys {
  const env = childEnv(home);
  return {
    async run(cmd, args, opts = {}) {
      assertNotTest();
      const p = Bun.spawn([cmd, ...args], {
        env: { ...env, ...(opts.env ?? {}) },
        stdin: opts.stdin === undefined ? "ignore" : new Blob([opts.stdin]),
        stdout: "pipe",
        stderr: "pipe",
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        ...(opts.group ? { detached: true } : {}),
      });
      let cancel: (() => void) | undefined;
      const kill = () => {
        if (opts.group) {
          try {
            process.kill(-p.pid, "SIGKILL");
            return;
          } catch {}
        }
        p.kill(9);
      };
      if (opts.timeoutMs) cancel = realClock.after(opts.timeoutMs, kill);
      const [stdout, stderr, code] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
        p.exited,
      ]);
      cancel?.();
      return { code, stdout, stderr };
    },
    spawn(cmd, args, opts = {}) {
      assertNotTest();
      const stdin = opts.stdin === undefined ? "ignore" : new Blob([opts.stdin]);
      const p = Bun.spawn([cmd, ...args], {
        env: { ...env, ...(opts.env ?? {}) },
        ...(opts.onReport ? { stdio: [stdin, "pipe", "pipe", "pipe"] as const } : { stdin, stdout: "pipe" as const, stderr: "pipe" as const }),
        ...(opts.group ? { detached: true } : {}),
      });
      const read = async (s: ReadableStream<Uint8Array>, onLine: ((line: string) => void) | undefined, cr: boolean) => {
        let buf = "";
        const dec = new TextDecoder();
        for await (const chunk of s) {
          buf += dec.decode(chunk, { stream: true });
          let i: number;
          // Tart redraws a line with \r when it thinks it has a terminal, so both end a line. A report
          // channel's lines end with \n alone.
          if (cr) buf = buf.replace(/\r(?!\n)/g, "\n");
          while ((i = buf.indexOf("\n")) >= 0) {
            onLine?.(buf.slice(0, Math.min(i, LINE_MAX)));
            buf = buf.slice(i + 1);
          }
          if (buf.length > LINE_MAX) buf = buf.slice(0, LINE_MAX);
        }
        if (buf) onLine?.(buf);
      };
      const streams = [read(p.stdout as ReadableStream<Uint8Array>, opts.onLine, true), read(p.stderr as ReadableStream<Uint8Array>, opts.onLine, true)];
      if (opts.onReport) streams.push(read(Bun.file(p.stdio[3] as number).stream(), opts.onReport, false));
      const drained = Promise.all(streams);
      return { exited: p.exited, done: Promise.all([p.exited, drained]).then(([c]) => c), kill: () => p.kill(9), pid: p.pid };
    },
    fetch(url, init) {
      assertNotTest();
      return fetch(url, init);
    },
    tcpProbe(host, port, timeoutMs) {
      assertNotTest();
      return new Promise((resolve) => {
        const s = connect({ host, port });
        // The socket sends nothing, so its time limit is one timer from the start.
        const cancel = realClock.after(timeoutMs, () => done("timeout"));
        const done = (r: ProbeResult) => {
          cancel();
          s.destroy();
          resolve(r);
        };
        s.on("connect", () => done("open"));
        s.on("error", (e: NodeJS.ErrnoException) => done(e.code === "ECONNREFUSED" ? "refused" : "error"));
      });
    },
    localIPv4() {
      assertNotTest();
      const out = ["127.0.0.1"];
      for (const list of Object.values(networkInterfaces())) {
        for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) out.push(a.address);
      }
      return out;
    },
    ...realClock,
  };
}
