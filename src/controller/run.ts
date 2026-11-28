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
  limitMs: number; // 0: no limit, for a stream ended by the box's last line or by Ctrl-C
  maxBytes: number;
  stdin?: Uint8Array; // the program's whole input; with none it gets no input
  // The few settings a program needs beyond PATH and TERM, from a fixed list: ssh-keygen's security
  // key provider, HOME, and gh's token and config folder for taskbox sign. Anything else is refused.
  env?: Partial<Record<(typeof EXTRA)[number], string>>;
  cwd?: string; // a folder of the controller's own, for a program that writes where it runs
  onLine?: (line: string) => void; // each line of stdout as it comes, for a stream; none is kept
}

// A line longer than this is dropped whole, so a stream can't fill this Mac's memory.
export const STREAM_LINE_MAX = 1_100_000;

export const EXTRA = ["SSH_SK_PROVIDER", "HOME", "GH_TOKEN", "GH_CONFIG_DIR"] as const;

export type Runner = (argv: string[], o: RunOptions) => Promise<RunResult>;

async function readCapped(stream: ReadableStream<Uint8Array>, max: number, over: () => void, onLine?: (line: string) => void): Promise<string> {
  const chunks: Uint8Array[] = [];
  let n = 0;
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let part = "";
  let dropping = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (onLine) {
      const lines = (part + dec.decode(value, { stream: true })).split("\n");
      part = lines.pop() ?? "";
      for (const l of lines) {
        if (!dropping) onLine(l);
        dropping = false;
      }
      if (part.length > STREAM_LINE_MAX) {
        part = "";
        dropping = true;
      }
      continue;
    }
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
  if (onLine && part && !dropping) onLine(part);
  return Buffer.concat(chunks).toString("utf8");
}

export const realRun: Runner = async (argv, o) => {
  if (!argv[0]?.startsWith("/")) throw new Error("a program is run by its full path");
  for (const k of Object.keys(o.env ?? {})) if (!(EXTRA as readonly string[]).includes(k)) throw new Error("a setting the controller doesn't pass on");
  const p = Bun.spawn(argv, { stdin: o.stdin ? new Blob([o.stdin]) : "ignore", stdout: "pipe", stderr: "pipe", env: { ...ENV, ...o.env }, ...(o.cwd ? { cwd: o.cwd } : {}) });
  let timedOut = false;
  let tooBig = false;
  const kill = () => {
    try {
      p.kill("SIGKILL");
    } catch {}
  };
  const stopTimer = o.limitMs
    ? realClock.after(o.limitMs, () => {
        timedOut = true;
        kill();
      })
    : () => {};
  // A program that leaves its output open after it is killed doesn't hold the controller either.
  let stopLate: (() => void) | undefined;
  const hardStop = new Promise<"late">((r) => {
    if (o.limitMs) stopLate = realClock.after(o.limitMs + 2_000, () => r("late"));
  });
  try {
    const out = Promise.all([
      readCapped(
        p.stdout,
        o.maxBytes,
        () => {
          tooBig = true;
          kill();
        },
        o.onLine,
      ),
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
