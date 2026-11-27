// Migration step 4's fetch: a tool whose v3 pin differs from the copy v2.6.1 put in the install is
// fetched by its pin (https, a size cap, the SHA-256 checked before anything is unpacked), unpacked
// in the install's own tools/<name>-<version>/, then moved in:
// - bun and Softnet are files: the new one is renamed over the old path in one step, so a running
//   bun keeps the file it opened. Softnet gets its setuid bit, checked, before the rename;
// - Tart's bundle is a folder: the old one is renamed aside into tools/, then the new one in. A
//   failure of the second rename puts the old one back.
// Tailscale's build is an asset of the release repo, read with a token: its pin is left to taskbox
// update, and said.
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DOWNLOAD_LIMIT_MS } from "../ghfail.ts";
import { readCapped, SAFE_UNTAR } from "../hop.ts";
import type { Sys } from "../sys.ts";

export const TOOL_MAX = 256 * 1024 * 1024;
export type Pin = { version?: string; url?: string; sha256?: string };
export const FETCHED = ["bun", "tart", "softnet"] as const;

export interface FetchDeps {
  sys: Pick<Sys, "fetch" | "run" | "timeout">;
  setuid(path: string): Promise<void>; // install.ts setSetuid: 4755, read back
}

async function must(d: FetchDeps, cmd: string, args: string[]): Promise<void> {
  const r = await d.sys.run(cmd, args, { timeoutMs: 300_000 });
  if (r.code !== 0) throw new Error(`${cmd.split("/").pop()} failed: ${r.stderr.trim().slice(0, 120) || `exit ${r.code}`}`);
}

async function download(d: FetchDeps, name: string, pin: Pin, file: string): Promise<void> {
  if (!pin.url?.startsWith("https://") || !pin.sha256 || !/^[0-9a-f]{64}$/.test(pin.sha256)) throw new Error(`${name}'s pin has no https URL and SHA-256`);
  const res = await d.sys.fetch(pin.url, { redirect: "follow", signal: d.sys.timeout(DOWNLOAD_LIMIT_MS) });
  if (!res.ok) throw new Error(`${name} ${pin.version} couldn't be downloaded (${res.status})`);
  const parts: Uint8Array[] = [];
  await readCapped(res, TOOL_MAX, (b) => parts.push(b), () => new Error(`${name} ${pin.version} is larger than taskbox takes`));
  const data = Buffer.concat(parts);
  if (createHash("sha256").update(data).digest("hex") !== pin.sha256) throw new Error(`${name} ${pin.version} doesn't match its pin`);
  writeFileSync(file, data, { mode: 0o600 });
}

// One tool into the install at dir. Run again after a stop part way, it starts its folder afresh.
export async function fetchTool(d: FetchDeps, dir: string, name: (typeof FETCHED)[number], pin: Pin): Promise<void> {
  const at = join(dir, "tools", `${name}-${pin.version}`);
  rmSync(at, { recursive: true, force: true });
  mkdirSync(at, { recursive: true, mode: 0o700 });
  const archive = join(at, name === "bun" ? "bun.zip" : `${name}.tar.gz`);
  await download(d, name, pin, archive);
  if (name === "bun") {
    await must(d, "/usr/bin/ditto", ["-x", "-k", archive, join(at, "x")]);
    cpSync(join(at, "x/bun-darwin-aarch64/bun"), join(dir, "bin/bun.new"));
    await must(d, "/bin/chmod", ["755", join(dir, "bin/bun.new")]);
    renameSync(join(dir, "bin/bun.new"), join(dir, "bin/bun"));
  } else if (name === "softnet") {
    mkdirSync(join(at, "x"));
    await must(d, "/usr/bin/tar", ["-xzf", archive, "-C", join(at, "x"), ...SAFE_UNTAR]);
    const to = existsSync(join(dir, "softnet")) ? join(dir, "softnet/softnet") : join(dir, "bin/softnet");
    cpSync(join(at, "x/softnet"), `${to}.new`);
    await d.setuid(`${to}.new`);
    renameSync(`${to}.new`, to);
  } else {
    await must(d, "/usr/bin/tar", ["-xzf", archive, "-C", at, ...SAFE_UNTAR, "tart.app"]);
    const live = join(dir, "bin/tart.app");
    const aside = join(dir, "tools", "tart-before");
    rmSync(aside, { recursive: true, force: true });
    if (existsSync(live)) renameSync(live, aside);
    try {
      renameSync(join(at, "tart.app"), live);
    } catch (e) {
      if (existsSync(aside)) renameSync(aside, live);
      throw e;
    }
  }
  rmSync(archive, { force: true });
  rmSync(join(at, "x"), { recursive: true, force: true });
}
