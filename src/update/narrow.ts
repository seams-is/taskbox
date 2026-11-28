// A rollback's settings: the commit recorded at the kept install's own install, so the release gone
// back to reads only settings it accepted, with one exception: every guarded key where the state now
// is narrower (a person or a pin removed, tools off, the channel on stable, a rule deleted) stays as
// it is now. A rollback never brings back access that was taken away.
import { guardedChanges, holdBack } from "../settings/guarded.ts";
import { type InForce, readInForce, readValidated, type SettingsFiles, updateState, type Writer, writeInForce } from "../settings/inforce.ts";

type Doc = Record<string, unknown>;

// The recorded doc, with each guarded key that would widen from now held at now's value.
export function narrowed(recorded: Doc, now: Doc): { doc: Doc; held: string[] } {
  const held = guardedChanges(now, recorded).filter((c) => !c.narrows).map((c) => c.path);
  return { doc: holdBack(recorded, now, held), held };
}

// Puts the recorded commit back in force, narrowed. Why it couldn't, or undefined. With no commit
// recorded (an install from before the settings repo) the settings stay as they are.
export async function rollbackSettings(f: SettingsFiles, sha: string | null, w: Writer & { now: number }): Promise<string | undefined> {
  if (sha === null) return undefined;
  const cur = readInForce(f, w.rootUid ?? 0);
  if (cur.kind === "ok" && cur.value.sha === sha) return undefined;
  const v = readValidated(f, sha, w.rootUid ?? 0);
  if (v.kind !== "ok") return `the settings commit ${sha.slice(0, 12)} it was installed with isn't kept on the box`;
  const now = cur.kind === "ok" ? cur.value.doc : {};
  const n = narrowed(v.value.doc, now);
  const doc: InForce = { v: 1, sha, at: w.now, held: n.held, doc: n.doc, overlayKeys: v.value.overlay ? Object.keys(v.value.overlay) : [], overlayIgnored: v.value.overlayIgnored, ...(v.value.overlayProblem ? { overlayProblem: v.value.overlayProblem } : {}), unknown: v.value.unknown };
  writeInForce(f, doc, w);
  await updateState(f, w, (s) => ({ state: { ...s, inUse: sha, waiting: undefined, deferred: undefined }, out: undefined }));
  return undefined;
}
