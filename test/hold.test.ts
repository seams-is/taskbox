// The hold lease (src/hold.ts): set when the box reports a hold, renewed while it answers and still
// reports it, ended when the hold goes or the box stops answering, capped at 12 hours ahead, and
// written only by the controller the box names.
import { describe, expect, test } from "bun:test";
import { endLease, holdVariable, isoSecond, type LeaseMemory, leaseDone, leaseStep, RENEW_MS, writeLease } from "../src/hold.ts";

const T = Date.parse("2026-11-23T14:02:00Z");
const M = 60_000;
const H = 60 * M;
const held = { answered: true, hold: { since: T, why: "workspace agent-a-3 (Whole)" } };

function poll(mem: LeaseMemory, view: Parameters<typeof leaseStep>[0], now: number, writer = true, hours?: number) {
  const s = leaseStep(view, mem, now, writer, hours);
  leaseDone(mem, s, now);
  return s;
}

describe("the lease", () => {
  test("the variable's name: the box's name upper-cased, dashes as underscores", () => {
    expect(holdVariable("taskbox-1")).toBe("TASKBOX_HOLD_TASKBOX_1");
    expect(() => holdVariable("Taskbox 1")).toThrow();
    expect(() => holdVariable("x$(id)")).toThrow();
  });

  test("set when the box reports a hold: since is the box's, until 12 hours on, in the form jq reads", () => {
    const mem: LeaseMemory = {};
    const s = poll(mem, held, T + 30_500);
    expect(s).toEqual({ do: "write", lease: { until: "2026-11-24T02:02:30Z", since: "2026-11-23T14:02:00Z", why: "workspace agent-a-3 (Whole)", waitingSince: null, waitingUntil: null, at: "2026-11-23T14:02:30Z" } });
  });

  test("renewed every 30 minutes while the box answers with that hold, and not between", () => {
    const mem: LeaseMemory = {};
    poll(mem, held, T);
    expect(poll(mem, held, T + RENEW_MS - M).do).toBe("none");
    const r = poll(mem, held, T + RENEW_MS);
    expect(r).toMatchObject({ do: "write", lease: { since: isoSecond(T), until: isoSecond(T + RENEW_MS + 12 * H) } });
    // A new hold (another reason, or a new since) is written at once.
    expect(poll(mem, { answered: true, hold: { since: T + RENEW_MS + M, why: "paused" } }, T + RENEW_MS + M).do).toBe("write");
  });

  test("ended as soon as the box reports the hold gone", () => {
    const mem: LeaseMemory = {};
    poll(mem, held, T);
    expect(poll(mem, { answered: true }, T + M)).toEqual({ do: "end", why: "the box reports no hold" });
    expect(mem.lease).toBeUndefined();
    expect(poll(mem, { answered: true }, T + 2 * M).do).toBe("none");
  });

  test("ended when the box hasn't answered for 5 minutes, and never renewed while it doesn't", () => {
    const mem: LeaseMemory = {};
    poll(mem, held, T);
    expect(poll(mem, { answered: false }, T + RENEW_MS).do).toBe("none");
    expect(poll(mem, { answered: false }, T + RENEW_MS + 4 * M).do).toBe("none");
    expect(poll(mem, { answered: false }, T + RENEW_MS + 5 * M)).toEqual({ do: "end", why: "the box hasn't answered for 5 minutes" });
    // The box answers again with its hold: written again.
    expect(poll(mem, held, T + RENEW_MS + 6 * M).do).toBe("write");
  });

  test("never more than 12 hours ahead, whatever the setting says", () => {
    const at = (h: number) => {
      const s = leaseStep(held, {}, T, true, h);
      return s.do === "write" ? (Date.parse(s.lease.until) - Date.parse(s.lease.at)) / H : -1;
    };
    expect(at(6)).toBe(6);
    expect(at(48)).toBe(12);
    expect(at(0)).toBe(1);
  });

  test("a request waiting: waitingSince once, waitingUntil an hour ahead and moved on; cleared when it goes", () => {
    const mem: LeaseMemory = {};
    const w = { ...held, requestWaiting: true };
    const first = poll(mem, w, T);
    expect(first).toMatchObject({ do: "write", lease: { waitingSince: isoSecond(T), waitingUntil: isoSecond(T + H) } });
    expect(poll(mem, w, T + 5 * M).do).toBe("none");
    const moved = poll(mem, w, T + 11 * M);
    expect(moved).toMatchObject({ do: "write", lease: { waitingSince: isoSecond(T), waitingUntil: isoSecond(T + 71 * M) } });
    expect(poll(mem, held, T + 12 * M)).toMatchObject({ do: "write", lease: { waitingSince: null, waitingUntil: null } });
  });

  test("only the controller the box names writes; another leaves the variable alone", () => {
    const mem: LeaseMemory = {};
    expect(poll(mem, held, T, false).do).toBe("none");
    expect(poll(mem, { answered: false }, T + 10 * M, false).do).toBe("none");
  });

  test("the reason is printable and short, and carries no line breaks", () => {
    const s = leaseStep({ answered: true, hold: { since: T, why: `paused\n::error::x${"y".repeat(200)}` } }, {}, T, true);
    expect(s.do === "write" && s.lease.why).toBe(`paused::error::x${"y".repeat(64)}`);
  });
});

describe("writing it through the owner's GitHub session", () => {
  const fake = (codes: number[]) => {
    const calls: { args: string[]; stdin?: string }[] = [];
    return {
      calls,
      gh: async (args: string[], stdin?: string) => {
        calls.push({ args, ...(stdin !== undefined ? { stdin } : {}) });
        const code = codes.shift() ?? 0;
        return { code, stdout: "", stderr: code ? "HTTP 404: Not Found" : "" };
      },
    };
  };
  const lease = { until: "2026-11-24T02:02:00Z", since: "2026-11-23T14:02:00Z", why: "paused", waitingSince: null, waitingUntil: null, at: "2026-11-23T14:02:00Z" };

  test("updates the variable, or makes it; the value goes on stdin", async () => {
    const f = fake([0]);
    expect(await writeLease(f.gh, "example-org/app", "taskbox-1", lease)).toBeUndefined();
    expect(f.calls[0]!.args).toEqual(["api", "--method", "PATCH", "repos/example-org/app/actions/variables/TASKBOX_HOLD_TASKBOX_1", "--input", "-"]);
    expect(JSON.parse(f.calls[0]!.stdin!)).toEqual({ name: "TASKBOX_HOLD_TASKBOX_1", value: JSON.stringify(lease) });
    expect(f.calls[0]!.args.join(" ")).not.toContain("paused");
    const g = fake([1, 0]);
    expect(await writeLease(g.gh, "example-org/app", "taskbox-1", lease)).toBeUndefined();
    expect(g.calls[1]!.args).toEqual(["api", "--method", "POST", "repos/example-org/app/actions/variables", "--input", "-"]);
  });

  test("ends it by deleting the variable; one gone already is ended", async () => {
    const f = fake([1]);
    expect(await endLease(f.gh, "example-org/app", "taskbox-1")).toBeUndefined();
    expect(f.calls[0]!.args).toEqual(["api", "--method", "DELETE", "repos/example-org/app/actions/variables/TASKBOX_HOLD_TASKBOX_1"]);
  });

  test("a repo name out of shape is refused before gh runs", async () => {
    const f = fake([]);
    expect(await writeLease(f.gh, "example-org/app --method DELETE", "taskbox-1", lease)).toMatch(/isn't one taskbox reads/);
    expect(f.calls).toEqual([]);
  });
});
