// taskbox connect github and taskbox disconnect github. At the box, as root
// through sudo, never over SSH. The listener and the browser run as the admin who typed it.
import type { BoxCtx, CommandSpec } from "../command.ts";
import { overSsh } from "../cmdkit.ts";

const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;

async function connect(c: BoxCtx, which: "connect" | "disconnect"): Promise<number> {
  const { join } = await import("node:path");
  const { loadConfig } = await import("../config.ts");
  const { connectGithub, disconnectGithub } = await import("../connectflow.ts");
  type ConnectDeps = import("../connectflow.ts").ConnectDeps;
  const { uidOf } = await import("../accounts.ts");
  const { isAdmin, SUDO } = await import("../elevate.ts");
  const { Log } = await import("../log.ts");
  const { say, ask, env } = c;
  const cu = c.cu;
  if (await overSsh(c)) {
    say(`taskbox ${which} github runs at the box only, in Terminal, as your admin user: it opens a browser there. Over Screen Sharing is fine.`);
    return 1;
  }
  const adminName = env.SUDO_USER ?? "";
  const adminUid = Number(env.SUDO_UID);
  const checked = /^[A-Za-z_][A-Za-z0-9._-]{0,31}$/.test(adminName) && Number.isInteger(adminUid) && (await uidOf(c.ops.sys, adminName)) === adminUid && (await isAdmin(c.ops.sys, adminName));
  if (!checked || cu === undefined) {
    say(cu === undefined ? `${c.S}, the service account, isn't on this Mac. As your admin user, type taskbox update first.` : `Run taskbox ${which} github as your admin user.`);
    return 1;
  }
  const cfg = loadConfig(c.p.app, c.p.boxSettings);
  let made: string[] = [];
  let listener: { kill(): void } | undefined;
  process.on("SIGINT", () => {
    listener?.kill();
    for (const l of made.length ? made : ["Stopped. Nothing changed. Close the GitHub tab in the browser."]) say(l);
    process.exit(130);
  });
  const sys = c.ops.sys;
  const deps: ConnectDeps = {
    sys,
    log: new Log(),
    paths: c.p,
    cfg,
    say,
    ask,
    chown: c.chown,
    serviceUid: cu,
    admin: { name: adminName, uid: adminUid, home: join("/Users", adminName) },
    listen: (setup, onEvent) => {
      // In the admin's own session (launchctl asuser), as the admin, so the page it opens reaches
      // their screen and root never parses HTTP.
      const proc = sys.spawn("/bin/launchctl", ["asuser", String(adminUid), SUDO, "-u", adminName, "--", "/opt/taskbox/bin/bun", "--no-install", "--no-env-file", "--cwd=/", "--config=/opt/taskbox/app/bunfig.run.toml", "/opt/taskbox/app/src/listen.ts"], {
        stdin: `${JSON.stringify(setup)}\n`,
        onLine: (l) => {
          try {
            const e = JSON.parse(l) as Record<string, unknown>;
            if (Number.isInteger(e.port) && (e.port as number) > 0 && (e.port as number) < 65536) onEvent({ port: e.port as number });
            else if (typeof e.code === "string" && typeof e.state === "string") onEvent({ code: e.code, state: e.state });
            else if (e.timeout === true) onEvent({ timeout: true });
          } catch {}
        },
      });
      // SIGTERM, which sudo passes on to the listener; SIGKILL would end sudo alone.
      const stop = () => {
        try {
          if (proc.pid) process.kill(proc.pid, "SIGTERM");
        } catch {}
      };
      listener = { kill: stop };
      return { kill: stop, exited: proc.exited };
    },
    open: (url) => {
      void sys.run("/bin/launchctl", ["asuser", String(adminUid), SUDO, "-u", adminName, "--", "/usr/bin/open", url], { timeoutMs: 15_000 });
    },
    onMade: (lines) => {
      made = lines;
    },
  };
  if (which === "disconnect") return disconnectGithub(deps);
  const load = c.opts.load;
  if (load === "off") return connectGithub(deps, { load: "off" });
  if (typeof load === "string") return connectGithub(deps, { load: { name: load, role: "load", runnerGroup: c.opts.group as string } });
  return connectGithub(deps, { newKey: c.opts["new-key"] === true });
}

export const commands: CommandSpec[] = [
  {
    path: ["connect", "github"],
    summary: "Makes the box's GitHub Apps true: makes, asks for rights, installs, proves. At the box.",
    who: ["admin"],
    root: true,
    did: "Ran connect github.",
    options: [
      { name: "--new-key" },
      { name: "--load", value: "REPO", check: (v) => v === "off" || REPO.test(v) },
      { name: "--group", value: "NAME", check: (v) => /^[\x20-\x7e]{1,64}$/.test(v) },
    ],
    check: ({ opts }) => {
      const load = opts.load;
      const group = opts.group !== undefined;
      if (opts["new-key"] && (load !== undefined || group)) return "--new-key goes alone: taskbox connect github --new-key.";
      if (load === "off" && group) return "--load off takes no --group.";
      if (typeof load === "string" && load !== "off" && !group) return "--load needs the test repo's runner group: --load ORG/REPO --group NAME.";
      if (group && load === undefined) return "--group goes with --load ORG/REPO.";
      return undefined;
    },
    run: (c) => connect(c, "connect"),
  },
  { path: ["disconnect", "github"], summary: "Uninstalls the job source's App and deletes its key. At the box.", who: ["admin"], root: true, did: "Ran disconnect github.", run: (c) => connect(c, "disconnect") },
];
