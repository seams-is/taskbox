// The box side of v3.0.0's last security review: each finding's fix, proved here where no other
// file's harness fits it.
import { describe, expect, test } from "bun:test";
import { showAll } from "../src/cmd/confirm.ts";

describe("confirm shows every line", () => {
  test("a long change is paged, and the yes comes only after its last line", async () => {
    const said: string[] = [];
    const asked: string[] = [];
    const c = { say: (l: string) => void said.push(l), ask: async (q: string) => (asked.push(q), "") } as never;
    const lines = Array.from({ length: 45 }, (_, i) => `line ${i}`);
    await showAll(c, lines, true);
    expect(said).toEqual(lines.map((l) => `  ${l}`));
    expect(asked).toEqual(["  (25 more lines of this change. Press return to see them.) ", "  (5 more lines of this change. Press return to see them.) "]);
  });
});

describe("a workspaces state started again after a torn one", () => {
  test("every pool account is cleared before its next agent, and ids go on past the lost ones", async () => {
    const { afterReset } = await import("../src/workspace/pass.ts");
    const { assign, emptyState } = await import("../src/workspace/model.ts");
    const { approved, asked, POOL, T } = await import("./ws-helpers.ts");
    const s = afterReset(emptyState(), POOL, T);
    expect(s.nameSeq).toBeGreaterThan(1000);
    const a = asked(s, "nova", "light");
    const name = a.workspaces[0]!.name;
    expect(Number(name.split("-")[1])).toBe(s.nameSeq + 1);
    const got = assign(approved(a, name, "light"), POOL, T).state.workspaces[0]!;
    expect(got.clear).toBe(true);
  });
});
