// taskbox install: the first install, run by install.sh as root from a signed release. Updates are
// taskbox update's (src/update/).
import type { BoxCtx, CommandSpec } from "../command.ts";

export const REPO_SHAPE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;

export async function install(c: BoxCtx): Promise<number> {
  const { join } = await import("node:path");
  const { CANT_REACH, cantReach, install: run, Stop } = await import("../install.ts");
  const { Log } = await import("../log.ts");
  const { stateNow } = await import("../ops.ts");
  const { footer } = await import("../state.ts");
  const { say, ask, tty } = c;
  const p = c.p;
  const guest = c.opts["guest-test"] === true;
  if (c.uid !== 0 || typeof c.opts.bootstrap !== "string" || typeof c.opts.settings !== "string") {
    say("Type sh taskbox/install.sh --settings ORG/REPO, in the folder the release is in.");
    return 1;
  }
  const owner = c.env.SUDO_USER;
  if (!owner || owner === "root") {
    say("Type sh taskbox/install.sh --settings ORG/REPO as your admin user.");
    return 1;
  }
  const log = new Log();
  try {
    await run({ sys: c.deps.sys("/var/root"), paths: p, log, say, ask, chown: c.chown, owner, ownerHome: join("/Users", owner), workRoot: "/private/var/tmp", release: c.opts.bootstrap, settingsRepo: c.opts.settings, guestTest: guest, tty });
  } catch (e) {
    const offline = !(e instanceof Stop) && cantReach(e);
    const why = e instanceof Stop ? e.message : offline ? CANT_REACH : log.redact((e as Error).message);
    say(why);
    const next = (e instanceof Stop && e.owner) || offline ? "The step in the line above, then run the install again." : e instanceof Stop && /You typed/.test(why) ? "Nothing to do." : "Nothing to do: agents fix it.";
    for (const l of footer(await stateNow(c.ops), "Not installed.", next)) say(l);
    return 1;
  }
  for (const l of footer(await stateNow(c.ops), "Installed.", guest ? "Nothing to do: this was a guest test." : `Log in as ${c.S}. From the controller: taskbox box add, then taskbox connect github.`)) say(l);
  return 0;
}

export const commands: CommandSpec[] = [
  {
    path: ["install"],
    summary: "The first install, from install.sh: a signed release and the settings repo's taskbox.json.",
    who: ["admin"],
    internal: true,
    options: [{ name: "--bootstrap", value: "FOLDER" }, { name: "--settings", value: "ORG/REPO", check: (v) => REPO_SHAPE.test(v) }, { name: "--guest-test" }],
    // The settings beside the release name the box's accounts.
    namesFrom: (c) => (typeof c.opts.bootstrap === "string" ? c.opts.bootstrap : undefined),
    run: (c) => install(c),
  },
];
