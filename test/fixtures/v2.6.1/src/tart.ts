// v2.6.1's src/tart.ts at c7d2414, cut to what hop() runs. Each part below is that file's own text, unchanged, unless marked New.
import { existsSync, lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Sys } from "./sys.ts";

// config.ts's CI_USER, the account the loop runs as. A value from config.ts would close an import
// cycle back to vm.ts, so it is named again here, and a test holds the two the same.
export const SOFTNET_USER = "ci";

// Closes Softnet's folder to every account but root and ci (the pattern of the job source App's key
// folder, actionskey.ts).
async function closeFolder(folder: string, run: (cmd: string, args: string[]) => Promise<void>): Promise<void> {
  await run("/bin/chmod", ["700", folder]);
  await run("/bin/chmod", ["-N", folder]);
  await run("/bin/chmod", ["+a", `user:${SOFTNET_USER} allow list,search`, folder]);
}

// Where an install keeps Softnet: its own folder, or bin in an install from before it had one.
const softnetIn = (dir: string) => (existsSync(join(dir, "softnet")) ? join(dir, "softnet/softnet") : join(dir, "bin/softnet"));

// New: v2.6.1's TART_KIT with name, inert and finish only. Each method's text is v2.6.1's own.
export const TART_KIT = {
  name: "tart",
  async inert(sys, prev) {
    const softnet = softnetIn(prev);
    if (existsSync(softnet) && !lstatSync(softnet).isSymbolicLink()) {
      const r = await sys.run("/bin/chmod", ["u-s", softnet]);
      if (r.code !== 0) throw new Error(`chmod failed on ${softnet}: ${r.stderr.trim().slice(0, 200)}`);
    }
  },
  // After the install folder is root's and read-only: Softnet's folder is closed to every account but
  // root and ci, and then Softnet gets its setuid bit.
  async finish(dir, setuid, run) {
    const softnet = softnetIn(dir);
    if (softnet.endsWith("bin/softnet")) return setuid(softnet);
    if (!lstatSync(dirname(softnet)).isDirectory()) throw new Error(`${dirname(softnet)} isn't a folder`);
    await closeFolder(dirname(softnet), run);
    await setuid(softnet);
  },
} satisfies { name: string; inert(sys: Sys, prev: string): Promise<void>; finish(dir: string, setuid: (path: string) => Promise<void>, run: (cmd: string, args: string[]) => Promise<void>): Promise<void> };
