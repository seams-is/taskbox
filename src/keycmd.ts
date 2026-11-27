// The key commands at the box: key list (anyone), and as an admin through sudo, key rotate runner,
// source and tailscale, key trust approver and key reset approver; taskbox confirm answers a rotated
// or second approver key (confirmapply.ts). From the controller, key rotate comes signed, and the
// cli sends it to the guard (handlers/keys.ts).
import { createHash, createPublicKey } from "node:crypto";
import { lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AtBox } from "./approverkeys.ts";
import type { BoxCtx, ErrorBody, Outcome } from "./command.ts";
import { EXIT } from "./command.ts";
import type { AppRole } from "./connect.ts";
import { eventLog } from "./core/events.ts";
import { listOps } from "./core/ops.ts";
import { rootStateOf } from "./core/paths.ts";
import { readApprovers } from "./core/approvers.ts";
import { ROTATE, type Which, WHICH } from "./optypes/keys.ts";

const err = (code: ErrorBody["code"], message: string): ErrorBody => ({ code, message, fix: null, who: "at-the-box" });
const fail = (c: BoxCtx, line: string, code: ErrorBody["code"] = "failed"): Outcome => (c.say(line), { exit: code === "usage" ? EXIT.usage : EXIT.failed, error: err(code, line) });

// The admin who typed it through sudo, checked against the system, or undefined.
async function adminOf(c: BoxCtx): Promise<{ name: string; uid: number } | undefined> {
  const { uidOf } = await import("./accounts.ts");
  const { isAdmin } = await import("./elevate.ts");
  const name = c.env.SUDO_USER ?? "";
  const uid = Number(c.env.SUDO_UID);
  const ok = c.uid === 0 && /^[A-Za-z_][A-Za-z0-9._-]{0,31}$/.test(name) && Number.isInteger(uid) && (await uidOf(c.ops.sys, name)) === uid && (await isAdmin(c.ops.sys, name));
  return ok ? { name, uid } : undefined;
}

async function atBoxDeps(c: BoxCtx, admin: string): Promise<AtBox> {
  const state = rootStateOf(c.p);
  const rootUid = c.deps.rootUid ?? 0;
  return { sys: c.ops.sys, state, rootUid, chown: c.chown, events: eventLog("guard", { dir: state.events, owner: rootUid, chown: c.chown }, c.ops.sys), say: c.say, ask: c.ask, yes: c.flags.yes !== undefined, admin };
}

// Each command here that changes a key runs at the box only, as an admin.
type Admin = { admin: { name: string; uid: number } };
async function gate(c: BoxCtx, what: string): Promise<Admin | { out: Outcome }> {
  const { overSsh } = await import("./cmdkit.ts");
  if (await overSsh(c)) return { out: fail(c, `taskbox ${what} runs at the box only, as your admin user: the box's own screen is what you check.`, "refused-over-ssh") };
  const a = await adminOf(c);
  return a ? { admin: a } : { out: fail(c, `Run taskbox ${what} at the box as your admin user.`, "denied") };
}

export async function keyTrust(c: BoxCtx): Promise<Outcome> {
  const g = await gate(c, "key trust approver");
  if ("out" in g) return g.out;
  const a = g.admin;
  const { trustApprover } = await import("./approverkeys.ts");
  const code = await trustApprover(await atBoxDeps(c, a.name));
  return { exit: code, changed: code === 0, did: code === 0 ? "Pinned the approver key." : "Nothing changed." };
}

export async function keyReset(c: BoxCtx): Promise<Outcome> {
  const g = await gate(c, "key reset approver");
  if ("out" in g) return g.out;
  const a = g.admin;
  const { resetApprover } = await import("./approverkeys.ts");
  const code = await resetApprover(await atBoxDeps(c, a.name));
  return { exit: code, changed: code === 0, did: code === 0 ? "Cleared the approver keys." : "Nothing changed." };
}

