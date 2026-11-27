// The command registry against the v3.0.0 design's command tables (sections 2.4 and 2.5): every
// command and every flag the tables name, and nothing else a person can type. A gap known today is
// listed below with what it is; a new gap fails, and so does a closed one still
// listed, so the list only shrinks.
import { describe, expect, test } from "bun:test";
import { GLOBAL_FLAGS, type CommandSpec } from "../src/command.ts";
import { CONTROLLER } from "../src/controller/main.ts";
import { registry } from "../src/registry.ts";

// Each row: the command's path, then its flags by their long names. "-" for none.
const BOX = `
status | --watch --json
logs | --follow --since --until --tail --from --grep --json
events | --follow --since --until --type --op --subject --json
check | --away --json
logins | --all --refused --since --json
settings show | --pending --origin --json
pause | --reason --json
drain | --timeout --force --detach --reason --json
resume | --json
stop | --timeout --force --detach --yes --json
start | --json
update | --check --to --repair --timeout --force --detach --yes --dry-run --json
rollback | --to --timeout --force --detach --yes --json
release list | --all --json
release show | --json
settings apply | --json
confirm | --refuse --json
withdraw | --json
settings repo | --json
op list | --state --type --since --json
op show | --watch --json
op cancel | --yes --json
job list | --state --kind --size --class --result --since --tail --all --watch --json
job show | --net --watch --json
job logs | --follow --tail --json
job cancel | --yes --json
job timings | --kind --json
workspace request | --as --size --why --json
workspace list | --state --watch --json
workspace status | --watch --json
workspace wait | --for --timeout --json
workspace connect | --screen
workspace progress | --step --can-pause --busy --saved --downsized --json
workspace end | --force --json
workspace approve | --size --json
workspace deny | --reason --json
workspace pause | --to --now --yes --json
workspace resume | --json
workspace jump | --json
workspace rush | --force --json
workspace rule add | --agent --size --window --expires --json
workspace rule list | --json
workspace rule delete | --json
workspace clear | --yes --json
size list | --json
tool list | --json
tool refresh | --timeout --detach --json
image list | --json
image pull | --timeout --detach --json
selftest run | --release --timeout --detach --json
selftest list | --tail --json
connect github | --jobs --load --group --timeout --detach --json
connect status | --json
disconnect github | --yes --json
policy show | --owner --admin --whole --json
key list | --json
key rotate | --timeout --detach --json
key trust approver | --yes --json
key reset approver | --yes --json
key trust release | --yes --json
load status | --watch --json
load start | --pattern --only --for --yes --detach --json
load stop | --json
load report | --session --json
template list | --json
template show | -
prune | --dry-run --yes --json
remove | --yes --keep-images --detach --json
unlock | -
`;

const ON_CONTROLLER = `
box add | --agent --yes --json
box list | --json
box show | --json
box use | -
box remove | --yes --json
box install | --settings --json
self update | --check --to --json
self rollback | --json
self check | --fix --json
self setup | --json
self events | --follow --since --json
self trials | --json
agent shell | -
statusline | -
template apply | --json
`;

// Flags that carry a step between taskbox's own parts, never typed by a person: the signed
// statement, the agent's claim key and its proof.
const PLUMBING = new Set(["--signed", "--claim", "--proof"]);

// Gaps known today, each under a line saying what it is.
const GAPS = [
  // logs takes --json only.
  "logs: missing --follow", "logs: missing --since", "logs: missing --until", "logs: missing --tail", "logs: missing --from", "logs: missing --grep",
  // logins.
  "logins: missing --refused", "logins: missing --since",
  // prune, remove, connect github and disconnect github lack the global flags.
  "prune: missing --dry-run", "prune: missing --yes", "prune: missing --json",
  "remove: missing --yes", "remove: missing --detach", "remove: missing --json",
  "connect github: missing --timeout", "connect github: missing --detach",
  "disconnect github: missing --yes", "disconnect github: missing --json",
  // policy show names the login --login.
  "policy show: missing --owner", "policy show: extra --login",
  // Test hooks and plumbing a person can type today.
  "status: extra --state", "load report: extra --replay", "key add: extra command", "workspace rule add: extra --key",
  // Keys builder (taskbox/v3-keys-wiring): key trust release, and key rotate's own words.
  "key trust release: missing command", "key rotate: extra --state", "key rotate: extra --seal", "key rotate: extra --new",
  // Small differences from the table, each its own fix.
  "op show: extra --timeout", "job timings: missing --kind", "workspace connect: extra --json", "workspace rush: extra --yes", "template show: extra --json",
  // Controller rows.
  "box add: missing --json", "box add: extra --jobs-repo", "box remove: missing --yes", "box remove: missing --json",
  "self update: extra --auto", "self rollback: missing --json", "self setup: missing --json", "self events: missing --follow", "sign: extra command",
];

function table(text: string): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  for (const row of text.trim().split("\n")) {
    const [path, flags] = row.split(" | ");
    m.set(path!.trim(), new Set(flags!.trim() === "-" ? [] : flags!.trim().split(/\s+/)));
  }
  return m;
}

function shown(specs: readonly CommandSpec[]): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  for (const s of specs) {
    if (s.internal) continue;
    const flags = [...(s.flags ?? []).map((g) => GLOBAL_FLAGS[g].names.at(-1)!), ...(s.options ?? []).map((o) => o.name)].filter((f) => !PLUMBING.has(f) && f !== "--box");
    m.set(s.path.join(" "), new Set(flags));
  }
  return m;
}

function gaps(want: Map<string, Set<string>>, have: Map<string, Set<string>>): string[] {
  const out: string[] = [];
  for (const [path, flags] of want) {
    const h = have.get(path);
    if (!h) {
      out.push(`${path}: missing command`);
      continue;
    }
    for (const f of flags) if (!h.has(f)) out.push(`${path}: missing ${f}`);
    for (const f of h) if (!flags.has(f)) out.push(`${path}: extra ${f}`);
  }
  for (const path of have.keys()) if (!want.has(path)) out.push(`${path}: extra command`);
  return out;
}

describe("the registry against the spec's command tables", () => {
  const box = table(BOX);
  const ctl = table(ON_CONTROLLER);

  test("every box command and flag, and nothing more, but the gaps listed", () => {
    // template apply is the controller's, though the spec lists it among the box's templates.
    const all = new Map([...box, ...ctl]);
    const have = new Map([...shown(registry()), ...shown(CONTROLLER)]);
    expect(gaps(all, have).sort()).toEqual([...GAPS].sort());
  });

  test("the comparison fails on a missing or extra command or flag", () => {
    const want = table("a | --json\nb c | --yes");
    expect(gaps(want, new Map([["a", new Set(["--json"])], ["b c", new Set(["--yes"])]]))).toEqual([]);
    expect(gaps(want, new Map([["a", new Set(["--json", "--watch"])]]))).toEqual(["a: extra --watch", "b c: missing command"]);
    expect(gaps(want, new Map([["a", new Set()], ["b c", new Set(["--yes"])], ["d", new Set()]]))).toEqual(["a: missing --json", "d: extra command"]);
  });

  test("no gap is listed twice, and each names a command", () => {
    expect(new Set(GAPS).size).toBe(GAPS.length);
    for (const g of GAPS) expect(g).toMatch(/^[a-z][a-z ]*: (missing|extra) (command|--[a-z-]+)$/);
  });
});
