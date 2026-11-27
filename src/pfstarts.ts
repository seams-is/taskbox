// Screen Sharing and VM starts. A VM start is when vmnet could reload pf, so after the guard's rules
// went missing at a start, v2 started no VM while Screen Sharing was on (the loop's guardClosed). v3
// counts, on each box, the VM starts made with Screen Sharing on that the guard read again at least
// PF_READ_AFTER_MS after, with its rules in place. After PF_STARTS_NEEDED of them in a row the rule
// lifts on that box. Any loss after puts it back, starts the count again, and writes
// vm.pf-lost-at-start. The count lives in the loop's state, so a new box starts at none.
import { eventLog } from "./core/events.ts";
import { loopState } from "./core/paths.ts";
import type { Check, CheckContext } from "./checks.ts";
import { type Config, readStateJson } from "./config.ts";
import type { Row } from "./core/rows.ts";
import type { Sys } from "./sys.ts";

export const PF_STARTS_NEEDED = 100;
export const PF_READ_AFTER_MS = 10_000;

export interface PfStarts {
  clean: number; // starts in a row with Screen Sharing on and the rules in place
  lostAt?: number; // the last start the rules went missing at
}

export function pfStartsOf(v: unknown): PfStarts {
  const s = v as PfStarts | undefined;
  return s && typeof s === "object" && Number.isSafeInteger(s.clean) && s.clean >= 0 ? { clean: s.clean, ...(Number.isSafeInteger(s.lostAt) ? { lostAt: s.lostAt } : {}) } : { clean: 0 };
}

// Whether VM starts may go ahead with Screen Sharing on after a loss: the setting a box check job
// set, or this box's own count.
export const pfProven = (cfg: Pick<Config, "vmnetPfProven">, state: { pfStarts?: unknown }) => cfg.vmnetPfProven === true || pfStartsOf(state.pfStarts).clean >= PF_STARTS_NEEDED;

export interface PfStart {
  at: number; // when the VM started
  sharing: boolean; // Screen Sharing was on
  readAt?: number; // the guard's last read, as the loop saw it once the guest was up
  lost: boolean; // the rules went missing at the start
}

// The next count, and what changed. A start the guard hasn't read 10 s after, or one with Screen
// Sharing off, says nothing either way.
export function nextPfStarts(was: PfStarts, s: PfStart): { next: PfStarts; lifted: boolean; back: boolean } {
  if (s.lost) return { next: { clean: 0, lostAt: s.at }, lifted: false, back: was.clean >= PF_STARTS_NEEDED };
  if (!s.sharing || s.readAt === undefined || s.readAt < s.at + PF_READ_AFTER_MS) return { next: was, lifted: false, back: false };
  const next = { ...was, clean: was.clean + 1 };
  return { next, lifted: next.clean === PF_STARTS_NEEDED, back: false };
}

export interface PfDeps {
  sys: Sys;
  paths: { state: string };
  log: { write(line: string): void };
  state: { pfStarts?: unknown };
  write(patch: Record<string, unknown>): void;
}

// One VM start, counted. Screen Sharing is read only when it can change the count.
export async function countPfStart(d: PfDeps, s: Omit<PfStart, "sharing">, sharingOn: (sys: Sys) => Promise<boolean>): Promise<void> {
  const was = pfStartsOf(d.state.pfStarts);
  const sharing = s.lost || (s.readAt !== undefined && s.readAt >= s.at + PF_READ_AFTER_MS) ? await sharingOn(d.sys).catch(() => true) : false;
  const r = nextPfStarts(was, { ...s, sharing });
  if (r.next !== was) d.write({ pfStarts: r.next });
  if (r.lifted) d.log.write(`${PF_STARTS_NEEDED} VM starts in a row with Screen Sharing on left the guard's rules in place, so VMs start with Screen Sharing on after a loss now`);
  if (!s.lost) return;
  const text = r.back ? `The guard's rules went missing at a VM start after ${was.clean} that left them in place, so no VM starts while Screen Sharing is on until ${PF_STARTS_NEEDED} more do.` : `The guard's rules went missing at a VM start${sharing ? " with Screen Sharing on" : ""}; the count of starts that leave them in place begins again.`;
  try {
    eventLog("loop", { dir: loopState(d.paths.state).events, owner: process.getuid?.() ?? 0 }, d.sys).write({ type: "vm.pf-lost-at-start", actor: "taskbox", text, data: { sharing, after: was.clean } });
  } catch (e) {
    d.log.write(`could not write vm.pf-lost-at-start: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
  }
}

// taskbox check: how far the box is toward the 100 starts.
export async function pfStartsRow(c: CheckContext): Promise<Omit<Check, "name">> {
  const st = readStateJson<{ pfStarts?: unknown }>(c.paths.loopState) ?? {};
  const s = pfStartsOf(st.pfStarts);
  if (c.cfg.vmnetPfProven === true) return { status: "OK", detail: `vmnetPfProven is set, so VMs start with Screen Sharing on after a loss. ${s.clean} starts counted in a row` };
  const lost = s.lostAt !== undefined ? `. The rules last went missing at a start at ${new Date(s.lostAt).toISOString().slice(0, 16).replace("T", " ")} UTC` : "";
  return { status: "OK", detail: s.clean >= PF_STARTS_NEEDED ? `${s.clean} VM starts in a row with Screen Sharing on left the guard's rules in place, so a loss no longer stops starts while it is on${lost}` : `${s.clean} of ${PF_STARTS_NEEDED} VM starts with Screen Sharing on have left the guard's rules in place${lost}` };
}

export const PF_ROWS: Row[] = [{ name: "Screen Sharing and VM starts", fn: pfStartsRow, order: 8030, in: ["check"] }];
