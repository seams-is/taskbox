// An op the service account asks for at the box and the loop runs: selftest run and image pull, as
// tools/refresh.ts does for tool refresh. The command writes the op's record and a small ask file
// beside it in the loop's ops folder (ask-<name>.json, which listOps never reads as an op); the loop
// reads the ask when a slot is free, runs it with each phase on the op, and removes the ask. The op
// is cancelled by ending its record (op cancel, byLoop), which the loop reads before each step.
import { closeSync, constants, fstatSync, mkdirSync, openSync, readSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Json } from "./core/statement.ts";
import { begin, end, listOps, type Op, type OpFolder, readOp, toPhase, withProgress, writeOp } from "./core/ops.ts";
import { writeOwnedText } from "./core/rootfile.ts";
import { opType } from "./optypes/index.ts";

export interface LoopAsk {
  v: 1;
  op: string;
  at: number;
}

const NAME = /^[a-z][a-z0-9-]{0,40}$/;
export const askPath = (f: Pick<OpFolder, "dir">, name: string) => {
  if (!NAME.test(name)) throw new Error("not an ask's name");
  return join(f.dir, `ask-${name}.json`);
};

// The ask, read without following a link, owned by the loop's account. undefined when there is none.
export function readAsk(f: Pick<OpFolder, "dir" | "owner">, name: string): LoopAsk | undefined {
  let fd: number;
  try {
    fd = openSync(askPath(f, name), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return undefined;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > 4096 || st.uid !== f.owner) return undefined;
    const buf = Buffer.alloc(st.size);
    readSync(fd, buf, 0, st.size, 0);
    const v = JSON.parse(buf.toString("utf8")) as LoopAsk;
    return v && v.v === 1 && typeof v.op === "string" && typeof v.at === "number" ? v : undefined;
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

export const dropAsk = (f: Pick<OpFolder, "dir">, name: string) => rmSync(askPath(f, name), { force: true });

// The command's side: start the op, or attach to the one running with the same params.
export function askLoop(f: OpFolder, type: string, name: string, params: Record<string, Json>, now: number, actor = "service"): { op: Op; attached: boolean } | { busy: string } {
  mkdirSync(f.dir, { recursive: true, mode: 0o755 });
  const b = begin(listOps(f).ops, opType(type), { subject: name, params, actor }, now);
  if (b.kind === "busy") return { busy: b.why };
  if (b.kind === "start") writeOp(f, b.op);
  writeOwnedText(askPath(f, name), JSON.stringify({ v: 1, op: b.op.id, at: now }), { mode: 0o600, owner: f.owner });
  return { op: b.op, attached: b.kind === "attach" };
}

// The loop's side: the asked op's steps, or undefined when it ended meanwhile (the ask goes then).
export interface AskSteps {
  op: Op;
  phase(p: string, text?: string): void;
  progress(text: string): void;
  done(result: Record<string, Json>): void;
  fail(why: string, result?: Record<string, Json>): void;
  cancelled(): boolean;
}

export function takeAsk(f: Pick<OpFolder, "dir" | "owner">, name: string, now: () => number): AskSteps | undefined {
  const a = readAsk(f, name);
  if (!a) return undefined;
  const r = readOp(f, a.op);
  if (r.kind !== "ok" || r.value.state !== "running") {
    dropAsk(f, name);
    return undefined;
  }
  let op = r.value;
  const live = () => {
    const cur = readOp(f, op.id);
    return cur.kind === "ok" && cur.value.state === "running";
  };
  const put = (next: Op) => {
    // A cancel wins: the record is read again before each write.
    if (!live()) return;
    op = next;
    writeOp(f, op);
  };
  return {
    get op() {
      return op;
    },
    phase: (p, text) => {
      if (op.state === "running" && op.phases.indexOf(p) > op.phases.indexOf(op.phase)) put(toPhase(op, p, text ? { text } : null));
    },
    progress: (text) => op.state === "running" && put(withProgress(op, { text })),
    done: (result) => {
      put(end(op, "succeeded", now(), { result }));
      dropAsk(f, name);
    },
    fail: (why, result) => {
      put(end(op, "failed", now(), { why, ...(result ? { result } : {}) }));
      dropAsk(f, name);
    },
    cancelled: () => {
      if (live()) return false;
      dropAsk(f, name);
      return true;
    },
  };
}

// The command's watch of an asked op: each new phase or progress line once, until it ends or the
// --timeout runs out (exit 3; the op carries on). With --detach, the id at once.
export async function watchAsk(c: { say(l: string): void; sys: { now(): number; sleep(ms: number): Promise<void> } }, f: Pick<OpFolder, "dir" | "owner">, id: string, what: string, limitMs: number): Promise<{ exit: number; op?: Op }> {
  const until = limitMs ? c.sys.now() + limitMs : Infinity;
  let shown = "";
  for (;;) {
    const r = readOp(f, id);
    if (r.kind !== "ok") return { exit: 1 };
    const op = r.value;
    const line = `${op.phase}${op.progress?.text ? `: ${op.progress.text}` : ""}`;
    if (line !== shown && op.state === "running") c.say((shown = line));
    if (op.state !== "running") return { exit: op.state === "succeeded" ? 0 : 1, op };
    if (c.sys.now() >= until) {
      c.say(`Stopped watching. The ${what} carries on. taskbox op show ${id} -w watches it again; taskbox op cancel ${id} cancels it.`);
      return { exit: 3, op };
    }
    await c.sys.sleep(2_000);
  }
}
