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
}

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
      const p = Bun.spawn([cmd, ...args], {
        env: { ...env, ...(opts.env ?? {}) },
        stdin: opts.stdin === undefined ? "ignore" : new Blob([opts.stdin]),
        stdout: "pipe",
        stderr: "pipe",
      });
      const read = async (s: ReadableStream<Uint8Array>) => {
        let buf = "";
        const dec = new TextDecoder();
        for await (const chunk of s) {
          buf += dec.decode(chunk, { stream: true });
          let i: number;
          // Tart redraws a line with \r when it thinks it has a terminal, so both end a line.
          buf = buf.replace(/\r(?!\n)/g, "\n");
          while ((i = buf.indexOf("\n")) >= 0) {
            opts.onLine?.(buf.slice(0, i));
            buf = buf.slice(i + 1);
          }
        }
        if (buf) opts.onLine?.(buf);
      };
      const drained = Promise.all([read(p.stdout), read(p.stderr)]);
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
