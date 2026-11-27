// The selftest's agreement table: what the Linux selftest's VM met at each address it tried, beside
// what the rules evaluator says Softnet does there. Any address where the two differ fails the
// "Network rules" row and writes net.rules-disagree, so a Softnet whose rules changed meaning is
// caught at the next selftest. The selftest's own verdict on Softnet (proof.ts) is unchanged.
import { renameSync, writeFileSync } from "node:fs";
import { type Paths, readStateJson } from "../config.ts";
import { eventLog } from "../core/events.ts";
import { loopState } from "../core/paths.ts";
import type { Sys } from "../sys.ts";
import { netPaths } from "./paths.ts";
import { NO_ROUTE, PEER, type Target } from "../proof.ts";
import { clean } from "../progress.ts";
import type { Evaluator, Verdict } from "./rules.ts";

export interface AgreeRow {
  name: string;
  to: string; // an address, or "@host" for the bridge's gateway
  proto: "tcp" | "udp";
  port: number;
  want: "blocked" | "allowed"; // the evaluator's verdict
  got: "blocked" | "allowed"; // what the guest met
  why: string;
}

export interface RulesRecord {
  v: 1;
  at: number;
  rows: number;
  disagree: AgreeRow[];
}

// The table, from the proof's targets and the guest's answers. A try the proof says timed out (or,
// for another job VM, had no route) met a block; any other exit met an answer or a refusal, so the
// packet was let through. DNS at the bridge and the web must be let through.
export function agreement(ev: Evaluator, words: (v: Verdict) => string, targets: Target[], out: string): AgreeRow[] {
  const rows: AgreeRow[] = [];
  const row = (name: string, to: string, proto: "tcp" | "udp", port: number, got: AgreeRow["got"]) => {
    const v = ev.verdict({ to, proto, port });
    rows.push({ name, to, proto, port, want: v.allowed ? "allowed" : "blocked", got, why: words(v) });
  };
  for (const m of out.matchAll(/^T (\d+) (\d+) (\d+)$/gm)) {
    const t = targets[Number(m[1])];
    if (!t) continue;
    const blocked = m[3] === "124" || (t.name === PEER && m[3] === String(NO_ROUTE));
    row(t.name, t.host === "GATEWAY" ? "@host" : t.host, "tcp", Number(m[2]), blocked ? "blocked" : "allowed");
  }
  if (/^DNS (ok|failed)$/m.test(out)) row("DNS at the box", "@host", "udp", 53, /^DNS ok$/m.test(out) ? "allowed" : "blocked");
  const web = /^WEB (\d{3}) (\d{1,3}(?:\.\d{1,3}){3})$/m.exec(out);
  if (web) row("a public address (github.com)", web[2]!, "tcp", 443, web[1] === "000" ? "blocked" : "allowed");
  return rows;
}

export function writeRules(file: string, r: RulesRecord): void {
  writeFileSync(`${file}.tmp`, JSON.stringify(r), { mode: 0o644 });
  renameSync(`${file}.tmp`, file);
}

export function readRules(file: string): RulesRecord | undefined {
  const r = readStateJson<Record<string, unknown>>(file);
  if (!r || r.v !== 1 || !Number.isFinite(r.at) || !Number.isInteger(r.rows) || !Array.isArray(r.disagree)) return undefined;
  return r as unknown as RulesRecord;
}

const hhmm = (ms: number) => new Date(ms).toTimeString().slice(0, 5);

// The "Network rules" row.
export function rulesRow(r: RulesRecord | undefined): { status: "OK" | "FAIL" | "SKIP"; detail: string } {
  if (!r) return { status: "SKIP", detail: "the selftest hasn't compared taskbox's rules with Softnet yet. Waits by itself: it does on its next run" };
  if (!r.rows) return { status: "SKIP", detail: `the selftest at ${hhmm(r.at)} reported no tries to compare` };
  if (r.disagree.length) {
    const d = r.disagree.slice(0, 3).map((x) => `${clean(x.name)} ${x.proto} ${x.port}: Softnet ${x.got === "allowed" ? "let it through" : "blocked it"}, taskbox's rules say ${x.want}`);
    return { status: "FAIL", detail: `taskbox's rules and Softnet disagree (selftest ${hhmm(r.at)}): ${d.join("; ")}. Nothing to do: agents fix it` };
  }
  return { status: "OK", detail: `taskbox's rules and Softnet agree on ${r.rows} tries (selftest ${hhmm(r.at)})` };
}

// After each selftest: the table written for the row, and one net.rules-disagree per address the two
// disagree on. Never throws: the selftest's own result stands whatever happens here.
export function recordAgreement(d: { paths: Paths; sys: Sys }, ev: Evaluator, words: (v: Verdict) => string, targets: Target[], out: string): AgreeRow[] {
  try {
    const rows = agreement(ev, words, targets, out);
    const disagree = rows.filter((r) => r.want !== r.got);
    writeRules(netPaths(d.paths).rules, { v: 1, at: d.sys.now(), rows: rows.length, disagree: disagree.slice(0, 20) });
    const log = eventLog("loop", { dir: loopState(d.paths.state).events, owner: process.getuid?.() ?? 0 }, d.sys);
    for (const x of disagree.slice(0, 5)) log.write({ type: "net.rules-disagree", actor: "taskbox", text: `taskbox's rules and Softnet disagree on ${clean(x.name)} ${x.proto} ${x.port}: Softnet ${x.got === "allowed" ? "let it through" : "blocked it"}.`, data: { to: x.to, proto: x.proto, port: x.port, want: x.want, got: x.got } });
    return disagree;
  } catch {
    return [];
  }
}
