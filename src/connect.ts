// taskbox connect github: makes the box's job source App with GitHub's App manifest flow, has the
// owner install it on the jobs repo, and keeps it in the box's own settings.
// This part is pure: the manifest, the page, and the
// checks on GitHub's answers. The listener and the steps that change the box come with them.

import { createPrivateKey } from "node:crypto";

// The rights the App gets, and nothing else: as the job source's key is proved today (actionskey.ts).
export const SOURCE_PERMISSIONS = { actions: "read", metadata: "read" } as const;

export type Manifest = {
  name: string;
  url: string;
  hook_attributes: { url: string; active: false };
  redirect_url: string;
  public: false;
  default_permissions: typeof SOURCE_PERMISSIONS;
  default_events: [];
};

// App names are unique on all of GitHub, at most 34 characters (read: GitHub's docs). So the name
// carries the org and the box, and a replace adds four random hex characters.
export function appName(org: string, boxName: string, suffix = ""): string {
  const tail = `-jobs${suffix ? `-${suffix}` : ""}`;
  const base = `${org}-${boxName}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-");
  return `${base.slice(0, 34 - tail.length).replace(/-$/, "")}${tail}`;
}

export function manifestFor(org: string, name: string, port: number): Manifest {
  return {
    name,
    url: `https://github.com/${org}`,
    hook_attributes: { url: `https://github.com/${org}`, active: false },
    redirect_url: `http://127.0.0.1:${port}/done`,
    public: false,
    default_permissions: SOURCE_PERMISSIONS,
    default_events: [],
  };
}

const html = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// The one page: a form that posts the manifest to GitHub's org page, sent as soon as it loads.
export function startPage(org: string, state: string, m: Manifest): string {
  const action = `https://github.com/organizations/${encodeURIComponent(org)}/settings/apps/new?state=${encodeURIComponent(state)}`;
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8"><title>taskbox connect github</title></head>',
    "<body>",
    `<form id="f" method="post" action="${html(action)}">`,
    `<input type="hidden" name="manifest" value="${html(JSON.stringify(m))}">`,
    "<p>taskbox is opening GitHub to make the box's job source App. If nothing happens, click the button.</p>",
    '<button type="submit">Open GitHub</button>',
    "</form>",
    '<script>document.getElementById("f").submit()</script>',
    "</body></html>",
  ].join("\n");
}

// The headers every answer carries: nothing cached, nothing framed, and the page may only post its
// one form to github.com and run its one line.
export function pageHeaders(): Record<string, string> {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'none'; form-action https://github.com; script-src 'unsafe-inline'; frame-ancestors 'none'",
  };
}

export type Conversion = { id: number; slug: string; pem: string };

// Why GitHub's answer to the code isn't the App taskbox asked for, or the App to keep. Only the ID,
// slug and key are kept; the client and webhook secrets are never returned from here.
export function conversionProblem(raw: unknown, org: string, firstAppId: number, since: number): { why: string; made?: string } | Conversion {
  const a = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const slug = typeof a.slug === "string" && /^[a-z0-9-]{1,64}$/.test(a.slug) ? a.slug : undefined;
  const made = slug ? `the App ${slug}` : undefined;
  const no = (why: string) => ({ why, ...(made ? { made } : {}) });
  if (!Number.isInteger(a.id) || (a.id as number) <= 0 || !slug) return no("GitHub's answer has no App");
  if (a.id === firstAppId) return no("GitHub's answer names the box's own App, the runners'");
  const created = typeof a.created_at === "string" ? Date.parse(a.created_at) : NaN;
  // A minute's room for the two clocks.
  if (!Number.isFinite(created) || created < since - 60_000) return no("the App wasn't made by this run");
  const owner = (a.owner as { login?: unknown } | undefined)?.login;
  const type = (a.owner as { type?: unknown } | undefined)?.type;
  if (typeof owner !== "string" || owner.toLowerCase() !== org.toLowerCase() || type !== "Organization") {
    const who = typeof owner === "string" ? owner.replace(/[^\x20-\x7e]/g, "").slice(0, 40) : "no one";
    return no(`the App belongs to ${who}, and taskbox.json names ${org}`);
  }
  const p = (a.permissions ?? {}) as Record<string, unknown>;
  const keys = Object.keys(p);
  if (keys.length !== 2 || p.actions !== "read" || p.metadata !== "read") return no("the App has other rights than Actions read and Metadata read");
  if (Array.isArray(a.events) && a.events.length) return no("the App subscribes to events");
  if (typeof a.pem !== "string" || a.pem.length > 20_000) return no("GitHub's answer has no private key");
  try {
    createPrivateKey(a.pem);
  } catch {
    return no("GitHub's answer has no private key");
  }
  return { id: a.id as number, slug, pem: a.pem };
}
