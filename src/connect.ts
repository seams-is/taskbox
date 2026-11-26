// taskbox connect github: the pure parts. The two Apps' manifests, their names, the page that posts a
// manifest to GitHub, and the checks on what GitHub answers: the conversion, the webhook, and an
// installation. connectflow.ts runs the steps, listen.ts serves the page, and keys.ts holds the keys.
import { createPrivateKey } from "node:crypto";

export type AppRole = "runner" | "source";
export const ROLES: readonly AppRole[] = ["runner", "source"];

// Each App's rights, and nothing else. metadata read comes with every App.
// runner: JIT runners and the runner group (an org right), and reading the settings repo.
// source: the jobs repo's queue and logs. It never acts on GitHub.
export const PERMISSIONS = {
  runner: { organization_self_hosted_runners: "write", contents: "read", metadata: "read" },
  source: { actions: "read", metadata: "read" },
} as const satisfies Record<AppRole, Record<string, string>>;

export const ROLE_WORD: Record<AppRole, string> = { runner: "runners", source: "jobs" };
export const ROLE_NAME: Record<AppRole, string> = { runner: "the runner App", source: "the job source App" };

export type Manifest = {
  name: string;
  url: string;
  hook_attributes: { url: string; active: false };
  redirect_url: string;
  public: false;
  default_permissions: Record<string, string>;
  default_events: [];
};

const NAME_MAX = 34;
const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");

// <org>-<box>-runners-<4 hex> and <org>-<box>-jobs-<4 hex>, cut to 34 characters. App names are unique
// on all of GitHub and kept until an App is deleted, so the suffix is always there.
export function appName(org: string, box: string, role: AppRole, suffix: string): string {
  if (!/^[0-9a-f]{4}$/.test(suffix)) throw new Error("an App's suffix is 4 hex");
  const tail = `-${ROLE_WORD[role]}-${suffix}`;
  return `${clean(`${org}-${box}`).slice(0, NAME_MAX - tail.length).replace(/-$/, "")}${tail}`;
}

// The hook's address: inert, and off. GitHub wants one in a manifest.
export const inertHook = (org: string) => `https://github.com/${org}`;

export function manifestFor(role: AppRole, org: string, name: string, port: number): Manifest {
  if (!Number.isInteger(port) || port <= 0 || port >= 65536) throw new Error("not a port");
  return {
    name,
    url: `https://github.com/${org}`,
    hook_attributes: { url: inertHook(org), active: false },
    redirect_url: `http://127.0.0.1:${port}/done`,
    public: false,
    default_permissions: { ...PERMISSIONS[role] },
    default_events: [],
  };
}

const html = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// The org's page that makes an App from a manifest, with the state GitHub sends back.
export const newAppUrl = (org: string, state: string) => `https://github.com/organizations/${encodeURIComponent(org)}/settings/apps/new?state=${encodeURIComponent(state)}`;

// The one page: a form that posts the manifest to GitHub's org page, sent as soon as it loads.
export function startPage(org: string, state: string, m: Manifest, role: AppRole): string {
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8"><title>taskbox connect github</title></head>',
    "<body>",
    `<form id="f" method="post" action="${html(newAppUrl(org, state))}">`,
    `<input type="hidden" name="manifest" value="${html(JSON.stringify(m))}">`,
    `<p>taskbox is opening GitHub to make ${html(ROLE_NAME[role])}. If nothing happens, click the button.</p>`,
    '<button type="submit">Open GitHub</button>',
    "</form>",
    '<script>document.getElementById("f").submit()</script>',
    "</body></html>",
  ].join("\n");
}

// The headers every answer carries: nothing cached, no referrer, nothing framed, and the page may
// only post its one form to github.com and run its one line.
export function pageHeaders(): Record<string, string> {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'none'; form-action https://github.com; script-src 'unsafe-inline'; frame-ancestors 'none'",
  };
}

