// The red-team script's forward tests, run against stub ssh, nc and curl: nothing leaves the
// Mac. A forward test says inconclusive, never its pass value, unless ssh connected.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = readFileSync(join(import.meta.dir, "redteam/from-controller.sh"), "utf8");

function run(mode: "bind" | "fail", busy: number[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "taskbox-rt-"));
  const stub = (name: string, body: string) => (writeFileSync(join(dir, name), `#!/bin/bash\n${body}\n`), chmodSync(join(dir, name), 0o755));
  // ssh -N with -L or -D: "bind" logs in and holds the local port; "fail" never connects.
  stub("ssh", `D=${dir}
if [[ " $* " == *" -N "* ]] && [[ " $* " == *" -L "* || " $* " == *" -D "* ]]; then
  [ "${mode}" = fail ] && exit 255
  for a in "$@"; do case "$a" in 15900:*) p=15900;; 15080) p=15080;; esac; done
  touch "$D/port-$p"; echo $$ > "$D/ssh-$p"; exec sleep 60
fi
echo stub`);
  stub("nc", `D=${dir}; if [ "$1" = -z ]; then [ -e "$D/port-$5" ]; else exit 0; fi`);
  stub("curl", `printf 000`);
  for (const n of ["sftp", "scp", "rsync", "tailscale"]) stub(n, "exit 1");
  for (const p of busy) writeFileSync(join(dir, `port-${p}`), "");
  const sh = join(dir, "from-controller.sh");
  writeFileSync(sh, script.replace(/^TS=.*$/m, `TS=${join(dir, "tailscale")}`));
  const r = Bun.spawnSync(["bash", sh, "taskbox-1", "admin"], { env: { PATH: `${dir}:/usr/bin:/bin`, HOME: dir, TMPDIR: dir } });
  const out = r.stdout.toString();
  const block = (id: string) => out.split("=== ").find((b) => b.startsWith(`${id}\n`)) ?? "";
  return { dir, out, block };
}

describe("the red-team forward tests", () => {
  test("ssh that never connects is inconclusive, never a pass", () => {
    const { block } = run("fail");
    for (const id of ["SSH3-i", "SSH3-k"]) {
      expect(block(id)).toContain("inconclusive: ssh did not connect");
      expect(block(id)).not.toContain("exit:");
    }
  }, 60_000);

  test("a local port already in use is inconclusive, and ssh isn't run", () => {
    const { block, dir } = run("bind", [15900]);
    expect(block("SSH3-i")).toContain("inconclusive: local port 15900 is already in use");
    expect(existsSync(join(dir, "ssh-15900"))).toBe(false);
  }, 60_000);

  test("ssh that connects runs the probe, and its ssh is gone when the script ends", () => {
    const { block, dir } = run("bind");
    expect(block("SSH3-i")).toContain("exit:   0");
    expect(block("SSH3-k")).toContain("out:    000");
    for (const p of [15900, 15080]) {
      const pid = Number(readFileSync(join(dir, `ssh-${p}`), "utf8"));
      expect(Bun.spawnSync(["kill", "-0", String(pid)]).exitCode).not.toBe(0);
    }
  }, 60_000);
});
