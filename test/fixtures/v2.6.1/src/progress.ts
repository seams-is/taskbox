// v2.6.1's src/progress.ts at c7d2414, cut to what hop() runs. Each part below is that file's own text, unchanged, unless marked New.

// Control characters (C0, DEL, C1) are dropped from anything shown, so job names and Tart's
// messages can't move the cursor or change the terminal. So are Unicode's format and line
// characters: bidi overrides, zero-width marks and line or paragraph separators, which could
// reorder or split a line.
export const clean = (s: unknown): string => (typeof s === "string" || typeof s === "number" ? String(s) : "").replace(/[\x00-\x1f\x7f-\x9f]|[\p{Cf}\p{Zl}\p{Zp}]/gu, "");
