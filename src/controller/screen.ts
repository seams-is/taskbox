// The screen, bare taskbox at a terminal: every box's status, drawn again every 3 s, one box picked
// with the arrow keys. p pauses it, x drains it, r resumes it, each signed through forward.ts as the
// command line signs it; d stays for deny, once workspace cards come. q or Ctrl-C quits. With no
// terminal it is status -w --box all.
import { EXIT } from "../command.ts";
import { answers, forward, type ForwardIo, readLine, show, WATCH_MS } from "./forward.ts";
import { type Deps, isStop } from "./reach.ts";

export const KEYS: Record<string, string[]> = { p: ["pause"], x: ["drain"], r: ["resume"] };
export const HELP = "Up and down pick a box. p pause, x drain, r resume, each signed with Touch ID. q quits.";
// Where the agents' work is: their folder is theirs alone.
export const WORK = "Your agents' work reaches you as PRs: review and merge them, and work in your own clones.";
const UP = "\x1b[A";
const DOWN = "\x1b[B";

export interface ScreenIo extends ForwardIo {
  keys?: AsyncIterator<string>; // one key press each; absent with no terminal
}

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
  let pick = 0;
  let said = "";
  let pending: Promise<IteratorResult<string>> | undefined;
  let last: string[] = [];
  for (let i = 0; i < (io.rounds ?? Infinity); i++) {
    const list = await answers(d, a);
    if (isStop(list)) {
      if (list.done) {
        io.out(list.stop);
        return EXIT.failed;
      }
      io.draw([list.stop, "", HELP, WORK]);
    } else {
      pick = Math.min(pick, list.length - 1);
      const blocks = list.map((o, n) => {
        const s = show(d, a, [o]);
        return [`${n === pick ? ">" : " "} ${o.box.name}`, ...s.lines.map((l) => `    ${l}`)];
      });
      last = [...blocks.flat(), "", ...(said ? [said, ""] : []), HELP, WORK];
      io.draw(last);
    }
    // A key, or the next round after 3 s.
    pending ??= keys.next();
    const k = await Promise.race([pending, d.sleep(WATCH_MS).then(() => undefined)]);
    if (!k) continue;
    pending = undefined;
    if (k.done || k.value === "q" || k.value === "\x03") return EXIT.ok;
    const boxes = isStop(list) ? [] : list;
    if (k.value === UP) pick = Math.max(0, pick - 1);
    else if (k.value === DOWN) pick = Math.min(boxes.length - 1, pick + 1);
    else if (KEYS[k.value] && boxes[pick]) {
      const out: string[] = [];
      // What the signer says (the statement in words, then Touch ID) stays on the screen while it waits.
      const signing: string[] = [];
      const shown = { ...d, out: (l: string) => (signing.push(l), io.draw([...last, "", ...signing])) };
      const code = await forward(shown, [...KEYS[k.value]!, "--box", boxes[pick]!.box.name], { out: (l) => out.push(l), draw: () => {} });
      said = `${KEYS[k.value]!.join(" ")} ${boxes[pick]!.box.name}: ${code === 0 ? "done" : "not done"}. ${out.filter((l) => !/^(Now|Did|Next):/.test(l)).slice(-1)[0] ?? ""}`.trim();
    }
  }
  return EXIT.ok;
}