export const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const KEY_MAX = 20_000;
export const CODE = /^[A-Za-z0-9_-]{1,100}$/;

export type Conversion = { id: number; slug: string; pem: string };
export type Refused = { why: string; made?: string };

const sameRights = (got: unknown, want: Record<string, string>) => {
  if (!got || typeof got !== "object" || Array.isArray(got)) return false;
  const g = got as Record<string, unknown>;
  return Object.keys(g).length === Object.keys(want).length && Object.entries(want).every(([k, v]) => g[k] === v);
};

// A key GitHub made: a private key, under the size cap.
export function keyProblem(pem: unknown): string | undefined {
  if (typeof pem !== "string" || pem.length === 0 || pem.length > KEY_MAX) return "GitHub's answer has no private key";
  try {
    createPrivateKey(pem);
  } catch {
    return "GitHub's answer has no private key";
  }
  return undefined;
}

export const rightsWords = (role: AppRole) => (role === "runner" ? "Self-hosted runners write, Contents read and Metadata read" : "Actions read and Metadata read");

// Why GitHub's answer to a code isn't the App this op asked for, or the App to keep. Only the ID, slug
// and key are kept; the client and webhook secrets are never returned from here.
// since: when the op began. other: the other App's ID, which this one may never be.
export function conversionProblem(raw: unknown, o: { role: AppRole; org: string; since: number; other?: number }): Refused | Conversion {
  const a = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const slug = typeof a.slug === "string" && SLUG.test(a.slug) ? a.slug : undefined;
  const no = (why: string): Refused => ({ why, ...(slug ? { made: slug } : {}) });
  if (!Number.isSafeInteger(a.id) || (a.id as number) <= 0 || !slug) return no("GitHub's answer has no App");
  if (o.other !== undefined && a.id === o.other) return no("GitHub's answer names the box's other App");
  const created = typeof a.created_at === "string" ? Date.parse(a.created_at) : Number.NaN;
  // A minute's room for the two clocks.
  if (!Number.isFinite(created) || created < o.since - 60_000) return no("the App wasn't made by this connect");
  const owner = a.owner && typeof a.owner === "object" ? (a.owner as Record<string, unknown>) : {};
  if (typeof owner.login !== "string" || owner.login.toLowerCase() !== o.org.toLowerCase() || owner.type !== "Organization") {
    const who = typeof owner.login === "string" ? owner.login.replace(/[^\x20-\x7e]/g, "").slice(0, 40) : "no one";
    return no(`the App belongs to ${who}, and this box's org is ${o.org}`);
  }
  if (!sameRights(a.permissions, PERMISSIONS[o.role])) return no(`the App has other rights than ${rightsWords(o.role)}`);
  if (!Array.isArray(a.events) || a.events.length) return no("the App subscribes to events");
  if (a.public !== false) return no("the App is public");
  const k = keyProblem(a.pem);
  if (k) return no(k);
  return { id: a.id as number, slug, pem: a.pem as string };
}

// The App's webhook, as GET /app/hook/config answers with the App's JWT: no hook (404), an empty
// address, or the inert address the manifest set inactive. Anything else could send the App's events
// somewhere, so it is refused.
export function hookProblem(status: number, body: unknown, org: string): string | undefined {
  if (status === 404) return undefined;
  if (status !== 200) return `GitHub answered ${status} for the App's webhook`;
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const url = b.url;
  if (url === undefined || url === null || url === "" || url === inertHook(org)) return undefined;
  return "the App has a webhook";
}

// One installation as GET /app/installations lists it.
export type Installation = { id: number; account: string; accountType: string; selection: string; permissions: Record<string, unknown>; suspended: boolean };

