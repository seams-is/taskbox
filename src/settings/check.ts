// A settings read asked for now, as update --check asks one: readNow in the settings state, which the
// guard's pass takes on its next tick (passes/settings.ts), then the outcome in the box's own words.
// The releases package reads the same lines beside its own.
import type { Sys } from "../sys.ts";
import { readState, type SettingsFiles, updateState, type Writer } from "./inforce.ts";

export const READ_POLLS = 40;
export const READ_POLL_MS = 500;

// Asks the guard to read the settings repo's head now, waits up to READ_POLLS for the read, and says
// what it found. Root's: the state file is root's alone.
export async function settingsReadNow(sys: Pick<Sys, "now" | "sleep">, files: SettingsFiles, w: Writer): Promise<{ read: boolean; lines: string[] }> {
  const root = w.rootUid ?? 0;
  const was = readState(files, root);
  if (was.kind === "missing" || (was.kind === "ok" && !was.value.repo && !was.value.head)) return { read: false, lines: ["Settings: this box reads no settings repo yet. taskbox settings repo ORG/REPO names it."] };
  const since = sys.now();
  await updateState(files, w, (s) => ({ state: { ...s, readNow: true }, out: undefined }));
  for (let i = 0; i < READ_POLLS; i++) {
    const s = readState(files, root);
    if (s.kind === "ok" && !s.value.readNow) {
      const v = s.value;
      const lines: string[] = [];
      if (v.problem && v.problem.at >= since) lines.push(`Settings: ${v.problem.sha ? `commit ${v.problem.sha.slice(0, 12)} isn't used: ` : ""}${v.problem.why}.`);
      else if (v.waiting) lines.push(`Settings: commit ${v.waiting.sha.slice(0, 12)} waits for ${v.waiting.phase === "needs-confirm" ? "taskbox confirm at the box" : `taskbox settings apply ${v.waiting.sha} from the controller`}.`);
      else lines.push(`Settings: commit ${(v.inUse ?? v.head?.sha ?? "unknown").slice(0, 12)}${v.repo ? ` of ${v.repo}` : ""} is in force, and the head was read just now.`);
      return { read: true, lines };
    }
    await sys.sleep(READ_POLL_MS);
  }
  return { read: false, lines: ["Settings: the guard hasn't read the settings repo yet. It reads it on its next pass; taskbox check says if the guard is down."] };
}
