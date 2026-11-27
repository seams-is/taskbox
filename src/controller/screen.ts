// The screen, bare taskbox at a terminal: every box's status and a card for each of its workspaces,
// drawn again every 3 s. Up and down pick a box or a card, and each key acts on what is picked,
// signed through forward.ts as the command line signs it. q or Ctrl-C quits. With no terminal it is
// status -w --box all.
import { EXIT } from "../command.ts";
import { cleanLine } from "../envelope.ts";
import { SIZES, STATES } from "../workspace/model.ts";
import { answers, forward, type ForwardIo, type One, readLine, show, WATCH_MS } from "./forward.ts";
import { type Deps, isStop } from "./reach.ts";

// A box takes p pause, x drain, r resume. A card takes a approve, d deny, p pause, r resume, e end.
export const BOX_KEYS: Record<string, string[]> = { p: ["pause"], x: ["drain"], r: ["resume"] };
export const CARD_KEYS: Record<string, string[]> = { a: ["workspace", "approve"], d: ["workspace", "deny"], p: ["workspace", "pause"], r: ["workspace", "resume"], e: ["workspace", "end"] };
export const KEYS = BOX_KEYS;
export const HELP = "Up and down pick a box or a card. A box: p pause, x drain, r resume. A card: a approve, d deny, p pause, r resume, e end. Each but deny is signed with Touch ID. q quits.";
// Where the agents' work is: their folder is theirs alone.
export const WORK = "Your agents' work reaches you as PRs: review and merge them, and work in your own clones.";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
// Cards of workspaces that are over are left off.
const OVER = new Set(["denied", "expired", "withdrawn", "ended", "failed"]);

export interface ScreenIo extends ForwardIo {
  keys?: AsyncIterator<string>; // one key press each; absent with no terminal
}

export interface Card {
  box: string;
  id: string;
  agent: string;
  state: string;
  size: string;
  expires: string | null;
  why: string; // the agent's own words: shown cleaned and cut, as its words
}

// The cards a box's workspace list gives, read field by field: an id, a state and a size from their
// closed lists, or the card is left off.
export function cardsOf(box: string, result: Record<string, unknown> | null | undefined): Card[] {
  const list = Array.isArray(result?.workspaces) ? (result!.workspaces as unknown[]) : [];
  const out: Card[] = [];
  for (const v of list.slice(0, 50)) {
    if (!v || typeof v !== "object") continue;
    const w = v as Record<string, unknown>;
    if (typeof w.id !== "string" || !/^[a-z][a-z0-9]{0,15}-[1-9][0-9]{0,8}$/.test(w.id)) continue;
    if (!(STATES as readonly unknown[]).includes(w.state) || !(SIZES as readonly unknown[]).includes(w.size) || OVER.has(w.state as string)) continue;
    out.push({ box, id: w.id, agent: typeof w.agent === "string" ? cleanLine(w.agent).slice(0, 16) : "", state: w.state as string, size: w.size as string, expires: typeof w.expires === "string" && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(w.expires) ? w.expires : null, why: typeof w.why === "string" ? cleanLine(w.why).slice(0, 60) : "" });
  }
  return out;
}

const cardLine = (c: Card) => `[${c.id}] ${c.state}, ${c.size[0]!.toUpperCase()}${c.size.slice(1)}, agent ${c.agent}${c.expires ? `, expires ${c.expires.slice(11, 16)} UTC` : ""}${c.why ? `: "${c.why}"` : ""}`;

type Item = { kind: "box"; box: string } | { kind: "card"; card: Card };

export async function ownerScreen(d: Deps, io: ScreenIo): Promise<number> {
  if (!io.keys) return forward(d, ["status", "-w", "--box", "all"], io);
  try {
    return await screen(d, io, io.keys);
  } finally {
    // Raw mode ends with the screen.
    await io.keys.return?.();
  }
}

async function screen(d: Deps, io: ScreenIo, keys: AsyncIterator<string>): Promise<number> {
  const a = readLine(d, ["status", "--box", "all"]);
  if ("shown" in a) return forward(d, ["status", "-w", "--box", "all"], io);
  const ws = readLine(d, ["workspace", "list", "--box", "all"]);
  let pick = 0;
  let said = "";
  let pending: Promise<IteratorResult<string>> | undefined;
  let last: string[] = [];
  let items: Item[] = [];
  for (let i = 0; i < (io.rounds ?? Infinity); i++) {
    const list = await answers(d, a);
    if (isStop(list)) {
      if (list.done) {
        io.out(list.stop);
        return EXIT.failed;
      }
      items = [];
      io.draw([list.stop, "", HELP, WORK]);
    } else {
      // Each box's workspaces, read alongside; a box that has none, or no workspace list, has no cards.
      const wl = "shown" in ws ? [] : await answers(d, ws);
      const cards = (o: One) => (isStop(wl) ? [] : cardsOf(o.box.name, wl.find((x) => x.box.node === o.box.node)?.envelopes?.at(-1)?.result));
      items = [];
      const lines: string[] = [];
      for (const o of list) {
        items.push({ kind: "box", box: o.box.name });
        lines.push(`${items.length - 1 === pick ? ">" : " "} ${o.box.name}`, ...show(d, a, [o]).lines.map((l) => `    ${l}`));
        for (const c of cards(o)) {
          items.push({ kind: "card", card: c });
          lines.push(`${items.length - 1 === pick ? ">" : " "}   ${cardLine(c)}`);
        }
      }
      pick = Math.min(pick, items.length - 1);
      last = [...lines, "", ...(said ? [said, ""] : []), HELP, WORK];
      io.draw(last);
    }
    // A key, or the next round after 3 s.
    pending ??= keys.next();
    const k = await Promise.race([pending, d.sleep(WATCH_MS).then(() => undefined)]);
    if (!k) continue;
    pending = undefined;
    if (k.done || k.value === "q" || k.value === "\x03") return EXIT.ok;
    if (k.value === UP) pick = Math.max(0, pick - 1);
    else if (k.value === DOWN) pick = Math.min(items.length - 1, pick + 1);
    else {
      const it = items[pick];
      const argv = !it ? undefined : it.kind === "box" ? (BOX_KEYS[k.value] ? [...BOX_KEYS[k.value]!, "--box", it.box] : undefined) : CARD_KEYS[k.value] ? [...CARD_KEYS[k.value]!, it.card.id, "--box", it.card.box] : undefined;
      if (!argv) continue;
      const out: string[] = [];
      // What the signer says (the statement in words, then Touch ID) stays on the screen while it waits.
      const signing: string[] = [];
      const shown = { ...d, out: (l: string) => (signing.push(l), io.draw([...last, "", ...signing])) };
      const code = await forward(shown, argv, { out: (l) => out.push(l), draw: () => {} });
      const what = argv.slice(0, argv.indexOf("--box")).join(" ");
      said = `${what} on ${argv.at(-1)}: ${code === 0 ? "done" : "not done"}. ${out.filter((l) => !/^(Now|Did|Next):/.test(l)).slice(-1)[0] ?? ""}`.trim();
    }
  }
  return EXIT.ok;
}
