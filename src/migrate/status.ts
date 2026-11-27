// What taskbox status shows of the move to v3, from the journal and v2.6.1's watch file, both root's
// at 0644, so anyone reads them: the step, the rollback clock's one line, and what waits on a person.
// Once proved, one line for a day, then nothing.
import { readRollbackWatch } from "../hop.ts";
import type { Paths } from "../config.ts";
import { finished, nextStep, readJournal, type Step } from "./journal.ts";
import { clockLine } from "./run.ts";

const WORDS: Record<Step, string> = {
  loop: "checking the loop runs",
  read: "reading v2.6.1's settings",
  keys: "handing the Apps' keys to the GitHub key keeper",
  "v2-jobs": "v2.6.1's running jobs finish",
  "v3-loop": "v3's loop starts",
  settings: "reading the settings repo",
  tools: "checking the tools",
  accounts: "making taskbox's accounts",
  daemons: "starting guardwatch and network capture",
  events: "starting the event log",
  tidy: "removing old services",
  proof: "proving v3",
};

export function moveLines(stateDir: string, p: Pick<Paths, "guardPlist" | "tailscaleState">, now: number, rootUid = 0): string[] {
  const r = readJournal(stateDir, rootUid);
  if (r.kind === "bad") return [`Move:      the move to v3's journal can't be read (${r.why})`];
  if (r.kind === "missing") return [];
  const j = r.value;
  if (finished(j)) return now - j.done.proof! < 86_400_000 ? [`Move:      proved: ${j.tag}`] : [];
  if (j.failed) return [`Move:      stopped: ${j.failed.slice(0, 160)}. v2.6.1's rollback watcher takes the box back.`];
  const step = nextStep(j)!;
  const w = readRollbackWatch(p);
  const out = [`Move:      to ${j.tag}: ${WORDS[step]}${j.tries ? ` (try ${j.tries.n}: ${j.tries.why.slice(0, 80)})` : ""}`];
  if (w && !w.proved) out.push(`           ${clockLine(w, step === "v2-jobs" ? { running: true, jobs: j.v2Jobs?.seen ?? 0, ...(j.v2Jobs?.since !== undefined ? { since: j.v2Jobs.since } : {}) } : undefined)}`);
  for (const n of j.notes ?? []) out.push(`           ${n}`);
  return out;
}