export function installationsOf(raw: unknown): Installation[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: Installation[] = [];
  for (const i of raw) {
    if (!i || typeof i !== "object") return undefined;
    const r = i as Record<string, unknown>;
    const acc = (r.account && typeof r.account === "object" ? r.account : {}) as Record<string, unknown>;
    if (!Number.isSafeInteger(r.id) || (r.id as number) <= 0) return undefined;
    out.push({
      id: r.id as number,
      account: typeof acc.login === "string" ? acc.login : "",
      accountType: typeof r.target_type === "string" ? r.target_type : typeof acc.type === "string" ? acc.type : "",
      selection: typeof r.repository_selection === "string" ? r.repository_selection : "",
      permissions: r.permissions && typeof r.permissions === "object" && !Array.isArray(r.permissions) ? (r.permissions as Record<string, unknown>) : {},
      suspended: r.suspended_at !== undefined && r.suspended_at !== null,
    });
  }
  return out;
}

// What an installation must be: one, on the org, selected repositories, exactly these rights.
// grew: the App reaches more than it should, so its key is never used. waiting: not installed yet,
// or waiting for the owner's click.
export type InstallFail = { why: string; grew: boolean; waiting?: true };

export function installationProblem(list: Installation[], o: { role: AppRole; org: string }): InstallFail | Installation {
  if (list.length === 0) return { why: "the App isn't installed yet", grew: false, waiting: true };
  if (list.length !== 1) return { why: `the App is installed ${list.length} times; it may be installed once, on ${o.org}`, grew: true };
  const one = list[0]!;
  if (one.account.toLowerCase() !== o.org.toLowerCase() || (one.accountType !== "" && one.accountType !== "Organization")) {
    return { why: `the App is installed on ${one.account.replace(/[^\x20-\x7e]/g, "").slice(0, 40) || "an account"}, and this box's org is ${o.org}`, grew: true };
  }
  if (one.selection !== "selected") return { why: "the App is installed on All repositories. On its Configure page, choose Only select repositories", grew: true };
  if (one.suspended) return { why: "the App's installation is suspended", grew: false };
  const want: Record<string, string> = PERMISSIONS[o.role];
  if (!sameRights(one.permissions, want)) {
    const more = Object.keys(one.permissions).some((k) => want[k] !== one.permissions[k]);
    if (more) return { why: `the App's installation has other rights than ${rightsWords(o.role)}`, grew: true };
    return { why: `the App's installation lacks some of ${rightsWords(o.role)}: approve its new permissions on its Configure page`, grew: false, waiting: true };
  }
  return one;
}

// The repos an installation reaches, against what it must: every one of want, and nothing outside
// want and may. may: repos it may hold beside, such as the release repo a kept v2 install reads. A
// missing repo waits for the owner; an extra one is grown.
export function reposProblem(names: unknown[], want: readonly string[], may: readonly string[] = []): InstallFail | undefined {
  if (!names.every((n): n is string => typeof n === "string")) return { why: "GitHub's list of the App's repositories had no names", grew: false };
  const lower = (s: string) => s.toLowerCase();
  const got = new Set(names.map(lower));
  const allowed = new Set([...want, ...may].map(lower));
  const extra = names.filter((n) => !allowed.has(lower(n)));
  if (extra.length) return { why: `the App also reaches ${extra.slice(0, 3).map((n) => n.replace(/[^\x20-\x7e]/g, "").slice(0, 80)).join(", ")}. On its Configure page, leave only ${want.join(" and ")}`, grew: true };
  const missing = want.filter((w) => !got.has(lower(w)));
  if (missing.length) return { why: `the App isn't on ${missing.join(" and ")} yet. On its Configure page, under Only select repositories, add it`, grew: false, waiting: true };
  return undefined;
}

// The pages the owner is sent to.
export const appPage = (org: string, slug: string) => `https://github.com/organizations/${org}/settings/apps/${slug}`;
export const installPage = (slug: string) => `https://github.com/apps/${slug}/installations/new`;
export const permissionsPage = (org: string, slug: string) => `${appPage(org, slug)}/permissions`;
export const deleteLine = (org: string, slug: string) => `GitHub keeps the App ${slug} until you delete it: ${appPage(org, slug)}/advanced, Delete GitHub App.`;
