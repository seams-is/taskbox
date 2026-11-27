// The controller's key commands, run here before anything is forwarded: key rotate WHICH and key add
// approver make what the box needs (a new approver key, a sealing key, a state) and sign it, so the
// owner types no key material. The flows themselves are keys.ts's; this file joins them to this
// controller's pairings (forward.ts linksFor), its signer and its browser.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXIT } from "../command.ts";
import { serveOnce } from "../listen.ts";
import { cutBox, linksFor } from "./forward.ts";
import { type Deps, isStop } from "./reach.ts";
import { KEY_LABEL, keySigner, makeKey, SC_AUTH, signingKey } from "./signer.ts";
import { approveSecond, type BoxLink, type Deps as FlowDeps, offerAndWait, rotateApprover, rotateAppKey, rotateTailscale } from "./keys.ts";
import type { Home } from "./home.ts";

export const isKeyFlow = (argv: readonly string[]) => argv[0] === "key" && (argv[1] === "rotate" || argv[1] === "add");

// Tests and the v4.0.0 app put their own browser and key maker here, as Deps.signerFor does the signer.
export interface KeyHooks {
  makeApp?: typeof makeApp;
  open?: (url: string) => void;
  makeNewKey?: (home: Home, label: string) => Promise<{ key: string } | { why: string }>;
}
const hooks = (d: Deps) => d as Deps & KeyHooks;
const flowDeps = (d: Deps, out: (l: string) => void, box?: BoxLink): FlowDeps => ({
  signer: d.signerFor && box?.paired ? d.signerFor(box.paired, out) : keySigner({ run: d.run, home: d.home, uid: d.uid ?? -1, say: out }),
  say: out,
  now: d.now,
  sleep: d.sleep,
});
const openUrl = (d: Deps) => hooks(d).open ?? ((url: string) => void d.run(["/usr/bin/open", url], { limitMs: 15_000, maxBytes: 4_000 }));

// The next key's folder, beside the approver folder, kept until every box pins the new key.
const nextHome = (h: Home): Home => ({ ...h, approver: `${h.approver}-next` });
const labelOf = (dir: string) => {
  try {
    return readFileSync(join(dir, "label"), "utf8").trim() || KEY_LABEL;
  } catch {
    return KEY_LABEL;
  }
};

export async function keyMain(d: Deps, argv: readonly string[], io: { out: (l: string) => void }): Promise<number> {
  const cut = cutBox(argv);
  if ("no" in cut) return (io.out(cut.no), EXIT.usage);
  const [, verb, which, ...extra] = cut.rest;
  if (extra.length) return (io.out(`taskbox key ${verb} ${which ?? ""} takes nothing more here: this controller makes what the box needs.`), EXIT.usage);
  if (verb === "add" && which !== "approver") return (io.out("taskbox key add takes approver."), EXIT.usage);
  if (verb === "rotate" && !["runner", "source", "approver", "tailscale"].includes(which ?? "")) return (io.out("taskbox key rotate takes runner, source, approver or tailscale."), EXIT.usage);
  const all = verb === "rotate" && which === "approver";
  const links = await linksFor(d, all && cut.sel === undefined ? "all" : cut.sel, all);
  if (isStop(links)) return (io.out(links.stop), io.out(links.next), EXIT.failed);
  if (verb === "add") return (await approveSecond({ ...flowDeps(d, io.out, links[0]), box: links[0]! })) ? EXIT.ok : EXIT.failed;
  if (which === "approver") return rotateHere(d, links, io.out);
  if (which === "tailscale") {
    const r = await rotateTailscale({ ...flowDeps(d, io.out, links[0]), box: links[0]!, open: openUrl(d) });
    return "why" in r ? (io.out(`Not rotated: ${r.why}.`), EXIT.failed) : EXIT.ok;
  }
  const box = links[0]!;
  const list = await box.run(["key", "list", "--json"]);
  const org = typeof list?.result?.org === "string" ? list.result.org : undefined;
  if (!org) return (io.out(`${box.name} didn't say its org, so the new App can't be made from here. At the box: taskbox key rotate ${which}.`), EXIT.failed);
  const make = hooks(d).makeApp ?? makeApp;
  const ok = await rotateAppKey({ ...flowDeps(d, io.out, box), box, role: which as "runner" | "source", open: openUrl(d), make: (role, appName, state) => make(role, org, appName, state, io.out) });
  return ok ? EXIT.ok : EXIT.failed;
}

// The new App's page from this controller's browser, and GitHub's code back to the listener here.
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

// key rotate approver: a new key under the other Secure Enclave label, signed in on each box by the
// current one. Run again, it carries on with the same new key; once no box pins the old key, the
// new one becomes this controller's approver key and the old identity is deleted.
async function rotateHere(d: Deps, links: BoxLink[], out: (l: string) => void): Promise<number> {
  const next = nextHome(d.home);
  const label = labelOf(d.home.approver) === KEY_LABEL ? `${KEY_LABEL}-next` : KEY_LABEL;
  const cur = signingKey(d.home, d.uid ?? -1);
  if ("why" in cur) return (out(cur.why), EXIT.failed);
  const r = await rotateApprover({
    ...flowDeps(d, out, links[0]),
    boxes: links,
    makeNew: async () => {
      const k = hooks(d).makeNewKey ? await hooks(d).makeNewKey!(next, label) : await makeKey({ run: d.run, home: next, uid: d.uid ?? -1, say: out, ask: d.ask, tty: d.tty, label });
      if ("why" in k) return k;
      mkdirSync(next.approver, { recursive: true, mode: 0o700 });
      writeFileSync(join(next.approver, "label"), `${label}\n`, { mode: 0o600 });
      return { key: k.key };
    },
  });
  if (!r.key) return EXIT.failed;
  if (r.boxes.some((b) => b.state !== "pinned")) {
    out("This controller keeps signing with the old key until every box pins the new one. Once each box is confirmed, type taskbox key rotate approver again to finish.");
    return r.boxes.some((b) => b.state === "refused" || b.state === "offline") ? EXIT.failed : EXIT.ok;
  }
  // Every box pins the new key: it becomes this controller's own, and the old identity goes.
  const made = (() => {
    try {
      return readFileSync(join(d.home.approver, "made"), "utf8").trim();
    } catch {
      return "";
    }
  })();
  const old = `${d.home.approver}-old`;
  rmSync(old, { recursive: true, force: true });
  renameSync(d.home.approver, old);
  renameSync(next.approver, d.home.approver);
  if (/^[0-9A-F]{40}$/.test(made)) await d.run([SC_AUTH, "delete-ctk-identity", "-h", made], { limitMs: 30_000, maxBytes: 64_000 });
  rmSync(old, { recursive: true, force: true });
  out("Rotated: every box pins the new approver key, and this controller signs with it now. The old key is deleted.");
  return EXIT.ok;
}

// box add's trusting phase: this controller's key offered to the box, then a wait while it is
// pinned at the box's screen, or approved from a paired controller and confirmed there.
export async function trustingPhase(d: Deps, boxName: string, key: string, out: (l: string) => void): Promise<boolean> {
  const links = await linksFor(d, boxName, false);
  if (isStop(links)) return (out(`${links.stop} ${links.next}`), false);
  return offerAndWait({ ...flowDeps(d, out, links[0]), box: links[0]!, key, ...(d.tty ? {} : { waitMs: 0 }) });
}
