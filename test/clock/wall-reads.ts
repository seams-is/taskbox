import { readFileSync } from "node:fs";

// wall-reads.jsonl: one file of src per line, sorted by file, so two branches adding reads never
// touch one line.
export const WALL_READS_LINES = readFileSync(new URL("./wall-reads.jsonl", import.meta.url), "utf8").trimEnd().split("\n");
export const wallReads = (): Record<string, { reads: number; why: string }> =>
  Object.fromEntries(
    WALL_READS_LINES.map((l) => {
      const { file, ...a } = JSON.parse(l) as { file: string; reads: number; why: string };
      return [file, a];
    }),
  );
