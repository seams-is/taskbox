// taskbox connect github and taskbox disconnect github at the box, as root through sudo, never over
// SSH. The listener and the browser run as the admin who typed it; root never parses HTTP.
import type { BoxCtx, CommandSpec } from "../command.ts";
import { overSsh } from "../cmdkit.ts";

const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;

async function connect(c: BoxCtx, which: "connect" | "disconnect"): Promise<number> {
  const { hostname } = await import("node:os");
  const { randomBytes } = await import("node:crypto");
  const { join, dirname } = await import("node:path");
  const { loadConfig } = await import("../config.ts");
  const flow = await import("../connectflow.ts");
  const { uidOf } = await import("../accounts.ts");
  const { isAdmin, SUDO } = await import("../elevate.ts");
  const { BROKER_ACCOUNT, brokerPathsOf } = await import("../keys.ts");
  const { rootStateOf } = await import("../core/paths.ts");
  const { bootId } = await import("../core/boot.ts");
  const { Log } = await import("../log.ts");
  const { say, env } = c;
  if (await overSsh(c)) {
    say(`taskbox ${which} github runs at the box only, in Terminal, as your admin user: it opens a browser there. Over Screen Sharing is fine.`);
    return 1;
  }
  const sys = c.ops.sys;
  const adminName = env.SUDO_USER ?? "";
  const adminUid = Number(env.SUDO_UID);
  const checked = /^[A-Za-z_][A-Za-z0-9._-]{0,31}$/.test(adminName) && Number.isInteger(adminUid) && (await uidOf(sys, adminName)) === adminUid && (await isAdmin(sys, adminName));
  if (!checked) return (say(`Run taskbox ${which} github as your admin user.`), 1);
  const gh = await uidOf(sys, BROKER_ACCOUNT);
  const gid = await sys.run("/usr/bin/id", ["-g", BROKER_ACCOUNT], { timeoutMs: 10_000 }).then((r) => (r.code === 0 ? Number(r.stdout.trim()) : Number.NaN), () => Number.NaN);
  if (gh === undefined || !Number.isInteger(gid)) return (say(`The GitHub key keeper's account, ${BROKER_ACCOUNT}, isn't on this Mac. As your admin user, type taskbox update first.`), 1);
  const cfg = loadConfig(c.p.app, c.p.boxSettings);
  const state = rootStateOf(c.p);
  const keys = { dir: brokerPathsOf(c.p).keys, ownerUid: gh, ownerGid: gid };
  const log = new Log();
  const base = { sys, log, cfg, boxFile: c.p.boxSettings, pendingFile: join(dirname(c.p.boxSettings), "connect-pending.json"), keys, chown: c.chown, say };
  const quiet = { ...base, event: () => {} };
  if (which === "disconnect") return flow.disconnectGithub(quiet);
  const boot = await bootId(sys);
  if (!boot) return (say("This boot's identity can't be read, so the connect can't be recorded. Nothing changed."), 1);
  const load = c.opts.load === "off" ? ("off" as const) : typeof c.opts.load === "string" ? { name: c.opts.load, role: "load" as const, runnerGroup: c.opts.group as string } : undefined;
  const jobs = typeof c.opts.jobs === "string" ? c.opts.jobs : undefined;
  const opened = await flow.openConnectOp({ ops: { dir: state.ops, owner: 0, chown: c.chown }, now: sys.now(), boot, actor: `admin ${adminName}`, params: { ...(jobs ? { jobs } : {}), ...(load ? { load: load === "off" ? "off" : load.name } : {}) } });
  if ("why" in opened) return (say(opened.why), 1);
  const { op, send } = opened;
  let listener: { kill(): void } | undefined;
  process.on("SIGINT", () => {
    listener?.kill();
    try {
      send({ end: { state: "failed", why: "stopped at the box with Ctrl-C" } });
    } catch {}
    say("Stopped. An App made already is kept for the next taskbox connect github, which finishes it.");
    process.exit(130);
  });
  const asAdmin = (args: string[]) => ["asuser", String(adminUid), SUDO, "-u", adminName, "--", ...args];
  const deps: import("../connectflow.ts").FlowDeps = {
    ...base,
    box: (c.deps.hostname?.() ?? hostname()).split(".")[0]!.toLowerCase(),
    since: op.startedAt,
    phase: (p, a) => send({ phase: p, ...(a ? { progress: { text: flow.askText(a).slice(0, 120) } } : {}) }),
    event: (type, text, data) => send({ event: { type, text: text.slice(0, 240), ...(data ? { data } : {}) } }),
    open: (url) => void sys.run("/bin/launchctl", asAdmin(["/usr/bin/open", url]), { timeoutMs: 15_000 }),
    code: (role, appName, st) =>
      new Promise((resolve) => {
        const setup = { role, org: cfg.org, appName, state: st, pageToken: randomBytes(32).toString("hex"), minutes: 60, open: true };
        let done = false;
        const finish = (g: import("../connectflow.ts").CodeGot) => {
          if (done) return;
          done = true;
          listener?.kill();
          resolve(g);
        };
        // In the admin's own session (launchctl asuser), as the admin, so the page reaches their screen.
        const proc = sys.spawn("/bin/launchctl", asAdmin(["/opt/taskbox/bin/bun", "--no-install", "--no-env-file", "--cwd=/", "--config=/opt/taskbox/app/bunfig.run.toml", "/opt/taskbox/app/src/listen.ts"]), {
          stdin: `${JSON.stringify(setup)}\n`,
          onLine: (l) => {
            try {
              const e = JSON.parse(l) as Record<string, unknown>;
              if (Number.isInteger(e.port)) say(`If the browser doesn't open, open http://127.0.0.1:${e.port}/start/... from the file taskbox opened, or type taskbox connect github again.`);
              else if (typeof e.code === "string" && e.state === st) finish({ code: e.code });
              else if (e.timeout === true) finish({ stop: "No App was made within the hour. Nothing changed. Type taskbox connect github to start again." });
            } catch {}
          },
        });
        // SIGTERM, which sudo passes on to the listener.
        listener = { kill: () => void (proc.pid ? process.kill(proc.pid, "SIGTERM") : undefined) };
        void proc.exited?.then(() => finish({ stop: "taskbox's page for GitHub stopped before GitHub sent the App back. Type taskbox connect github to try again." }));
      }),
  };
  let exit = 1;
  try {
    exit = await flow.connectGithub(deps, { ...(jobs ? { jobs } : {}), ...(load ? { load } : {}) });
  } finally {
    send({ end: exit === 0 ? { state: "succeeded" } : { state: "failed", why: "an App couldn't be made true; the command said why" } });
  }
  if (exit === 0) say("Sign out of GitHub in that browser window now: your picture, top right, Sign out.");
  return exit;
}

export const commands: CommandSpec[] = [
  {
    path: ["connect", "github"],
    summary: "Makes the box's two GitHub Apps true: makes, asks for rights or repos, installs, proves, keeps.",
    who: ["owner", "admin"],
    root: true,
    did: "Ran connect github.",
    options: [
      { name: "--jobs", value: "REPO", check: (v) => REPO.test(v) },
      { name: "--load", value: "REPO", check: (v) => v === "off" || REPO.test(v) },
      { name: "--group", value: "NAME", check: (v) => /^[\x20-\x7e]{1,64}$/.test(v) },
    ],
    check: ({ opts }) => {
      const load = opts.load;
      const group = opts.group !== undefined;
      if (load === "off" && group) return "--load off takes no --group.";
      if (typeof load === "string" && load !== "off" && !group) return "--load needs the test repo's runner group: --load ORG/REPO --group NAME.";
      if (group && load === undefined) return "--group goes with --load ORG/REPO.";
      return undefined;
    },
    run: (c) => connect(c, "connect"),
  },
  { path: ["disconnect", "github"], summary: "Uninstalls the job source App, keeps none as the source, and deletes its key.", who: ["owner", "admin"], root: true, did: "Ran disconnect github.", run: (c) => connect(c, "disconnect") },
];
