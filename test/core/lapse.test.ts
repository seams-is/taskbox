// Lasting changes and outcomes lapse by whichever comes first: the wall clock past the limit, the
// wall clock earlier than the item's own time, the monotonic clock (same boot) past the limit, or a
// restart of the box. So no clock step, either way, keeps one alive past its limit.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { answer, LAPSE_MS, lapse, noPending, raise, waiting } from "../../src/core/pending.ts";
import { keepOutcomes, OUTCOME_KEEP_MS, recordOutcome } from "../../src/core/spool.ts";

const T = Date.parse("2026-11-25T12:00:00Z");
const M = 5_000_000; // monotonic ms at the ask
const at = (wall: number, mono = M, boot = "7C4F5A0E-3B1D-4E8A-9F21-6D0B2C8E4A17") => ({ wall, mono, boot });
const ask = { kind: "rule" as const, subject: "channel", shows: ["Move to beta."], actor: "owner", payload: { to: "beta" } };
function raised() {
  const r = raise(noPending(), ask, at(T));
  if (!r.ok) throw new Error(r.why);
  return r;
}

describe("a pending change", () => {
  test("records the boot and the monotonic time it was asked at", () => {
    expect(raised().item).toMatchObject({ askedAt: T, boot: "7C4F5A0E-3B1D-4E8A-9F21-6D0B2C8E4A17", monoAt: M });
  });
  test("a clock stepped back keeps it no longer: any wall time before its ask lapses it", () => {
    const r = raised();
    const back = at(T - 60_000, M + 60_000);
    expect(lapse(r.state, back).lapsed).toHaveLength(1);
    expect(waiting(r.state, back)).toHaveLength(0);
    expect(answer(r.state, r.item.id, back).ok).toBe(false);
  });
  test("a clock stepped back by days still lapses it at 24 hours of monotonic time", () => {
    const r = raised();
    expect(lapse(r.state, at(T + 1000, M + LAPSE_MS - 1)).lapsed).toHaveLength(0);
    // The wall clock went back 3 days after the ask, then ran on: the wall says 21 h, mono says 24.
    expect(lapse(r.state, at(T + LAPSE_MS - 3 * 3600_000, M + LAPSE_MS)).lapsed).toHaveLength(1);
  });
  test("a clock stepped forward lapses it by the wall clock", () => {
    const r = raised();
    expect(lapse(r.state, at(T + LAPSE_MS, M + 1000)).lapsed).toHaveLength(1);
  });
  test("a restart of the box lapses it", () => {
    const r = raised();
    expect(lapse(r.state, at(T + 1000, 10, "0A1B2C3D-4E5F-4061-8293-A4B5C6D7E8F9")).lapsed).toHaveLength(1);
    expect(answer(r.state, r.item.id, at(T + 1000, 10, "0A1B2C3D-4E5F-4061-8293-A4B5C6D7E8F9")).ok).toBe(false);
  });
});

describe("an outcome file", () => {
  const id = `rq_${"0".repeat(26)}`;
  const setup = () => {
    const dir = join(mkdtempSync(join(tmpdir(), "taskbox-lapse-")), "outcomes", "agent");
    recordOutcome(dir, { id, at: T, ok: true, said: "x", mono: M, boot: "7C4F5A0E-3B1D-4E8A-9F21-6D0B2C8E4A17" }, { owner: process.getuid!() });
    utimesSync(join(dir, `${id}.json`), new Date(T), new Date(T));
    return dir;
  };
  test("is kept when the wall clock goes back: boot and mono decide then", () => {
    const dir = setup();
    expect(keepOutcomes(dir, at(T - 1000, M + 1000))).toEqual([]);
  });
  test("goes at its hour of monotonic time, whatever the wall clock says", () => {
    const dir = setup();
    expect(keepOutcomes(dir, at(T + 1000, M + OUTCOME_KEEP_MS - 1))).toEqual([]);
    expect(keepOutcomes(dir, at(T + 1000, M + OUTCOME_KEEP_MS + 1))).toEqual([id]);
  });
  test("goes after a restart, and by the wall clock forward", () => {
    expect(keepOutcomes(setup(), at(T + 1000, 10, "0A1B2C3D-4E5F-4061-8293-A4B5C6D7E8F9"))).toEqual([id]);
    expect(keepOutcomes(setup(), at(T + OUTCOME_KEEP_MS + 1, M + 1000))).toEqual([id]);
    expect(readdirSync(setup())).toHaveLength(1);
  });
});
