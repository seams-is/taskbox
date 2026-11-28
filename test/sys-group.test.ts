// realSys's run with group: a timeout kills the child's whole process group, so nothing it started
// is left running. Run in a child process, since the real Sys refuses to run inside a test.
import { expect, test } from "bun:test";
import { join } from "node:path";

test("a timed-out run with group kills its grandchildren too, and runs from the cwd given", () => {
  const sys = join(import.meta.dir, "../src/sys.ts");
  const code = `
    const { realSys } = await import(${JSON.stringify(sys)});
    const s = realSys("/var/empty");
    const here = await s.run("/bin/pwd", [], { cwd: "/" });
    const r = await s.run("/bin/sh", ["-c", "/bin/sleep 30 & echo $!; wait"], { timeoutMs: 500, group: true });
    const pid = Number(r.stdout.trim());
    await Bun.sleep(200);
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    console.log(JSON.stringify({ cwd: here.stdout.trim(), pid: pid > 0, alive }));
  `;
  const p = Bun.spawnSync([process.execPath, "-e", code], { env: { PATH: "/usr/bin:/bin" } });
  expect(JSON.parse(p.stdout.toString().trim())).toEqual({ cwd: "/", pid: true, alive: false });
}, 15_000);
