// Where network capture keeps things, from config.ts's Paths (root is "/" on the box, a temporary
// folder in tests, as for the guard's files beside these).
//   /private/var/taskbox-net/                 _taskboxnet's, 750, the service let in by one ACL entry:
//                                             each bridge's ring (net/ring.ts). root never walks or deletes in it.
//   /private/var/run/taskbox-net/             root's, 755: each bridge's FIFO and its two launchd jobs' plists.
//                                             Under /var/run, so a restart clears them with the bridges.
//   /private/var/run/taskbox-netwatch.json    root's, 644: netwatch's record (net/netwatch.ts).
//   <service state>/net/<job id>.jsonl        the service's: each job's detail file (hooks/net.ts).
//   <service state>/net-rules.json            the service's: the selftest's agreement table (net/agree.ts).
import { dirname, join } from "node:path";
import { LABEL_PREFIX } from "../settings/core.ts";

export const NETWATCH_LABEL = `${LABEL_PREFIX}.netwatch`;
// Each bridge's two jobs: its tcpdump (root, dropping to _taskboxnet) and its parser (_taskboxnet).
export const captureLabel = (bridge: string) => `${NETWATCH_LABEL}.${bridge}.capture`;
export const parseLabel = (bridge: string) => `${NETWATCH_LABEL}.${bridge}`;

export function netPaths(p: { guardState: string; guardPlist: string; projectState: string }) {
  const run = dirname(p.guardState); // .../private/var/run
  const run2 = join(run, "taskbox-net");
  return {
    dir: join(dirname(run), "taskbox-net"),
    run: run2,
    fifo: (bridge: string) => join(run2, `${bridge}.fifo`),
    jobPlist: (label: string) => join(run2, `${label}.plist`),
    record: join(run, "taskbox-netwatch.json"),
    plist: join(dirname(p.guardPlist), `${NETWATCH_LABEL}.plist`),
    details: join(p.projectState, "net"),
    rules: join(p.projectState, "net-rules.json"),
  };
}
export type NetPaths = ReturnType<typeof netPaths>;
