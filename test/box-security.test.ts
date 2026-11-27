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

describe("the owner's own Whole, through the model", () => {
  test("it starts as a Whole, goes ready with no pool account, reads back, and its activity keeps the quiet rule away", async () => {
    const { ownWhole, ready, seen, start, tick, onBoot, emptyState, find, quietFor } = await import("../src/workspace/model.ts");
    const { parseState, stateText } = await import("../src/workspace/store.ts");
    const { RULES, T, BOOT1, BOOT2, OWNER } = await import("./ws-helpers.ts");
    const a = ownWhole(emptyState(), { user: "person1", why: "Unreal", by: OWNER }, RULES, T);
    if (!a.ok) throw new Error(a.why);
    const s1 = start(a.state, RULES, T).state;
    expect(find(s1, "owner-1")).toMatchObject({ state: "starting", hold: { memoryMB: RULES.budget.memoryMB } });
    const r = ready(s1, "owner-1", BOOT1, T + 1000);
    if (!r.ok) throw new Error(r.why);
    expect(parseState(stateText(r.state))).toMatchObject({ kind: "ok", state: { workspaces: [{ name: "owner-1", own: true, user: "person1" }] } });
    // In use at the screen: the quiet rule sees it as the agent's word.
    const later = T + RULES.quietMs - 1000;
    const used = seen(r.state, "owner-1", "Screen Sharing connected", later);
    expect(quietFor(find(used, "owner-1")!, later + 2000)).toBeLessThan(RULES.quietMs);
    expect(find(tick(used, RULES, later + 2000).state, "owner-1")!.state).toBe("ready");
    // Unused for the quiet time: it saves and gives CI back, as an agent's does.
    expect(find(tick(r.state, RULES, T + RULES.quietMs + 2000).state, "owner-1")!.state).toBe("saving");
    // A power cut keeps the restart's words.
    expect(find(onBoot(r.state, BOOT2, T + 5000).state, "owner-1")).toMatchObject({ state: "paused", pausedBy: "restart" });
  });
  test("its activity: Screen Sharing connected, or the account busy", async () => {
    const { ownActivity } = await import("../src/workspace/pass.ts");
    const { FakeSys } = await import("./fake.ts");
    const sys = new FakeSys();
    let net = "";
    let cpu = "0.0\n";
    sys.responders.push((cmd) => (cmd === "/usr/sbin/netstat" ? { code: 0, stdout: net, stderr: "" } : cmd === "/bin/ps" ? { code: 0, stdout: cpu, stderr: "" } : undefined));
    expect(await ownActivity(sys, "person1")).toBeUndefined();
    cpu = "35.0\n8.0\n";
    expect(await ownActivity(sys, "person1")).toBe("busy, 43% CPU");
    net = "tcp4  0  0  100.64.0.2.5900  100.64.0.9.51234  ESTABLISHED\n";
    expect(await ownActivity(sys, "person1")).toBe("Screen Sharing connected");
  });
});
