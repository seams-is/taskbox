// The owner's screen, bare taskbox at a terminal: every box's status, drawn again every 3 s, one box
// picked with the arrow keys. p pauses it, d drains it, r resumes it, each signed through forward.ts
// as the command line signs it. q or Ctrl-C quits. With no terminal it is status -w --box all.
import { EXIT } from "../command.ts";
import { answers, forward, type ForwardIo, readLine, show, WATCH_MS } from "./forward.ts";
import { type Deps, isStop } from "./reach.ts";

export const KEYS: Record<string, string[]> = { p: ["pause"], d: ["drain"], r: ["resume"] };
export const HELP = "Up and down pick a box. p pause, d drain, r resume, each signed with Touch ID. q quits.";
const UP = "\x1b[A";
const DOWN = "\x1b[B";

export interface ScreenIo extends ForwardIo {
  keys?: AsyncIterator<string>; // one key press each; absent with no terminal
}

export async function ownerScreen(d: Deps, io: ScreenIo): Promise<number> {
  if (!io.keys) return forward(d, ["status", "-w", "--box", "all"], io);
  const a = readLine(d, ["status", "--box", "all"]);
  if ("shown" in a) return forward(d, ["status", "-w", "--box", "all"], io);
  let pick = 0;
  let said = "";
  let pending: Promise<IteratorResult<string>> | undefined;
  for (let i = 0; i < (io.rounds ?? Infinity); i++) {
    const list = await answers(d, a);
    if (isStop(list)) {
      if (list.done) {
        io.out(list.stop);
        return EXIT.failed;
      }
      io.draw([list.stop, "", HELP]);
    } else {
      pick = Math.min(pick, list.length - 1);
      const blocks = list.map((o, n) => {
        const s = show(d, a, [o]);
        return [`${n === pick ? ">" : " "} ${o.box.name}`, ...s.lines.map((l) => `    ${l}`)];
      });
      io.draw([...blocks.flat(), "", ...(said ? [said, ""] : []), HELP]);
    }
    // A key, or the next round after 3 s.
    pending ??= io.keys.next();
    const k = await Promise.race([pending, d.sleep(WATCH_MS).then(() => undefined)]);
    if (!k) continue;
    pending = undefined;
    if (k.done || k.value === "q" || k.value === "\x03") return EXIT.ok;
    const boxes = isStop(list) ? [] : list;
    if (k.value === UP) pick = Math.max(0, pick - 1);
    else if (k.value === DOWN) pick = Math.min(boxes.length - 1, pick + 1);
    else if (KEYS[k.value] && boxes[pick]) {
      const out: string[] = [];
      const code = await forward(d, [...KEYS[k.value]!, "--box", boxes[pick]!.box.name], { out: (l) => out.push(l), draw: () => {} });
      said = `${KEYS[k.value]!.join(" ")} ${boxes[pick]!.box.name}: ${code === 0 ? "done" : "not done"}. ${out.filter((l) => !/^(Now|Did|Next):/.test(l)).slice(-1)[0] ?? ""}`.trim();
    }
  }
  return EXIT.ok;
}
