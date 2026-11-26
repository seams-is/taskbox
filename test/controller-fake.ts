// A fake controller for the controller's tests: a fake Tailscale app and a fake ssh, both answered here.
// World's own answers are a box on v2.6.1 (N-1): its version 3 answers, built by the box's own code
// (src/answers.ts), and a usage error for any line v2.6.1's shell doesn't take, as its hello gives
// for v3's words. A box at an address in standIns is a v3 box, answered by the box's own shell and
// main (controller-box.ts). Nothing real runs.
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkAnswer, errorAnswer, helloAnswer, jobsAnswer, logAnswer, statusAnswer } from "../src/answers.ts";
import type { Installed } from "../src/config.ts";
import type { Fetch } from "../src/controller/releases.ts";
import type { UpdateDeps, Verdict, Verify } from "../src/controller/update.ts";
import { home, setUpController } from "../src/controller/home.ts";
import type { RunOptions, RunResult } from "../src/controller/run.ts";
import { StandIn } from "./controller-box.ts";

export const CEILING = 5_000;

export function ed25519(): string {
  const { publicKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url");
  const str = (b: Buffer) => Buffer.concat([Buffer.from([0, 0, 0, b.length]), b]);
  return Buffer.concat([str(Buffer.from("ssh-ed25519")), str(raw)]).toString("base64");
}

export const INSTALL_ID = "0123456789abcdef0123456789abcdef";
export const NODE = "nBox1CNTRL";
export const ADDRESS = "100.64.0.7";
export const INSTALLED: Installed = { commit: "0123456789abcdef0123456789abcdef01234567", pr: 10, title: "x", mergedAt: "2026-11-17T00:00:00Z", tag: "v2.0.0", installedAt: "x", files: {} };
export const APP = "/Applications/FakeTailscale.app";
export const SSH = "/usr/bin/fake-ssh";

export const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: "", timedOut: false, tooBig: false });
export const fail = (code: number | null, stderr: string, extra: Partial<RunResult> = {}): RunResult => ({ code, stdout: "", stderr, timedOut: false, tooBig: false, ...extra });

export function peer(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { ID: NODE, HostName: "taskbox-1", DNSName: "taskbox-1.example-tailnet.ts.net.", TailscaleIPs: [ADDRESS, "fd7a:115c:a1e0::7"], Tags: ["tag:taskbox"], Online: true, sshHostKeys: [`ssh-ed25519 ${KEY}`, "ecdsa-sha2-nistp256 AAAA"], ...over };
}
export const KEY = ed25519();

// A second box, for tests of more than one.
export const NODE2 = "nBox2CNTRL";
export const ADDRESS2 = "100.64.0.8";
export const KEY2 = ed25519();
export const INSTALL_ID2 = "fedcba9876543210fedcba9876543210";
export const peer2 = (over: Record<string, unknown> = {}) => peer({ ID: NODE2, HostName: "taskbox-2", DNSName: "taskbox-2.example-tailnet.ts.net.", TailscaleIPs: [ADDRESS2], sshHostKeys: [`ssh-ed25519 ${KEY2}`], ...over });

export class World {
  bundle = "io.tailscale.ipn.macos";
  appThere = true;
  tsResult: RunResult | undefined; // set to make status fail
  backend = "Running";
  peers: Record<string, unknown>[] = [peer()];
  calls: string[][] = [];
  sshFail: RunResult | undefined;
  answers: Record<string, string> = {};
  byAddress: Record<string, Record<string, string>> = {}; // a box's own answers, by its address
  sshFailAt: Record<string, RunResult> = {};
  standIns: Record<string, StandIn> = {}; // v3 boxes, by address
  lastUser: string | undefined; // the account the last ssh call went as

  constructor() {
    this.setHello();
    this.setStatus({});
    this.answers["jobs 20 --json"] = JSON.stringify(jobsAnswer([]));
    this.answers["log --json"] = JSON.stringify(logAnswer([]));
    this.answers["check --json"] = JSON.stringify(checkAnswer([{ name: "Disk", status: "OK", detail: "x" }], false));
  }

  setHello(installId: string | null = INSTALL_ID, installed: Installed | undefined = INSTALLED) {
    this.answers.hello = JSON.stringify(helloAnswer(installed, installId ?? undefined));
  }

  setStatus(o: { word?: string; job?: string }) {
    const state = { word: o.word ?? "Ready", sentence: "", next: "" } as never;
    this.answers["status --json"] = JSON.stringify(statusAnswer({ state, installed: INSTALLED, othersLoggedIn: 0, job: o.job, lastJob: undefined, lastJobResult: undefined }));
  }

  status(): string {
    return JSON.stringify({ Version: "1.104.5", BackendState: this.backend, Self: { ID: "nControllerCNTRL", Online: true }, Peer: Object.fromEntries(this.peers.map((p, i) => [`nodekey:${i}`, p])) });
  }

