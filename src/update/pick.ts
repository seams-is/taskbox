// Which release an update takes, from the public repo's list, pure. Everything in
// the list is untrusted until the statement it names is verified: this only chooses which one to
// download and check.
// - stable sees stable releases only; beta sees every release, in semver order (rule 11);
// - --to takes exactly that version, which must be listed, on the box's channel, and newer (or the
//   same with --repair). It passes over bad marks and the hold after a rollback;
// - otherwise the newest on the channel, newer than the installed one, not marked bad, and past the
//   hold after a rollback. Auto-update also waits delayHours after a release is published.
import { bare, channelOf, type Channel, compareVersions, onChannel, parseVersion, tagOf } from "../release.ts";
import { isBad, type Marks } from "./records.ts";

export interface Listed {
  version: string;
  publishedAt: number; // ms since 1970
}

// The list GitHub's API gives (releases?per_page=100), as far as it can be read: published releases
// whose tag is a version and whose prerelease flag agrees with it. Anything else is passed over.
export function listedReleases(v: unknown): Listed[] {
  if (!Array.isArray(v)) return [];
  const out: Listed[] = [];
  for (const r of v.slice(0, 200) as Record<string, unknown>[]) {
    if (!r || typeof r !== "object" || r.draft !== false || typeof r.tag_name !== "string") continue;
    const version = bare(r.tag_name);
    if (!parseVersion(version) || r.tag_name !== tagOf(version) || r.prerelease !== (channelOf(version) === "beta")) continue;
    const at = typeof r.published_at === "string" ? Date.parse(r.published_at) : NaN;
    if (!Number.isFinite(at)) continue;
    out.push({ version, publishedAt: at });
  }
  return out.sort((a, b) => compareVersions(b.version, a.version));
}

export type Picked = { kind: "take"; version: string } | { kind: "none"; why: string } | { kind: "refuse"; why: string };

export interface PickInput {
  listed: Listed[];
  installed: string;
  channel: Channel;
  marks: Marks;
  to?: string;
  repair?: boolean;
  auto?: { now: number; delayHours: number };
}

export function pick(o: PickInput): Picked {
  const inst = bare(o.installed);
  if (o.to !== undefined) {
    const to = bare(o.to);
    if (!parseVersion(to)) return { kind: "refuse", why: `${to} isn't a release version` };
    if (!o.listed.some((l) => l.version === to)) return { kind: "refuse", why: `the public repo has no published release ${to}` };
    if (!onChannel(to, o.channel)) return { kind: "refuse", why: `${to} is a beta release, and this box is on stable` };
    const c = compareVersions(to, inst);
    if (c < 0) return { kind: "refuse", why: `${to} is older than the installed ${inst}. taskbox rollback --to goes back to a kept install` };
    if (c === 0 && !o.repair) return { kind: "refuse", why: `${to} is installed already. taskbox update --repair installs it again` };
    return { kind: "take", version: to };
  }
  if (o.repair) return o.listed.some((l) => l.version === inst) ? { kind: "take", version: inst } : { kind: "refuse", why: `the public repo no longer lists ${inst}, so it can't be repaired` };
  const held = o.marks.heldBelow;
  for (const l of o.listed) {
    if (!onChannel(l.version, o.channel) || compareVersions(l.version, inst) <= 0) continue;
    if (isBad(o.marks, l.version)) continue;
    if (held && compareVersions(l.version, held) <= 0) continue;
    if (o.auto && o.auto.now - l.publishedAt < o.auto.delayHours * 3_600_000) continue;
    return { kind: "take", version: l.version };
  }
  const why = held && compareVersions(held, inst) > 0 ? `${inst} is held after the rollback from ${held}, until a newer release` : `${inst} is the newest release on ${o.channel}`;
  return { kind: "none", why };
}
