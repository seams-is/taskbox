// The GitHub key keeper's daemon (broker.ts), run by its LaunchDaemon as _taskboxgh.
import type { CommandSpec } from "../command.ts";

export const commands: CommandSpec[] = [
  {
    path: ["broker"],
    summary: "The GitHub key keeper: holds both Apps' keys and answers a closed set of asks.",
    who: ["launchd"],
    internal: true,
    async run(c) {
      const { aclProblem, BROKER_ACCOUNT, brokerPathsOf, keysDirProblem } = await import("../keys.ts");
      const { uidOf } = await import("../accounts.ts");
      const { loadConfig } = await import("../config.ts");
      const { runBroker } = await import("../broker.ts");
      const { Log } = await import("../log.ts");
      const sys = c.ops.sys;
      if (c.uid === 0 || c.uid !== (await uidOf(sys, BROKER_ACCOUNT))) {
        c.say(`The GitHub key keeper runs by itself, as ${BROKER_ACCOUNT}. Type taskbox connect status to see the Apps.`);
        return 1;
      }
      const b = brokerPathsOf(c.p);
      const why = keysDirProblem(b.keys, c.uid) ?? (await aclProblem(sys, b.keys));
      if (why) {
        c.say(`The GitHub key keeper can't start: ${why}. Type taskbox update as your admin user.`);
        return 1;
      }
      const log = new Log();
      // Its beat, in its own folder, as the guard writes its own: every 30 s, well inside guardwatch's
      // two minutes, and once at the start.
      const { keeperBeat } = await import("../broker.ts");
      const beat = await keeperBeat(sys, brokerPathsOf(c.p).beat, c.uid, process.pid);
      await beat();
      sys.every(30_000, () => void beat());
      const { readBoxFile } = await import("../boxsettings.ts");
      runBroker({ sys, log, settings: () => loadConfig(c.p.app, c.p.boxSettings), box: () => readBoxFile(c.p.boxSettings).settings, keysDir: b.keys, ownerUid: c.uid }, { socket: b.socket, guardSocket: b.guardSocket, usedFile: b.used });
      await new Promise<never>(() => {});
      return 0;
    },
  },
];
