// The loop's first lines at the move to v3, run as the service account before
// anything is read:
// - it writes loop-start.json, its pid, its install and the time, in the service account's state, so
//   the guard tells v3's loop from v2.6.1's under the one label;
// - it removes v2.6.1's stopped.json and drain.json, so neither can stop v2.6.1's loop after a
//   rollback. Root writes nothing in the service account's home;
// - while migrate-v3 runs it waits, gated, and starts no VM: until the journal says the gate is lifted.
//   It exits 75 the moment /opt/taskbox stops naming its install, so launchd starts that one.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeOwnedText } from "../core/rootfile.ts";
import { readJournal } from "./journal.ts";

export const GATE_POLL_MS = 5_000;
export const WAITING = "waiting for the move to v3";

export interface GateDeps {
  root: string; // "/" on a box
  serviceHome: string; // /Users/<service>
  serviceUid: number;
  pid: number;
  install: string | undefined; // the install this code runs from
  now(): number;
  sleep(ms: number): Promise<void>;
  moved(): boolean; // /opt/taskbox names another install
  settingsReadable(): boolean; // the loop can read its settings
  log(line: string): void;
  rootUid?: number;
}

export const loopStartPath = (serviceHome: string) => join(serviceHome, ".taskbox", "loop-start.json");
const stateDir = (root: string) => join(root, "opt/taskbox-state");

export interface LoopStart {
  v: 1;
  pid: number;
  install: string;
  at: number;
}

export function writeLoopStart(d: Pick<GateDeps, "serviceHome" | "serviceUid" | "pid" | "install" | "now">): void {
  if (!d.install) return;
  mkdirSync(join(d.serviceHome, ".taskbox"), { recursive: true, mode: 0o700 });
  const s: LoopStart = { v: 1, pid: d.pid, install: d.install, at: d.now() };
  writeOwnedText(loopStartPath(d.serviceHome), `${JSON.stringify(s)}\n`, { mode: 0o644, owner: d.serviceUid });
}

// v2.6.1's stop and drain marks, in its project's folder of the service's state.
export function dropV2Marks(serviceHome: string, project: string | undefined): void {
  if (!project || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(project)) return;
  for (const f of ["stopped.json", "drain.json"]) rmSync(join(serviceHome, ".taskbox", project, f), { force: true });
}

// undefined: carry on into the loop. A number: the loop's exit code.
export async function loopGate(d: GateDeps): Promise<number | undefined> {
  writeLoopStart(d);
  let said = false;
  for (;;) {
    if (d.moved()) return 75;
    const j = readJournal(stateDir(d.root), d.rootUid ?? 0);
    if (j.kind === "ok") dropV2Marks(d.serviceHome, j.value.project);
    // A journal it can't read keeps the gate: only the guard's own word lifts it.
    const gated = j.kind === "ok" ? j.value.lifted !== true : j.kind === "bad" || !d.settingsReadable();
    if (!gated) return undefined;
    if (!said) d.log(`The loop starts no VM yet: ${WAITING}.`);
    said = true;
    await d.sleep(GATE_POLL_MS);
  }
}
