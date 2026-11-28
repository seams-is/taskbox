// The controller's side of key rotate tailscale, runner and source: what it signs, what it reads
// back from the box, and what it opens in the browser.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { type BoxLink, rotateAppKey, rotateTailscale } from "../src/controller/keys.ts";
import { parseStatement, splitSigned } from "../src/core/statement.ts";
import { seal } from "../src/tsrotate.ts";
import { FakeSys } from "./fake.ts";

const OP = "op_01JD8Q4ZZZZZZZZZZZZZZZZZZZ";
const sys = new FakeSys();
const deps = (said: string[]) => ({ signer: async () => ({ ok: true as const, signature: "sig" }), say: (l: string) => said.push(l), now: () => sys.now(), sleep: (ms: number) => sys.sleep(ms) });
const argsOfLine = (words: string[]) => parseStatement(splitSigned(words[words.indexOf("--signed") + 1]!)!.statement)!.args;

describe("key rotate tailscale from the controller", () => {
  test("the box answers with the op at once; its sealed link, through op show, opens with this request's key alone, and the browser gets it", async () => {
    let signedArgs: Record<string, unknown> = {};
    let polls = 0;
    const box: BoxLink = {
      name: "box-a",
      installId: "a".repeat(32),
      async run(words) {
        if (words[0] === "nonce") return { exit: 0, result: { nonce: "0".repeat(32) } };
        // The box drains first: the link comes at the second look.
        if (words[0] === "op") return { exit: 0, result: { op: { id: OP, state: "running", phase: "drafting" }, ...(++polls > 1 ? { sealed: seal(signedArgs.seal as string, OP, "https://login.tailscale.com/a/abcdef123") } : {}) } };
        signedArgs = argsOfLine(words);
        return { exit: 0, result: { op: OP, said: "The Tailscale rotation started." } };
      },
    };
    const opened: string[] = [];
    const said: string[] = [];
    const r = await rotateTailscale({ ...deps(said), box, open: (u) => opened.push(u) });
    expect("why" in r).toBe(false);
    expect(Object.keys(signedArgs).sort()).toEqual(["seal", "words"]);
    expect(opened).toEqual(["https://login.tailscale.com/a/abcdef123"]);
    expect(said.join("\n")).not.toContain("login.tailscale.com");
  });
});

describe("key rotate runner from the controller", () => {
  test("signs only the state's hash, makes the App when the op asks, and gives the box the code with the state", async () => {
    let hash = "";
    const sent: string[][] = [];
    let polls = 0;
    const box: BoxLink = {
      name: "box-a",
      installId: "a".repeat(32),
      async run(words) {
        if (words[0] === "nonce") return { exit: 0, result: { nonce: "0".repeat(32) } };
        if (words.includes("--signed")) {
          hash = argsOfLine(words).state as string;
          return { exit: 0, result: { op: OP } };
        }
        if (words[0] === "op") {
          polls++;
          const state = sent.length ? (polls > 3 ? "succeeded" : "running") : "running";
          return { exit: 0, result: { op: { state, progress: { text: sent.length ? `open https://github.com/apps/x/installations/new` : "make runner example-org-box-a-runners-1f2e" } } } };
        }
        sent.push(words);
        return { exit: 0, result: {} };
      },
    };
    const made: string[] = [];
    const opened: string[] = [];
    const ok = await rotateAppKey({ ...deps([]), box, role: "runner", make: async (_r, name, state) => (made.push(`${name} ${createHash("sha256").update(state).digest("hex") === hash}`), "the-code"), open: (u) => opened.push(u) });
    expect(ok).toBe(true);
    expect(made).toEqual(["example-org-box-a-runners-1f2e true"]);
    expect(sent[0]!.slice(0, 3)).toEqual(["key", "code", OP]);
    expect(sent[0]![sent[0]!.indexOf("--code") + 1]).toBe("the-code");
    expect(opened).toEqual(["https://github.com/apps/x/installations/new"]);
  });
});
