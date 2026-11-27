// Temporary admin SSH: one person's Tailscale login may reach one admin user on this box, in accept
// mode, until a set time. It is this box's own key (the overlay), and a first-tier guarded key: it
// opens only by the owner's settings apply and an admin's confirm at the box. taskbox policy writes
// the rule while the window is open and drops it after; check warns while it is open, and once the
// pasted policy has dropped it, says the access has gone. No agent identity is ever allowed: no tag,
// no autogroup, and never an account taskbox gives a role.
import { type Accounts, named, poolNames, TAILNET_LOGIN } from "../access.ts";

export interface AdminSsh {
  login: string; // the person's Tailscale login
  user: string; // their admin user on the box
  until: string; // ISO 8601, UTC
}

export const ADMIN_SSH_MAX_MS = 30 * 86_400_000;
const USER = /^[A-Za-z_][A-Za-z0-9._-]{0,31}$/;
const RESERVED = ["root", "daemon", "nobody"];

// Why a value can't be the setting, or undefined. Pure: the clock is checked where a commit is taken.
export function adminSshProblem(v: unknown, a?: Accounts): string | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return "adminSsh is { login, user, until }";
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!["login", "user", "until"].includes(k)) return `adminSsh has no setting ${k.slice(0, 30)}`;
  if (typeof o.login !== "string" || !TAILNET_LOGIN.test(o.login)) return "adminSsh.login is one person's Tailscale login, such as pat@example.com: never a tag, an autogroup or an agent's";
  if (typeof o.user !== "string" || !USER.test(o.user) || RESERVED.includes(o.user.toLowerCase()) || o.user.startsWith("_")) return "adminSsh.user is that person's admin user on the box";
  if (a) {
    const roles = [...named(a).map((n) => n.name), ...poolNames(a)].map((n) => n.toLowerCase());
    if (roles.includes((o.user as string).toLowerCase())) return "adminSsh.user is an admin, never an account taskbox gives a role: the agent, the service, a person or a workspace";
  }
  if (typeof o.until !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d{1,3})?Z$/.test(o.until) || Number.isNaN(Date.parse(o.until))) return "adminSsh.until is a time in UTC, such as 2026-12-01T18:00:00Z";
  return undefined;
}

// Why the setting can't be taken now: an expiry past, or more than 30 days off.
export function adminSshWhenProblem(v: AdminSsh, now: number): string | undefined {
  const t = Date.parse(v.until);
  if (t <= now) return `adminSsh.until, ${v.until}, is past: a window opens only into the future`;
  if (t - now > ADMIN_SSH_MAX_MS) return "adminSsh.until is at most 30 days off: it is temporary";
  return undefined;
}

// The window, if open now.
export function openWindow(v: AdminSsh | undefined, now: number): AdminSsh | undefined {
  return v && Date.parse(v.until) > now ? v : undefined;
}

// One line for status and check.
export const windowLine = (v: AdminSsh) => `${v.login} may reach admin user ${v.user} by Tailscale SSH until ${v.until}`;
