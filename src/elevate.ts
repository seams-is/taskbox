// The commands that need root, typed by someone who isn't root. An admin's command re-runs itself
// through sudo, which asks for the admin's password. Anyone else is told to switch users, since
// sudo asks for the password of the user typing it and a standard user's never works. Both paths
// are fixed: nothing looks up PATH, and no environment passes through.
import { RELEASE_TAG } from "./github.ts";
import type { Sys } from "./sys.ts";

export const ROOT_COMMANDS = ["update", "undo", "remove", "unlock", "connect", "disconnect", "approver", "clear"];
export const TASKBOX = "/opt/taskbox/bin/taskbox";
export const SUDO = "/usr/bin/sudo";

// What a root command may be given. update takes one release tag (a trial's too, from v2.6.1) or
// nothing; the others take nothing. Root checks it again after the re-run.
export function argsProblem(cmd: string, rest: string[]): string | undefined {
  if (cmd === "connect") {
    const load = rest[1] === "--load" && (rest.length === 3 ? rest[2] === "off" : rest.length === 4);
    const ok = rest[0] === "github" && (rest.length === 1 || (rest.length === 2 && rest[1] === "--new-key") || load);
    return ok ? undefined : "Type taskbox connect github, taskbox connect github --new-key for a new key for the same App, or taskbox connect github --load and the test repo and its runner group (--load off takes it out).";
  }
  if (cmd === "disconnect") return rest.length === 1 && rest[0] === "github" ? undefined : "Type taskbox disconnect github.";
  if (cmd === "update") return rest.length === 0 || (rest.length === 1 && RELEASE_TAG.test(rest[0]!)) ? undefined : "Type taskbox update for the newest release, or taskbox update and a release, such as v2.6.1 or v3.0.0-rc.1.";
  // At the box, approver only clears the key: the owner makes it on the laptop.
  // clear takes one agent's name, which the clear itself checks again as root.
  if (cmd === "clear") return rest.length === 1 && /^[a-z][a-z0-9]{0,15}$/.test(rest[0]!) ? undefined : "Type taskbox clear and an agent's name, such as nova, to delete the files of its workspace account.";
  if (cmd === "approver") return rest.length === 1 && rest[0] === "--reset" ? undefined : "Type taskbox approver --reset to clear the approver key this box trusts. You make the key on your laptop.";
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

// The admin group's members, by their short names, or undefined when the group can't be read.
// No root needed: dscl reads the local directory as any user.
export async function adminsOf(sys: Sys): Promise<string[] | undefined> {
  const r = await sys.run("/usr/bin/dscl", [".", "-read", "/Groups/admin", "GroupMembership"], { timeoutMs: 5_000 }).catch(() => ({ code: -1, stdout: "" }));
  if (r.code !== 0) return undefined;
  const m = /^GroupMembership:(.*)$/m.exec(r.stdout);
  return (m?.[1] ?? "").trim().split(/\s+/).filter((n) => /^[A-Za-z_][A-Za-z0-9._-]{0,31}$/.test(n));
}