  run = async (argv: string[], _o: RunOptions): Promise<RunResult> => {
    this.calls.push(argv);
    const [cmd, ...args] = argv;
    if (cmd === "/usr/bin/plutil") return this.appThere ? ok(`${this.bundle}\n`) : fail(1, "no file");
    if (cmd === `${APP}/Contents/MacOS/Tailscale`) {
      if (args.join(" ") !== "status --json") return fail(1, "only status --json");
      return this.tsResult ?? ok(this.status());
    }
    if (cmd === SSH) {
      if (this.sshFail) return this.sshFail;
      const line = args[args.length - 1]!;
      const addr = args[args.length - 2]!;
      this.lastUser = args[args.indexOf("-l") + 1];
      if (this.sshFailAt[addr]) return this.sshFailAt[addr]!;
      const box = this.standIns[addr];
      if (box) {
        const r = await box.answer(line);
        return { code: r.code, stdout: r.stdout, stderr: "", timedOut: false, tooBig: false };
      }
      const own = this.byAddress[addr]?.[line];
      if (own !== undefined) return { code: 0, stdout: `${own}\n`, stderr: "", timedOut: false, tooBig: false };
      const a = this.answers[line];
      // v2.6.1's shell and cli: a line it doesn't take is a usage error, as one line of JSON.
      return a === undefined ? { code: 1, stdout: `${JSON.stringify(errorAnswer("usage"))}\n`, stderr: "", timedOut: false, tooBig: false } : { code: 0, stdout: `${a}\n`, stderr: "", timedOut: false, tooBig: false };
    }
    return fail(127, "not faked");
  };

  // Each line sent, but the hello --json v2.6.1 refuses before its bare hello.
  sshCalls(): string[] {
    return this.calls.filter((c) => c[0] === SSH && !(c[c.length - 1] === "hello --json --answers 4,3" && !this.standIns[c[c.length - 2]!])).map((c) => c[c.length - 1]!);
  }

  // Each ssh call as "address line".
  sshTo(): string[] {
    return this.calls.filter((c) => c[0] === SSH).map((c) => `${c[c.length - 2]} ${c[c.length - 1]}`);
  }
}

export interface TestDeps extends UpdateDeps {
  printed: string[];
  asked: string[];
  web: Map<string, { status: number; body: Uint8Array | string }>; // what the fake GitHub serves
  fetched: string[];
  verified: Parameters<Verify>[0][];
  verdict: Verdict;
}

export function deps(w: World, answers: string[] = []): TestDeps {
  const userHome = mkdtempSync(join(process.env.HOME ?? tmpdir(), "user-"));
  mkdirSync(join(userHome, "Library"), { recursive: true });
  const h = home(userHome);
  setUpController(h);
  const printed: string[] = [];
  const asked: string[] = [];
  const web = new Map<string, { status: number; body: Uint8Array | string }>();
  const fetched: string[] = [];
  const verified: Parameters<Verify>[0][] = [];
  const fetch: Fetch = async (url) => {
    fetched.push(url);
    const r = web.get(url);
    if (!r) return new Response("not found", { status: 404 });
    return new Response(r.body, { status: r.status });
  };
  const t: TestDeps = {
    run: w.run,
    home: h,
    version: "v2.1.0",
    now: () => Date.UTC(2026, 10, 17, 12, 0),
    sleep: async () => {},
    ask: async (p) => {
      asked.push(p);
      return answers.shift() ?? "";
    },
    out: (l) => printed.push(l),
    userHome,
    tty: true,
    tailscaleApp: APP,
    sshPath: SSH,
    exists: (p) => p === `${APP}/Contents/MacOS/Tailscale` && w.appThere,
    printed,
    asked,
    web,
    fetched,
    verified,
    verdict: { ok: false, why: "no verdict set" },
    fetch,
    verify: async (o) => {
      verified.push(o);
      return t.verdict;
    },
    arch: "arm64",
  };
  return t;
}

// One pairing, as box add writes it.
export const pairing = (o: { name?: string; node?: string; installId?: string; hostKey?: string; agent?: string } = {}) => ({ name: o.name ?? "taskbox-1", node: o.node ?? NODE, installId: o.installId ?? INSTALL_ID, hostKey: o.hostKey ?? KEY, agent: o.agent ?? "taskbox-agent", pairedAt: 1 });
// The controller's config with these pairings.
export const controllerConfig = (boxes: ReturnType<typeof pairing>[], o: { default?: string | null } = {}) => ({ role: "controller" as const, source: null, boxes, default: o.default ?? null, channel: "stable" as const });

export { errorAnswer, StandIn };

// One command line on the controller, as the owner types it: what it printed, what it drew, its exit.
export async function runLine(d: TestDeps, argv: string[], rounds = 1): Promise<{ code: number; lines: string[]; drawn: string[][] }> {
  const { dispatch } = await import("../src/controller/main.ts");
  const lines: string[] = [];
  const drawn: string[][] = [];
  const code = await dispatch(d, argv, { out: (l) => lines.push(l), draw: (l) => drawn.push(l), rounds });
  return { code, lines, drawn };
}
