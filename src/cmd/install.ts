// taskbox install: the first install, run by install.sh as root. taskbox update shares its steps.
import type { BoxCtx, CommandSpec } from "../command.ts";

export async function install(c: BoxCtx, first: boolean, tag?: string): Promise<number> {
  const { existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { readJson } = await import("../config.ts");
  type Installed = import("../config.ts").Installed;
  const { CANT_REACH, cantReach, install: run, Stop } = await import("../install.ts");
  const { linkTarget, updateUnfinished } = await import("../layout.ts");
  const { Log } = await import("../log.ts");
  const { stateNow } = await import("../ops.ts");
  const { AGENTS_THEN_UPDATE, footer } = await import("../state.ts");
  const { say, ask, tty } = c;
  const p = c.p;
  if (first && (c.uid !== 0 || typeof c.opts.bootstrap !== "string")) {
    say("Type sh ~/Downloads/taskbox-main/install.sh.");
    return 1;
  }
  const owner = c.env.SUDO_USER;
  if (!owner || owner === "root") {
    say("Type sh ~/Downloads/taskbox-main/install.sh as your admin user.");
    return 1;
  }
  const bootstrap = first ? (c.opts.bootstrap as string) : undefined;
  const configDir = first ? bootstrap! : p.app;
  const log = new Log();
  const before = existsSync(p.installed) ? readJson<Installed>(p.installed) : undefined;
  const folderBefore = linkTarget(p.opt) ?? p.opt;
  try {
    await run({ sys: c.deps.sys("/var/root"), paths: p, log, say, ask, chown: c.chown, owner, ownerHome: join("/Users", owner), workRoot: "/private/var/tmp", configDir, bootstrap, tty }, { first, tag });
  } catch (e) {
    const offline = !(e instanceof Stop) && cantReach(e);
    const why = e instanceof Stop ? e.message : offline ? CANT_REACH : log.redact((e as Error).message);
    say(why);
    // A step after the swap can fail too: then the new commit is already in place.
    const after = existsSync(p.installed) ? readJson<Installed>(p.installed) : undefined;
    // The same commit installed again gets a new folder, so the folder says whether it swapped.
    const swapped = after && (linkTarget(p.opt) ?? p.opt) !== folderBefore;
    const name = (i: Installed) => (i.tag ? `${i.tag}, #${i.pr} ${i.title}` : `#${i.pr} ${i.title}`);
    const keeps = swapped ? `Installed ${name(after)}, but a step after that failed.` : before ? `Not installed. The box keeps ${name(before)}.` : "Not installed.";
    // A taskbox.json that loadConfig refuses is the owner's own settings: the line names the field.
    const ownSettings = !(e instanceof Stop) && /^taskbox\.json/.test(why);
    if (ownSettings) say("Fix that in taskbox.json in your copy of taskbox, then run this again.");
    const next = (e instanceof Stop && e.owner) || offline || ownSettings ? "The step in the line above." : e instanceof Stop && /You typed/.test(why) ? "Nothing to do." : updateUnfinished(p) ? AGENTS_THEN_UPDATE : "Nothing to do: agents fix it.";
    for (const l of footer(await stateNow(c.ops), keeps, next)) say(l);
    return 1;
  }
  const now = readJson<Installed>(p.installed);
  for (const l of footer(await stateNow(c.ops), `Installed ${now.tag ? `${now.tag}, ` : ""}#${now.pr} ${now.title}.`, first ? `Log in as ${c.S}, then type taskbox status -w.` : "Nothing to do. The loop moves to it once the current job or download ends.")) say(l);
  return 0;
}

export const commands: CommandSpec[] = [
  {
    path: ["install"],
    summary: "The first install, from install.sh.",
    who: ["admin"],
    internal: true,
    options: [{ name: "--bootstrap", value: "FOLDER" }],
    // The settings are the downloaded folder's at the first install.
    namesFrom: (c) => (typeof c.opts.bootstrap === "string" ? c.opts.bootstrap : undefined),
    run: (c) => install(c, true),
  },
];