// ---- key rotate at the box ----
export async function keyRotate(c: BoxCtx): Promise<Outcome> {
  const which = c.args[0] as Which;
  if (!WHICH.includes(which)) return fail(c, "key rotate takes one of runner, source, approver and tailscale.", "usage");
  if (which === "approver") return fail(c, "key rotate approver runs on the controller that holds the approver key: there, taskbox key rotate approver. Each box then shows the new key at taskbox confirm.", "denied");
  if (c.opts.state !== undefined || c.opts.seal !== undefined || c.opts.new !== undefined) return fail(c, "--state, --seal and --new are the controller's, for a signed key rotate.", "usage");
  const g = await gate(c, `key rotate ${which}`);
  if ("out" in g) return g.out;
  const a = g.admin;
  if (c.flags.detach !== undefined) return fail(c, "At the box the rotation runs in this terminal, so --detach isn't taken here. From the controller it detaches.", "usage");
  const { bootId } = await import("./core/boot.ts");
  const { openAtBox, opReader, recorded } = await import("./keyops.ts");
  const sys = c.ops.sys;
  const state = rootStateOf(c.p);
  const ops = { dir: state.ops, owner: c.deps.rootUid ?? 0, chown: c.chown };
  const boot = await bootId(sys);
  if (!boot) return fail(c, "This boot's identity can't be read, so the rotation can't be recorded. Nothing changed.");
  const opened = openAtBox({ ops, which, now: sys.now(), boot, actor: `admin ${a.name}`, params: { from: "box" } });
  if ("why" in opened) return fail(c, opened.why, "busy");
  const { op, send } = opened;
  const read = opReader(ops, op.id);
  const live = () => read()?.state === "running";
  c.say(`Rotating the ${which} key (${op.id}). The old key works until the new one is proved. taskbox op cancel ${op.id} ${which === "tailscale" ? "before reconnecting" : "before switching"} stops it.`);
  process.on("SIGINT", () => {
    try {
      send({ end: { state: "failed", why: "stopped at the box with Ctrl-C" } });
    } catch {}
    c.say(which === "tailscale" ? "Stopped. If Tailscale waits for a sign-in, type taskbox key rotate tailscale again." : "Stopped. The old key is still in use; a new App made already is finished by the next taskbox key rotate.");
    process.exit(130);
  });
  const phase = (ph: string, text?: string) => send({ phase: ph, ...(text ? { progress: { text: text.slice(0, 120) } } : {}) });
  const event = (type: string, text: string, data?: Record<string, string | number | boolean>) => send({ event: { type, text: text.slice(0, 240), ...(data ? { data } : {}) } });
  let exit = 1;
  try {
    if (which === "tailscale") {
      const { draftTailscale, followTailscale, tailnetPinPath } = await import("./tsrotate.ts");
      const { loadConfig, tagOf } = await import("./config.ts");
      const cfg = loadConfig(c.p.app, c.p.boxSettings);
      const d = { sys, tailscale: c.p.tailscale, socket: c.p.tailscaleSocket, tag: tagOf(cfg), hostname: cfg.runnerNamePrefix, pinFile: tailnetPinPath(state.dir), chown: c.chown, say: c.say, phase, event, live };
      const r = await draftTailscale(d);
      if ("why" in r) c.say(`Not rotated: ${r.why}.`);
      else {
        // The link is said here, on the admin's own terminal, and nowhere else.
        c.say("Open this link in a browser signed in to your Tailscale account, and approve the box. Whoever opens it first takes the box, so open it now and share it with nobody:");
        c.say(`  ${r.url}`);
        exit = await followTailscale(d, r.node);
      }
    } else exit = await rotateAtBox(c, which, a, { op: op.id, since: op.startedAt, deadline: op.deadline!, live, phase, event, confirmSwitching: () => recorded({ sys, read }, "switching") });
  } finally {
    if (live()) send({ end: exit === 0 ? { state: "succeeded" } : { state: "failed", why: "the rotation stopped; the command said why" } });
  }
  return { exit, changed: exit === 0, did: exit === 0 ? `Rotated the ${which} key.` : "The old key is still in use." };
}

