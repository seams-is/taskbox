// How the controller runs another program: the Tailscale CLI, ssh and plutil, each by its full path.
// It gets an empty environment plus a fixed PATH and TERM, so nothing the caller's environment holds
// reaches it: no agent socket, no password helper, no display, no security-key helper, no TS_
// setting. No input, unless the caller gives it whole. Output is capped, and every run has a time limit.
import { realClock } from "../clock.ts";

export const ENV: Readonly<Record<string, string>> = Object.freeze({ PATH: "/usr/bin:/bin:/usr/sbin:/sbin", TERM: "dumb" });

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  tooBig: boolean;
}

export interface RunOptions {
  limitMs: number;
  maxBytes: number;
  stdin?: Uint8Array; // the program's whole input; with none it gets no input
}

export type Runner = (argv: string[], o: RunOptions) => Promise<RunResult>;

async function readCapped(stream: ReadableStream<Uint8Array>, max: number, over: () => void): Promise<string> {
  const chunks: Uint8Array[] = [];
  let n = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (n + value.length > max) {
      chunks.push(value.subarray(0, Math.max(0, max - n)));
      n = max;
      over();
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    n += value.length;
  }
  return Buffer.concat(chunks).toString("utf8");
}

export const realRun: Runner = async (argv, o) => {
  if (!argv[0]?.startsWith("/")) throw new Error("a program is run by its full path");
  const p = Bun.spawn(argv, { stdin: o.stdin ? new Blob([o.stdin]) : "ignore", stdout: "pipe", stderr: "pipe", env: { ...ENV } });
  let timedOut = false;
  let tooBig = false;
  const kill = () => {
    try {
      p.kill("SIGKILL");
    } catch {}
  };
  const stopTimer = realClock.after(o.limitMs, () => {
    timedOut = true;
    kill();
  });
  // A program that leaves its output open after it is killed doesn't hold the controller either.
  let stopLate: (() => void) | undefined;
  const hardStop = new Promise<"late">((r) => {
    stopLate = realClock.after(o.limitMs + 2_000, () => r("late"));
  });
  try {
    const out = Promise.all([
      readCapped(p.stdout, o.maxBytes, () => {
        tooBig = true;
        kill();
      }),
      readCapped(p.stderr, 64_000, () => {}),
      p.exited,
    ]);
    const r = await Promise.race([out, hardStop]);
    if (r === "late") {
      kill();
      return { code: null, stdout: "", stderr: "", timedOut: true, tooBig };
    }
    const [stdout, stderr, code] = r;
    return { code: timedOut || tooBig ? null : code, stdout, stderr, timedOut, tooBig };
  } finally {
    stopTimer();
    stopLate?.();
  }
};
