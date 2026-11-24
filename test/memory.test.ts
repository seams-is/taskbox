import { describe, expect, test } from "bun:test";
import { memoryShort, parseVmStat, readMemory } from "../src/memory.ts";
import { FakeSys } from "./fake.ts";

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               12000.
Pages active:                            900000.
Pages inactive:                          500000.
Pages speculative:                        10000.
Pages throttled:                              0.
Pages wired down:                        200000.
Pages purgeable:                          50000.
`;

describe("memory", () => {
  test("available is free, inactive, speculative and purgeable pages, in decimal GB", () => {
    expect(parseVmStat(VM_STAT)!.toFixed(2)).toBe(((572000 * 16384) / 1e9).toFixed(2));
    expect(parseVmStat("nothing")).toBeUndefined();
  });
  test("the pressure level and vm_stat are read; anything odd is not read", async () => {
    const sys = new FakeSys();
    sys.responders.push((cmd) => (cmd === "/usr/sbin/sysctl" ? { code: 0, stdout: "2\n", stderr: "" } : cmd === "/usr/bin/vm_stat" ? { code: 0, stdout: VM_STAT, stderr: "" } : undefined));
    expect((await readMemory(sys)).pressure).toBe(2);
    const odd = new FakeSys();
    odd.responders.push((cmd) => (cmd === "/usr/sbin/sysctl" ? { code: 0, stdout: "3\n", stderr: "" } : cmd === "/usr/bin/vm_stat" ? { code: 0, stdout: "nothing\n", stderr: "" } : undefined));
    expect(await readMemory(odd)).toEqual({ pressure: undefined, availableGB: undefined });
  });
  test("a VM starts only at normal pressure with its memory and 4 GB to spare", () => {
    expect(memoryShort({ pressure: 1, availableGB: 12.2 }, 8192)).toBeUndefined();
    expect(memoryShort({ pressure: 1, availableGB: 12 }, 8192)).toContain("a VM needs 12.2 GB");
    expect(memoryShort({ pressure: 4, availableGB: 30 }, 8192)).toBe("memory pressure is very high");
    expect(memoryShort({ pressure: 1, availableGB: undefined }, 8192)).toBe("the box can't read its memory");
  });
});
