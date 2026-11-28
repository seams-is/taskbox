// selftest run --release VERSION: a signed release tried in taskbox's own macOS VM before the box
// installs it. The loop runs it, as the service account, in a free slot, under a job's network
// rules: the release is fetched from the public repo with no token and verified as an update
// verifies it, then the VM, a clone of the macOS kind's image, takes the release's three files and
// this box's settings in force (settings hold no secrets), and runs install.sh --guest-test from
// that tree, the whole install with the steps a guest can't take skipped and named. The VM is
// deleted after, whatever happened. No GitHub job runs it.
import { bare, type Verdict } from "./release.ts";
import type { NetPolicy, VmEngine } from "./vm.ts";

export const TRIAL_FOLDER = "taskbox-install";
export const TRIAL_INSTALL_MS = 45 * 60_000;
const FILE_MS = 120_000;

export interface TrialRelease {
  statement: Uint8Array;
  signature: Uint8Array;
  tarball: Uint8Array;
}

export interface TrialEnv {
  engine: Pick<VmEngine, "clone" | "size" | "start" | "exec" | "stop" | "delete">;
  image: string; // the macOS kind's base image
  cpus: number;
  memoryMB: number;
  net: NetPolicy;
  vm: string; // the clone's name
  fetch(version: string): Promise<TrialRelease>;
  verify(r: TrialRelease, version: string): Promise<Verdict>;
  settings: { text: string; sha: string; repo: string };
  ready(vm: string, exited: Promise<number>): Promise<boolean>;
  progress(text: string): void;
  cancelled(): boolean;
}

// passed, failed, or notRun: the trial couldn't tell (the VM didn't start, the release couldn't be
// read), so it says nothing about the release.
export type TrialResult = { ok: boolean; detail: string; notRun?: boolean };

const clean = (t: string) => t.replace(/[^\x20-\x7e]/g, " ").replace(/\s+/g, " ").trim();
const lastLines = (out: string, n = 3) => clean(out.split("\n").filter((l) => l.trim()).slice(-n).join("; ")).slice(0, 200);

export async function tryRelease(e: TrialEnv, version: string): Promise<TrialResult> {
  const v = bare(version);
  const tag = `v${v}`;
  e.progress(`reading ${tag} from the public repo`);
  let rel: TrialRelease;
  try {
    rel = await e.fetch(v);
  } catch (x) {
    return { ok: false, notRun: true, detail: `${tag} couldn't be read: ${clean(String((x as Error)?.message ?? x)).slice(0, 120)}` };
  }
  e.progress(`checking ${tag}'s signature, as an update checks it`);
  const verdict = await e.verify(rel, v);
  if (!verdict.ok) return { ok: false, detail: `${tag} isn't a release this box would take: ${verdict.why}` };
  const s = verdict.statement;
  if (e.cancelled()) return { ok: false, notRun: true, detail: "cancelled" };
  e.progress(`starting a macOS VM for ${tag}`);
  if ((await e.engine.clone(e.image, e.vm)).code !== 0) return { ok: false, notRun: true, detail: "the macOS image couldn't be cloned" };
  let proc: { exited: Promise<number>; kill(): void } | undefined;
  try {
    if ((await e.engine.size(e.vm, e.cpus, e.memoryMB)).code !== 0) return { ok: false, notRun: true, detail: "the VM couldn't be sized" };
    proc = e.engine.start(e.vm, e.net);
    if (!(await e.ready(e.vm, proc.exited))) return { ok: false, notRun: true, detail: "the macOS guest never answered" };
    if (e.cancelled()) return { ok: false, notRun: true, detail: "cancelled" };
    // The release's files and the settings, each written by the guest's own cat from stdin, beside
    // one another, as taskbox box install leaves them.
    const files: [string, Uint8Array | string][] = [
      ["statement.json", rel.statement],
      ["statement.json.sig", rel.signature],
      [s.tarball, rel.tarball],
      ["taskbox.json", e.settings.text],
      ["taskbox.json.commit", `${e.settings.sha}\n`],
    ];
    const mk = await e.engine.exec(e.vm, ["/bin/sh", "-c", `/bin/rm -rf "$HOME/${TRIAL_FOLDER}" && /bin/mkdir -m 700 "$HOME/${TRIAL_FOLDER}"`], undefined, FILE_MS);
    if (mk.code !== 0) return { ok: false, notRun: true, detail: "the guest's folder couldn't be made" };
    for (const [name, body] of files) {
      const w = await e.engine.exec(e.vm, ["/bin/sh", "-c", `/bin/cat > "$HOME/${TRIAL_FOLDER}/$1"`, "sh", name], body, FILE_MS);
      if (w.code !== 0) return { ok: false, notRun: true, detail: `${name} couldn't be copied into the guest` };
    }
    e.progress(`installing ${tag} in the guest: install.sh --guest-test`);
    const run = `cd "$HOME/${TRIAL_FOLDER}" && /usr/bin/tar -xzf "$1" && /bin/sh taskbox/install.sh --settings "$2" --guest-test`;
    const r = await e.engine.exec(e.vm, ["/bin/sh", "-c", run, "sh", s.tarball, e.settings.repo], undefined, TRIAL_INSTALL_MS);
    const out = `${r.stdout}\n${r.stderr}`;
    if (r.code === 0 && out.includes(`Installed ${v} as a guest test.`)) return { ok: true, detail: `${tag} installed in taskbox's own VM, as a guest test` };
    return { ok: false, detail: `${tag}'s install in taskbox's own VM ended with exit ${r.code}: ${lastLines(out) || "no output"}` };
  } finally {
    await e.engine.stop(e.vm, 30).catch(() => undefined);
    proc?.kill();
    await e.engine.delete(e.vm).catch(() => undefined);
  }
}
