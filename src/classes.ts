// Priority classes (v2.4.0, docs/scheduling-design.md section 2). The owner's rules rank waiting
// jobs. The first rule that matches wins, and a job no rule matches is in the last class, jobs.
// An event matches only when the source vouches for it: a label comes from the workflow, which a
// pull request can change in its own copy, so a label alone never matches a rule that names events.
import type { ClassRule, LabelMatch } from "./config.ts";
import type { WaitingItem } from "./source.ts";

export const LAST_CLASS = "jobs";

function labelMatches(m: LabelMatch, labels: string[]): boolean {
  return labels.some((l) => (m.equals !== undefined && l === m.equals) || (m.startsWith !== undefined && l.startsWith(m.startsWith)) || (m.endsWith !== undefined && l.endsWith(m.endsWith)));
}

// The item's class: its rank (0 is first) and name. Rules run in order; the last class is rules.length.
export function classOf(item: WaitingItem, rules: ClassRule[]): { rank: number; name: string } {
  for (const [i, r] of rules.entries()) {
    const ev = r.when.event;
    if (ev && !(item.origin.trusted && item.origin.event !== undefined && ev.includes(item.origin.event))) continue;
    if (r.when.label && !labelMatches(r.when.label, item.labels)) continue;
    return { rank: i, name: r.name };
  }
  return { rank: rules.length, name: LAST_CLASS };
}

// The items in the order the box serves them: the best class first, then the oldest, then by key so
// the order never depends on how the source listed them.
export function ranked(items: WaitingItem[], rules: ClassRule[]): (WaitingItem & { rank: number; className: string })[] {
  return items
    .map((it) => {
      const c = classOf(it, rules);
      return { ...it, rank: c.rank, className: c.name };
    })
    .sort((a, b) => a.rank - b.rank || a.queuedAt - b.queuedAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

// What taskbox check says about rules a source can never match: a rule that names events, with a
// source that reports none.
export function rulesNeedingEvents(rules: ClassRule[]): string[] {
  return rules.filter((r) => r.when.event?.length).map((r) => r.name);
}
