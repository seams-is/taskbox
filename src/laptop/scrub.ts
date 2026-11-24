// Text from the box is data. Before any of it reaches the laptop's terminal or
// Claude, control characters (C0 and C1), format characters, bidirectional controls, tag characters
// and line or paragraph separators are taken out, spaces are squeezed, and the line is cut short.
// Format characters (Cf) include the bidirectional controls, the zero-width ones and the tag block.
const UNSAFE = new RegExp("[\\p{Cc}\\p{Cf}\\u2028\\u2029\\uFFF9-\\uFFFB\\uD800-\\uDFFF]+", "gu");

export function scrub(v: unknown, max = 200): string {
  if (typeof v !== "string") return "";
  return v.replace(UNSAFE, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

// Many lines, each scrubbed, with at most `lines` of them.
export function scrubLines(v: string, max = 200, lines = 20): string[] {
  return v
    .split(/\r?\n|\r/)
    .map((l) => scrub(l, max))
    .filter((l) => l !== "")
    .slice(0, lines);
}
