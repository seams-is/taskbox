// The commands that need root, typed by someone who isn't root (each is marked root in src/cmd/). An admin's command re-runs itself
// through sudo, which asks for the admin's password. Anyone else is told to switch users, since
// sudo asks for the password of the user typing it and a standard user's never works. Both paths
// are fixed: nothing looks up PATH, and no environment passes through.
import { pathOf, rootCommands } from "./registry.ts";
import type { Sys } from "./sys.ts";

// The commands marked root in the registry (src/cmd/), by their paths, such as "connect github".
export const rootPaths = (): string[] => rootCommands().map(pathOf);
export const TASKBOX = "/opt/taskbox/bin/taskbox";
export const SUDO = "/usr/bin/sudo";

export type Elevation = { say: string; argv?: string[] };

// What a root command's run says, and the sudo line it runs. Root parses the line again after the re-run.
export function elevation(path: string, rest: string[], admin: boolean): Elevation {
  if (!admin) return { say: `Switch to your admin user and type taskbox ${path}.` };
  return { say: `taskbox ${path} needs your admin password.`, argv: [SUDO, "-p", "Password for %u: ", "--", TASKBOX, ...path.split(" "), ...rest] };
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

// The admin group's members, by their short names, or undefined when the group can't be read.
// No root needed: dscl reads the local directory as any user.
export async function adminsOf(sys: Sys): Promise<string[] | undefined> {
  const r = await sys.run("/usr/bin/dscl", [".", "-read", "/Groups/admin", "GroupMembership"], { timeoutMs: 5_000 }).catch(() => ({ code: -1, stdout: "" }));
  if (r.code !== 0) return undefined;
  const m = /^GroupMembership:(.*)$/m.exec(r.stdout);
  return (m?.[1] ?? "").trim().split(/\s+/).filter((n) => /^[A-Za-z_][A-Za-z0-9._-]{0,31}$/.test(n));
}
