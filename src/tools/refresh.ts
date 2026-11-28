// taskbox tool refresh: an op the service account starts and the loop runs. The command writes the op's
// record and the request (refresh.json) in the service's own folders; the loop's next free slot reads
// the request, runs the pass with every phase on the op, and removes the request. Pins never change.
import { closeSync, constants, fstatSync, mkdirSync, openSync, readSync, rmSync } from "node:fs";
import { begin, end, listOps, type Op, type OpFolder, readOp, toPhase, withProgress, writeOp } from "../core/ops.ts";
import { opType } from "../optypes/index.ts";
import { writeOwnedText } from "../core/rootfile.ts";
import type { Store } from "./store.ts";

// Its type is declared in src/optypes/tools.ts.
const TOOL_REFRESH = () => opType("tool-refresh");

export interface RefreshAsk {
  v: 1;
  op: string;
  at: number;
}

// The request, read without following a link. undefined when there is none, or it isn't one.
export function readRefresh(s: Store): RefreshAsk | undefined {
  let fd: number;
  try {
    fd = openSync(s.refresh, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return undefined;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > 4096) return undefined;
    const buf = Buffer.alloc(st.size);
    readSync(fd, buf, 0, st.size, 0);
    const v = JSON.parse(buf.toString("utf8")) as RefreshAsk;
    return v && v.v === 1 && typeof v.op === "string" && typeof v.at === "number" ? v : undefined;
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

export const dropRefresh = (s: Store) => rmSync(s.refresh, { force: true });

// The command's side: start the op, or attach to the one running. The request names the op.
export function askRefresh(f: OpFolder, s: Store, now: number, actor = "service"): { op: Op; attached: boolean } | { busy: string } {
  // The loop's ops folder, the first time a loop op is asked for: every account may follow an op.
  mkdirSync(f.dir, { recursive: true, mode: 0o755 });
  const b = begin(listOps(f).ops, TOOL_REFRESH(), { subject: "box", params: {}, actor }, now);
  if (b.kind === "busy") return { busy: b.why };
  if (b.kind === "start") writeOp(f, b.op);
  writeOwnedText(s.refresh, JSON.stringify({ v: 1, op: b.op.id, at: now }), { mode: 0o600, owner: f.owner });
  return { op: b.op, attached: b.kind === "attach" };
}

// The loop's side: each phase and step on the op, as the pass reaches it.
export interface RefreshSteps {
  phase(p: string): void;
  progress(text: string): void;
  done(text: string): void;
  fail(why: string): void;
}

export function refreshSteps(f: OpFolder, s: Store, id: string, now: () => number, onChange: (before: Op, after: Op) => void = () => {}): RefreshSteps | undefined {
  const r = readOp(f, id);
  if (r.kind !== "ok" || r.value.state !== "running") {
    dropRefresh(s);
    return undefined;
  }
  let op = r.value;
  const put = (next: Op) => {
    // A cancel (op cancel) wins: the op is read again before each write.
    const cur = readOp(f, id);
    if (cur.kind === "ok" && cur.value.state !== "running") return;
    onChange(op, next);
    op = next;
    writeOp(f, op);
  };
  return {
    phase: (p) => {
      if (op.state === "running" && op.phases.indexOf(p) > op.phases.indexOf(op.phase)) put(toPhase(op, p));
    },
    progress: (text) => op.state === "running" && put(withProgress(op, { text })),
    done: (text) => {
      put(end(op, "succeeded", now(), { result: { text } }));
      dropRefresh(s);
    },
    fail: (why) => {
      put(end(op, "failed", now(), { why }));
      dropRefresh(s);
    },
  };
}

// Whether the op was cancelled since the loop took it, so the pass stops.
export function refreshCancelled(f: Pick<OpFolder, "dir" | "owner">, id: string): boolean {
  const r = readOp(f, id);
  return r.kind === "ok" && r.value.state === "cancelled";
}
