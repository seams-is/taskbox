// The real chmod path, on a real file, with the bun this repo pins. No faked command: this is
// the bug the box hit (bun's chmodSync dropped the setuid bit), so a fake would prove nothing.
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setSetuid } from "../src/install.ts";
import type { RunResult, Sys } from "../src/sys.ts";

// Runs only /bin/chmod, by absolute path, with a system-only PATH.
const chmodOnly = {
  async run(cmd: string, args: string[]): Promise<RunResult> {
    if (cmd !== "/bin/chmod") throw new Error(`unexpected command ${cmd}`);
    const p = Bun.spawnSync([cmd, ...args], { env: { PATH: "/usr/bin:/bin" } });
    return { code: p.exitCode ?? 1, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
  },
} as unknown as Sys;

const file = () => {
  const f = join(mkdtempSync(join(tmpdir(), "taskbox-suid-")), "softnet");
  writeFileSync(f, "x");
  chmodSync(f, 0o755);
  return f;
};

describe("the setuid bit", () => {
  test("setSetuid leaves the file at 4755", async () => {
    const f = file();
    // Tests don't run as root, so the owner check is off here; the install keeps it on.
    await setSetuid(chmodOnly, f, false);
    const mode = statSync(f).mode & 0o7777;
    expect(mode).toBe(0o4755);
  });

  test("the install refuses a file not owned by root", async () => {
    await expect(setSetuid(chmodOnly, file())).rejects.toThrow(/root-owned file with mode 4755/);
  });
});