async function rotateAtBox(c: BoxCtx, role: AppRole, admin: { name: string; uid: number }, o: { op: string; since: number; deadline: number; live(): boolean; phase(p: string, t?: string): void; event(t: string, x: string, d?: Record<string, string | number | boolean>): void; confirmSwitching(): Promise<void> }): Promise<number> {
  const { hostname } = await import("node:os");
  const { randomBytes } = await import("node:crypto");
  const { loadConfig } = await import("./config.ts");
  const { uidOf } = await import("./accounts.ts");
  const { SUDO } = await import("./elevate.ts");
  const { BROKER_ACCOUNT, brokerPathsOf } = await import("./keys.ts");
  const { Log } = await import("./log.ts");
  const { rotateApp, retiredPath } = await import("./keyrotate.ts");
  const sys = c.ops.sys;
  const gh = await uidOf(sys, BROKER_ACCOUNT);
  const gid = await sys.run("/usr/bin/id", ["-g", BROKER_ACCOUNT], { timeoutMs: 10_000 }).then((r) => (r.code === 0 ? Number(r.stdout.trim()) : Number.NaN), () => Number.NaN);
  if (gh === undefined || !Number.isInteger(gid)) return (c.say(`The GitHub key keeper's account, ${BROKER_ACCOUNT}, isn't on this Mac. As your admin user, type taskbox update first.`), 1);
  const cfg = loadConfig(c.p.app, c.p.boxSettings);
  const state = rootStateOf(c.p);
  const asAdmin = (args: string[]) => ["asuser", String(admin.uid), SUDO, "-u", admin.name, "--", ...args];
  let listener: { kill(): void } | undefined;
  const exit = await rotateApp(
    {
      sys,
      log: new Log(),
      cfg,
      box: (c.deps.hostname?.() ?? hostname()).split(".")[0]!.toLowerCase(),
      boxFile: c.p.boxSettings,
      pendingFile: join(dirname(c.p.boxSettings), "connect-pending.json"),
      retiredFile: retiredPath(state.dir),
      keys: { dir: brokerPathsOf(c.p).keys, ownerUid: gh, ownerGid: gid },
      chown: c.chown,
      since: o.since,
      live: o.live,
      op: o.op,
      confirmSwitching: o.confirmSwitching,
      say: c.say,
      phase: o.phase,
      event: o.event,
      open: (url) => void sys.run("/bin/launchctl", asAdmin(["/usr/bin/open", url]), { timeoutMs: 15_000 }),
      // The new App's page and its code come through connect's listener, in the admin's own session.
      code: (r, appName, st) =>
        new Promise((resolve) => {
          const minutes = Math.max(1, Math.min(60, Math.floor((o.deadline - sys.now()) / 60_000)));
          const setup = { role: r, org: cfg.org, appName, state: st, pageToken: randomBytes(32).toString("hex"), minutes, open: true, watch: process.pid };
          let done = false;
          const finish = (g: { code: string } | { stop: string }) => {
            if (done) return;
            done = true;
            stopWatch();
            listener?.kill();
            resolve(g);
          };
          const stopWatch = sys.every(2000, () => (o.live() ? undefined : finish({ stop: "The rotation ended (its deadline, or op cancel)." })));
          const proc = sys.spawn("/bin/launchctl", asAdmin(["/opt/taskbox/bin/bun", "--no-install", "--no-env-file", "--cwd=/", "--config=/opt/taskbox/app/bunfig.run.toml", "/opt/taskbox/app/src/cli.ts", "connect", "listen"]), {
            stdin: `${JSON.stringify(setup)}\n`,
            onLine: (l) => {
              try {
                const e = JSON.parse(l) as Record<string, unknown>;
                if (Number.isInteger(e.port)) c.say("If the browser doesn't open, type taskbox key rotate again.");
                else if (typeof e.code === "string" && e.state === st) finish({ code: e.code });
                else if (e.timeout === true) finish({ stop: "No App was made in time. The old App is still in use." });
              } catch {}
            },
          });
          listener = { kill: () => void (proc.pid ? process.kill(proc.pid, "SIGTERM") : undefined) };
          void proc.exited?.then(() => finish({ stop: "taskbox's page for GitHub stopped before GitHub sent the App back. The old App is still in use." }));
        }),
    },
    role,
  );
  if (exit === 0) c.say("Sign out of GitHub in that browser window now: your picture, top right, Sign out.");
  return exit;
}

// key add approver, unsigned, at the box: it is the owner's, from a paired controller.
export async function keyAddHere(c: BoxCtx): Promise<Outcome> {
  return fail(c, "key add approver is signed from a paired controller: there, taskbox key add approver --box NAME. The box then shows the new key at taskbox confirm.", "denied");
}

// key code OP --state S --code C: the request in the agent spool, answered by the guard.
export async function keyCode(c: BoxCtx): Promise<Outcome> {
  if (typeof c.opts.state !== "string" || typeof c.opts.code !== "string") return fail(c, "key code takes --state and --code.", "usage");
  return spoolAsk(c, (await import("./keyrotate.ts")).KEY_CODE, { op: c.args[0]!, state: c.opts.state, code: c.opts.code });
}

async function spoolAsk(c: BoxCtx, kind: string, body: Record<string, unknown>): Promise<Outcome> {
  const { ask, askDeps } = await import("./core/asker.ts");
  const r = await ask(askDeps(c.root, c.uid, c.ops.sys, c.deps.rootUid), kind, body);
  if ("no" in r) return fail(c, r.no);
  if (!r.outcome) return fail(c, `The box's guard hasn't answered the ${kind} request (${r.id}). taskbox check says why.`);
  c.say(r.outcome.said);
  return r.outcome.ok ? { exit: EXIT.ok, changed: true, result: { request: r.id } } : { exit: EXIT.failed, error: err(r.outcome.code ?? "failed", r.outcome.said) };
}

// key offer approver --key B64: the request in the agent spool, answered by the guard.
export async function keyOffer(c: BoxCtx): Promise<Outcome> {
  if (typeof c.opts.key !== "string") return fail(c, "key offer approver takes --key, the key's base64.", "usage");
  return spoolAsk(c, (await import("./approverkeys.ts")).OFFER_KIND, { key: c.opts.key });
}

