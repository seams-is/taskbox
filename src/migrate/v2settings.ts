// v2.6.1's settings, as v3 reads them while it moves the box (migrate-v3, step 1). v2.6.1 keeps its
// taskbox.json in its own install folder, which the hop keeps as /opt/taskbox.prev. v3's tree has
// none, so until the settings repo's first commit is in force, v3 runs on that file, converted:
// the same Apps, images, kinds and sizes, with v3's defaults for everything new.
// - Before step 1, only root can read it: the kept install is root's at 700 (keepInert). That is
//   the guard and the migration's child, which are root's.
// - Step 1 writes the converted file once to root's state, 0644, so every reader takes it from
//   there: the loop, check, and later a box whose v2.6.1 install is gone.
// Nothing here writes v2.6.1's own files.
import { lstatSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isObj, readOwnedJson, safeParse, writeOwnedText, type WriteRules } from "../core/rootfile.ts";

// v2's service account: the one v2.6.1 runs as. v2's agent, when taskbox.json names none.
export const V2_SERVICE = "ci";
export const V2_AGENT = "remote";
export const V2_SETTINGS_MAX = 256 * 1024;

// The state folder beside an install's app folder: /opt/taskbox-state for /opt/taskbox/app.
const stateDirOf = (app: string) => join(dirname(dirname(app)), "taskbox-state");
// The converted file, root's, 0644.
export const v2SettingsPath = (app: string) => join(stateDirOf(app), "settings", "v2.json");
// The kept install's app folder: /opt/taskbox.prev/app for /opt/taskbox/app.
export const keptAppOf = (app: string) => join(`${dirname(app)}.prev`, "app");

// v2.6.1's file in v3's shape. Its accounts are v2's: ci the service, remoteUser the agent, and
// screenSharingUsers the people. v3 reads the rest as it is.
export function convertV2(doc: Record<string, unknown>): Record<string, unknown> {
  const { remoteUser, screenSharingUsers, accounts, ...rest } = doc;
  if (isObj(accounts)) return { ...rest, accounts };
  const agent = typeof remoteUser === "string" ? remoteUser : V2_AGENT;
  const people = Array.isArray(screenSharingUsers) ? screenSharingUsers.filter((n): n is string => typeof n === "string") : [];
  return { ...rest, accounts: { service: V2_SERVICE, agent, people } };
}

// The kept install is v2's: its installed.json names a v2 tag and it has no v3 install record.
export function keptIsV2(app: string): boolean {
  const kept = dirname(keptAppOf(app));
  try {
    lstatSync(join(kept, "install.json"));
    return false;
  } catch {}
  try {
    const tag = (safeParse(readFileSync(join(kept, "installed.json"), "utf8")) as { tag?: unknown } | undefined)?.tag;
    return typeof tag === "string" && /^v2\.\d{1,4}\.\d{1,4}$/.test(tag);
  } catch {
    return false;
  }
}

// v2.6.1's own taskbox.json, read from the kept install, converted. Root's read only.
export function readKeptV2(app: string): Record<string, unknown> | undefined {
  if (!keptIsV2(app)) return undefined;
  try {
    const st = lstatSync(join(keptAppOf(app), "taskbox.json"));
    if (!st.isFile() || st.size > V2_SETTINGS_MAX) return undefined;
    const v = safeParse(readFileSync(join(keptAppOf(app), "taskbox.json"), "utf8"));
    return isObj(v) ? convertV2(v) : undefined;
  } catch {
    return undefined;
  }
}

// The converted file as step 1 wrote it, read by the owned-file rules, root's.
export function readV2Copy(app: string, rootUid = 0): Record<string, unknown> | undefined {
  const r = readOwnedJson(v2SettingsPath(app), { owner: rootUid, max: V2_SETTINGS_MAX }, (v) => (isObj(v) ? v : "not an object"));
  return r.kind === "ok" ? r.value : undefined;
}

// What v3 runs on at the hop: the copy, else the kept install's file (root only). undefined when
// this box isn't moving from v2.
export function hopSettings(app: string, rootUid = 0): Record<string, unknown> | undefined {
  return readV2Copy(app, rootUid) ?? readKeptV2(app);
}

// Step 1's write of the copy. Kept as it is once written: a re-run reads the same file again.
export function writeV2Copy(app: string, doc: Record<string, unknown>, w: Pick<WriteRules, "chown" | "owner">): void {
  writeOwnedText(v2SettingsPath(app), `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o644, ...w });
}
