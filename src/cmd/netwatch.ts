// Network capture's daemons, which launchd runs: netwatch as root, following the bridges, and each
// bridge's parser as _taskboxnet. None is typed by a person; taskbox check shows what they do.
import { join } from "node:path";
import type { CommandSpec } from "../command.ts";

const BRIDGE = /^bridge[0-9]{1,4}$/;
const NUMBER = /^[1-9][0-9]{0,3}$/;

export const commands: CommandSpec[] = [
  {
    path: ["netwatch"],
    summary: "Network capture: follows the VMs' bridges and starts one capture and parser for each.",
    who: ["launchd"],
    internal: true,
    async run(c) {
      if (c.uid !== 0) {
        c.say("Network capture runs by itself, as root. Type taskbox check to see it.");
        return 1;
      }
      const { runNetwatch } = await import("../net/netwatch.ts");
      let stopping = false;
      const stop = () => (stopping = true);
      process.once("SIGTERM", stop);
      await runNetwatch({ sys: c.deps.sys("/var/root"), paths: c.own, rootUid: c.ops.rootUid ?? 0, stopped: () => stopping });
      return 0;
    },
  },
  {
    path: ["netwatch", "parse"],
    summary: "One bridge's parser, as taskbox's account for network capture.",
    who: ["launchd"],
    internal: true,
    args: { name: "BRIDGE RING_MB DNS_NAMES KEEP_DAYS", min: 4, max: 4 },
    async early(c) {
      const [bridge, ring, names, keep] = c.args;
      if (!BRIDGE.test(bridge ?? "") || !NUMBER.test(ring ?? "") || (names !== "failures" && names !== "none") || !NUMBER.test(keep ?? "")) {
        c.say("netwatch parse takes a bridge, the ring's MB, failures or none, and the days kept.");
        return 2;
      }
      // root never runs the parser: it reads what the VMs sent.
      if (c.uid === 0) {
        c.say("The parser runs as taskbox's account for network capture, never as root.");
        return 1;
      }
      const { netPaths } = await import("../net/paths.ts");
      const { runParser } = await import("../net/netparse.ts");
      const run = join(c.root, "private/var/run");
      const p = netPaths({ guardState: join(run, "taskbox-guard.json"), guardPlist: join(c.root, "Library/LaunchDaemons/x.plist"), projectState: run });
      await runParser({ fifo: p.fifo(bridge!), dir: p.dir, bridge: bridge!, ringMB: Number(ring), names: names === "failures", keepDays: Number(keep), clock: c.deps.sys("/var/empty"), uid: c.uid });
      return 0;
    },
  },
];