// ---- key list ----
export type KeyRow = { key: Which; fingerprint?: string; app?: number; slug?: string; ageDays?: number; pinned?: number; rotation?: string; note?: string; offered?: string };

// The fingerprint GitHub shows for an App key: SHA-256 of its public half, in base64.
export function appKeyFingerprint(pem: string): string | undefined {
  try {
    const der = createPublicKey(pem).export({ type: "spki", format: "der" });
    return `SHA256:${createHash("sha256").update(der).digest("base64").replace(/=+$/, "")}`;
  } catch {
    return undefined;
  }
}

export async function keyRows(c: Pick<BoxCtx, "p" | "deps" | "ops" | "uid">): Promise<KeyRow[]> {
  const { loadConfig } = await import("./config.ts");
  const { keptApp } = await import("./connectflow.ts");
  const { brokerPathsOf, keyFileName, readHeldKey } = await import("./keys.ts");
  const { readTailnetPin, tailnetPinPath } = await import("./tsrotate.ts");
  const rootUid = c.deps.rootUid ?? 0;
  const state = rootStateOf(c.p);
  const now = c.ops.sys.now();
  const cfg = loadConfig(c.p.app, c.p.boxSettings);
  const running = listOps({ dir: state.ops, owner: rootUid }).ops.filter((o) => o.state === "running");
  const rotation = (w: Which) => running.find((o) => o.type === ROTATE[w])?.id;
  const days = (ms: number) => Math.max(0, Math.floor((now - ms) / 86_400_000));
  const rows: KeyRow[] = [];
  const keys = brokerPathsOf(c.p).keys;
  for (const role of ["runner", "source"] as const) {
    const k = keptApp(cfg, role);
    const r: KeyRow = { key: role, ...(k ? { app: k.appId } : {}), ...(k?.slug ? { slug: k.slug } : {}) };
    if (k) {
      try {
        r.ageDays = days(lstatSync(join(keys, keyFileName(role, k.appId))).mtimeMs);
      } catch {}
      // Only the keeper and root read the key; root shows its fingerprint.
      if (c.uid === 0) {
        let owner = -1;
        try {
          owner = lstatSync(keys).uid;
        } catch {}
        const pem = owner >= 0 ? readHeldKey(keys, owner, role, k.appId) : undefined;
        const fp = pem ? appKeyFingerprint(pem) : undefined;
        if (fp) r.fingerprint = fp;
      }
    } else r.note = "none yet: taskbox connect github";
    const op = rotation(role);
    if (op) r.rotation = op;
    rows.push(r);
  }
  const a = readApprovers(state.approvers, rootUid);
  if (a.kind === "ok" && a.value.keys.length) {
    for (const k of a.value.keys) rows.push({ key: "approver", fingerprint: k.fingerprint, ageDays: days(k.pinnedAt), pinned: k.gen, ...(rotation("approver") ? { rotation: rotation("approver")! } : {}) });
  } else rows.push({ key: "approver", note: a.kind === "bad" ? `approvers.json can't be read (${a.why})` : "none pinned: at the box, taskbox key trust approver" });
  const { readOffer } = await import("./approverkeys.ts");
  const { fingerprint } = await import("./approver.ts");
  const offer = readOffer(state, rootUid, now);
  // A controller's offer, for a paired controller to approve: its base64 is public, as any key's.
  if (offer) rows.push({ key: "approver", fingerprint: fingerprint(offer.key), offered: offer.key.split(" ")[1]!, note: "offered by a controller, not pinned: a paired controller approves it with taskbox key add approver" });
  const tn = readTailnetPin(tailnetPinPath(state.dir), rootUid);
  rows.push({ key: "tailscale", ...(tn ? { note: `pinned to its tailnet` } : { note: "its tailnet is pinned at the first rotation" }), ...(rotation("tailscale") ? { rotation: rotation("tailscale")! } : {}) });
  return rows;
}

export function keyLines(rows: KeyRow[]): string[] {
  return rows.map((r) => {
    const parts = [r.key.padEnd(9)];
    if (r.slug || r.app) parts.push(`${r.slug ?? "App"}${r.app ? ` (App ${r.app})` : ""}`);
    if (r.fingerprint) parts.push(r.fingerprint);
    if (r.ageDays !== undefined) parts.push(`${r.ageDays} day${r.ageDays === 1 ? "" : "s"} old`);
    if (r.note) parts.push(r.note);
    if (r.rotation) parts.push(`rotation: in progress (${r.rotation})`);
    return parts.join("  ");
  });
}

export async function keyList(c: BoxCtx): Promise<Outcome> {
  const rows = await keyRows(c);
  for (const l of keyLines(rows)) c.say(l);
  return { exit: EXIT.ok, result: { keys: rows } };
}

