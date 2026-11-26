// v2.6.1's src/sys.ts at c7d2414, cut to what hop() runs. Each part below is that file's own text, unchanged, unless marked New.

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  stdin?: string | Uint8Array;
  timeoutMs?: number;
  env?: Record<string, string>; // added to childEnv's, never in place of it
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

export interface Sys {
  run(cmd: string, args: string[], opts?: RunOptions): Promise<RunResult>;
  spawn(cmd: string, args: string[], opts?: SpawnOptions): Proc;
  fetch(url: string, init?: RequestInit): Promise<Response>;
  tcpProbe(host: string, port: number, timeoutMs: number): Promise<ProbeResult>;
  localIPv4(): string[];
  now(): number;
  sleep(ms: number): Promise<void>;
}
