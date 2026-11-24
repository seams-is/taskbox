// taskbox stop and taskbox start: the loop, in the service account's session at the box.
// (WP5 makes stop drain first, adds --force and --timeout, and lets the owner run both signed.)
import type { BoxCtx, CommandSpec, Outcome } from "../command.ts";

export async function stopOrStart(c: BoxCtx, which: "stop" | "start" | "drain"): Promise<Outcome> {
  const { loadConfig } = await import("../config.ts");
  const { Log } = await import("../log.ts");
  const { cleanLeftovers } = await import("../loop.ts");
  const { stateNow } = await import("../ops.ts");
  const { footer } = await import("../state.ts");
  const { ALREADY, drain, start, stop } = await import("../stopstart.ts");
  if (c.uid !== c.cu) {
    c.say(`Run taskbox ${which} as ${c.S}, at the box: the loop runs in ${c.S}'s login session.`);
    return 1;
  }
  const p = c.p;
  // What stop needs to remove the VMs a stopped loop left, with taskbox prune's own code.
  const cleanUp = () => {
    const log = new Log(p.log);
    return {
      log: (l: string) => log.write(l),
      // Settings are read here, so a taskbox.json that won't load is one more reason the VMs stay.
      cleanVms: async () => cleanLeftovers({ sys: c.ops.sys, cfg: loadConfig(p.app, p.boxSettings), paths: p, log }),
    };
  };
  const code = which === "drain" ? await drain(c.ops) : which === "stop" ? await stop({ ...c.ops, ...cleanUp() }) : await start(c.ops);
  for (const l of footer(await stateNow(c.ops), code === 0 ? (which === "drain" ? "Started a drain." : which === "stop" ? "Stopped the loop." : "Started the loop.") : "Nothing changed.")) c.say(l);
  // Already so is done, with nothing changed (§3.1): v2's ALREADY, 3, is now changed false.
  return { exit: code === ALREADY ? 0 : code, changed: code === 0 };
}

export const commands: CommandSpec[] = [
  { path: ["stop"], summary: "Stops the loop. Running jobs end now.", who: ["service"], flags: ["json"], run: (c) => stopOrStart(c, "stop") },
  { path: ["start"], summary: "Starts the loop.", who: ["service"], flags: ["json"], run: (c) => stopOrStart(c, "start") },
];
