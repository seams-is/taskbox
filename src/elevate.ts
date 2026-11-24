// The commands that need root, typed by someone who isn't root. An admin's command re-runs itself
// through sudo, which asks for the admin's password. Anyone else is told to switch users, since
// sudo asks for the password of the user typing it and a standard user's never works. Both paths
// are fixed: nothing looks up PATH, and no environment passes through.
import { RELEASE_TAG } from "./github.ts";
import type { Sys } from "./sys.ts";

export const ROOT_COMMANDS = ["update", "undo", "remove", "unlock"];
export const TASKBOX = "/opt/taskbox/bin/taskbox";
export const SUDO = "/usr/bin/sudo";

// What a root command may be given. update takes one release tag (a trial's too, from v2.6.1) or
// nothing; the others take nothing. Root checks it again after the re-run.
export function argsProblem(cmd: string, rest: string[]): string | undefined {
  if (cmd === "update") return rest.length === 0 || (rest.length === 1 && RELEASE_TAG.test(rest[0]!)) ? undefined : "Type taskbox update for the newest release, or taskbox update and a release, such as v2.6.1 or v3.0.0-rc.1.";
  return rest.length ? `Type taskbox ${cmd} with nothing after it.` : undefined;
}

export type Elevation = { say: string; argv?: string[] };

export function elevation(cmd: string, rest: string[], admin: boolean): Elevation {
  if (!admin) return { say: `Switch to your admin user and type taskbox ${cmd}.` };
  return { say: `taskbox ${cmd} needs your admin password.`, argv: [SUDO, "-p", "Password for %u: ", "--", TASKBOX, cmd, ...rest] };
}

// Whether a user is an admin. dseditgroup says 0 for a member and 67 for a user who isn't one.
// Anything else, or a name that isn't a user name, counts as not an admin, so nothing runs.
// For checks, which must fail closed: "unknown" when dseditgroup can't say, or the user isn't there.
export async function adminState(sys: Sys, user: string): Promise<"admin" | "standard" | "unknown"> {
  if (!/^[A-Za-z_][A-Za-z0-9._-]{0,31}$/.test(user)) return "unknown";
  const r = await sys.run("/usr/sbin/dseditgroup", ["-o", "checkmember", "-m", user, "admin"], { timeoutMs: 5_000 }).catch(() => ({ code: -1 }));
  return r.code === 0 ? "admin" : r.code === 67 ? "standard" : "unknown";
}

export async function isAdmin(sys: Sys, user: string): Promise<boolean> {
  if (!/^[A-Za-z_][A-Za-z0-9._-]{0,31}$/.test(user)) return false;
  const r = await sys.run("/usr/sbin/dseditgroup", ["-o", "checkmember", "-m", user, "admin"], { timeoutMs: 5_000 }).catch(() => ({ code: -1 }));
  return r.code === 0;
}
