// taskbox connect github on the controller: the owner's own browser makes and installs the box's
// Apps, as key rotate runner does (keys.ts). This controller makes one state per App and signs their
// hashes in connect begin; the guard opens the op and starts its child (connectbegin.ts); this
// controller reads the op's progress, makes each App the child asks for through the listener here
// (listen.ts), and gives the box GitHub's code with the App's state, which only it holds.
import { createHash, randomBytes } from "node:crypto";
import { EXIT } from "../command.ts";
import { parseAsk } from "../connectflow.ts";
import { serveOnce } from "../listen.ts";
import { parse } from "../command.ts";
import { registry } from "../registry.ts";
import { linksFor } from "./forward.ts";
import { type BoxLink, signedRun } from "./keys.ts";
import { type Deps, isStop } from "./reach.ts";
import { keySigner } from "./signer.ts";

export const POLL_MS = 3_000;
export const CONNECT_WAIT_MS = 60 * 60_000;

// Tests put their own browser and App maker here, as Deps.signerFor does the signer.
export interface ConnectHooks {
  makeApp?: (role: "runner" | "source", org: string, appName: string, state: string, out: (l: string) => void) => Promise<string | undefined>;
  open?: (url: string) => void;
}

const hash = (s: string) => createHash("sha256").update(s).digest("hex");

export async function connectFromController(d: Deps & ConnectHooks, argv: readonly string[], out: (l: string) => void): Promise<number> {
  const p = parse(registry(), argv);
  if (!p.ok) return (out(p.line), out(p.usage ?? "Type taskbox help."), EXIT.usage);
  if (p.flags.detach !== undefined || p.flags.timeout !== undefined) return (out("From the controller, connect github runs while your browser makes the Apps, so it takes no --detach or --timeout."), EXIT.usage);
  const sel = typeof p.flags.box === "string" ? p.flags.box : undefined;
  const links = await linksFor(d, sel, false);
  if (isStop(links)) return (out(links.stop), out(`Next: ${links.next}`), EXIT.failed);
  const box: BoxLink = links[0]!;
  const st = await box.run(["connect", "status", "--json"]);
  const org = typeof st?.result?.org === "string" ? st.result.org : undefined;
  if (!org) return (out(`${box.name} didn't say its org, so its Apps can't be made from here. Update taskbox on the box.`), EXIT.failed);
  const states = { runner: randomBytes(32).toString("hex"), source: randomBytes(32).toString("hex") };
  const opts: Record<string, string> = { runner: hash(states.runner), source: hash(states.source) };
  for (const k of ["jobs", "load", "group"]) if (typeof p.opts[k] === "string") opts[k] = p.opts[k] as string;
  const signer = d.signerFor && box.paired ? d.signerFor(box.paired, out) : keySigner({ run: d.run, home: d.home, uid: d.uid ?? -1, say: out });
  const flow = { signer, say: out, now: d.now, sleep: d.sleep };
  const a = await signedRun(flow, box, ["connect", "begin"], [], opts);
  if ("why" in a) return (out(`Not connected: ${a.why}`), EXIT.failed);
  const op = a.result?.op;
  if (a.exit !== 0 || typeof op !== "string") return (out(a.error?.message ?? `${box.name} started no connect.`), a.exit || EXIT.failed);
  out(`Connecting ${box.name} (${op}): your browser makes and installs what is missing. Ctrl-C stops watching; taskbox op cancel ${op} --box ${box.name} cancels it.`);
  const make = d.makeApp ?? makeApp;
  const open = d.open ?? ((url: string) => void d.run(["/usr/bin/open", url], { limitMs: 15_000, maxBytes: 4_000 }));
  const given = new Set<string>();
  let opened = "";
  const until = d.now() + CONNECT_WAIT_MS;
  // Counted as well as timed, so a clock that stands still never holds it.
  for (let polls = 0; d.now() < until && polls * POLL_MS < CONNECT_WAIT_MS; polls++) {
    const s = await box.run(["op", "show", op, "--json"]);
    const rec = s?.result?.op as Record<string, unknown> | undefined;
    if (rec && rec.state !== "running") {
      out(`The connect ${String(rec.state)}${typeof rec.why === "string" ? `: ${rec.why}` : "."}`);
      if (rec.state === "succeeded") out("Sign out of GitHub in that browser window if it isn't your own session.");
      return rec.state === "succeeded" ? EXIT.ok : EXIT.failed;
    }
    const ask = parseAsk((rec?.progress as Record<string, unknown> | undefined)?.text);
    const phase = typeof rec?.phase === "string" ? rec.phase : "";
    if (ask && "make" in ask && !given.has(`${phase}:${ask.make}`)) {
      const code = await make(ask.make, org, ask.name, states[ask.make], out);
      if (!code) return (out(`No ${ask.make} App was made. taskbox connect github --box ${box.name} finishes the connect.`), EXIT.failed);
      const g = await box.run(["connect", "code", op, "--state", states[ask.make], "--code", code, "--json"]);
      if (!g || g.exit !== 0) return (out(`${box.name} didn't take the code: ${g?.error?.message ?? "it can't be reached"}`), EXIT.failed);
      given.add(`${phase}:${ask.make}`);
    } else if (ask && "open" in ask && ask.open !== opened) {
      opened = ask.open;
      out(`Your browser opens ${ask.open}.`);
      open(ask.open);
    }
    await d.sleep(POLL_MS);
  }
  out(`Stopped watching. The connect carries on: taskbox op show ${op} -w --box ${box.name}.`);
  return EXIT.timeout;
}

// The App's page from this controller's browser, and GitHub's code back to the listener here.
function makeApp(role: "runner" | "source", org: string, appName: string, state: string, out: (l: string) => void): Promise<string | undefined> {
  out(`Your browser opens GitHub to make ${appName}: click Create GitHub App. You need to be an owner of ${org}.`);
  return new Promise((resolve) => {
    let done = false;
    const s = serveOnce({ role, org, appName, state, pageToken: randomBytes(32).toString("hex"), minutes: 60, open: true, watch: process.pid }, (e) => {
      if (done || "port" in e) return;
      done = true;
      s.stop();
      resolve("code" in e && e.state === state ? e.code : undefined);
    });
  });
}
