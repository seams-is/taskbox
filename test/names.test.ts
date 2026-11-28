// The lines the owner reads name the configured service account (names.ts): "as ci" on a box whose
// accounts.service is ci, never "as the service account".
import { afterEach, describe, expect, test } from "bun:test";
import { beatState, restartsState, staleRestart } from "../src/beat.ts";
import { setServiceName } from "../src/names.ts";
import { pullLine } from "../src/progress.ts";
import { computeState, softnetFix } from "../src/state.ts";
import { stoppedLine } from "../src/availability.ts";

afterEach(() => setServiceName(undefined));

describe("owner lines name the configured service account", () => {
  test("restart, Softnet, stop and download lines say the account's own name", () => {
    setServiceName("ci");
    expect(staleRestart()).toBe("At the box: as ci, type taskbox stop, then taskbox start.");
    expect(softnetFix()).toMatch(/^As ci, type taskbox start/);
    expect(stoppedLine(1_800_000_000_000)).toMatch(/taskbox start as ci,/);
    expect(pullLine(undefined, 0)).toBe("No download yet. It starts when ci logs in.");
    expect(restartsState({ selfRestartCount: 9, selfRestartSince: 1 }, 2)?.next ?? "").toMatch(/as ci, type taskbox stop/);
    void beatState;
  });

  test("the Needs you line names it, from the box's settings", () => {
    setServiceName("taskbox");
    const s = computeState({ serviceAway: true, loop: {} } as never);
    expect(s.next).toBe("At the box: log in as taskbox. Jobs wait until then.");
  });

  test("before the box's names are read, the role is named", () => {
    expect(staleRestart()).toMatch(/as the service account,/);
  });
});
