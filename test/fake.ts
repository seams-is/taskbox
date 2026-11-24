// A fake machine and a fake GitHub. Every command and URL is recorded.
import type { Proc, ProbeResult, RunOptions, RunResult, SpawnOptions, Sys } from "../src/sys.ts";
import { fakes } from "./setup.ts";

export type Responder = (cmd: string, args: string[], opts?: RunOptions) => RunResult | undefined;
export type Route = (method: string, url: string, body: unknown) => Response | undefined;

export interface FakeProc {
  cmd: string;
  args: string[];
  opts: SpawnOptions;
  exit(code: number): void;
  killed: boolean;
  killedAt?: number;
  done: boolean;
}

export class FakeSys implements Sys {
  calls: { cmd: string; args: string[]; stdin?: string; env?: Record<string, string> }[] = [];
  events: string[] = [];
  spawned: FakeProc[] = [];
  requests: { method: string; url: string; body: unknown; auth: string }[] = [];
  responders: Responder[] = [];
  // Answers for a whole kind of box (helpers.ts quietBox), asked after every test's own responders.
  fallbacks: Responder[] = [];
  routes: Route[] = [];
  clock = 1_800_000_000_000;
  onSpawn: (p: FakeProc) => void = () => {};
  probe: ProbeResult = "refused";
  addresses = ["127.0.0.1", "192.168.1.20"];
  // Every command nothing answered. setup.ts fails the test that left one here.
  unknown: string[] = [];
  // Tart's VMs, by name. A clone appears in the list until it is deleted.
  vms = new Map<string, { ip: string; run?: FakeProc; source?: "OCI" | "local"; size?: number }>();
  // A Tart that never stops a VM, so the code has to end the run itself.
  tartIgnoresStop = false;
  private pids = 4242;

  constructor() {
    fakes.push(this);
  }

  async run(cmd: string, args: string[], opts?: RunOptions): Promise<RunResult> {
    this.calls.push({ cmd, args, stdin: typeof opts?.stdin === "string" ? opts.stdin : undefined, ...(opts?.env ? { env: opts.env } : {}) });
    this.events.push(`run ${cmd.split("/").pop()} ${args.slice(0, 2).join(" ")}`);
    for (const r of [...this.responders, ...this.fallbacks]) {
      const out = r(cmd, args, opts);
      if (out) return out;
    }
    // Plenty of room unless a test says otherwise: 500 GB.
    if (cmd === "/bin/df") return { code: 0, stdout: `F 1 U A C M\n/dev/disk3s5 1 1 ${500e9 / 1024} 1% /\n`, stderr: "" };
    // The Softnet check's process list: launchd is always there, and no Softnet runs as root.
    if (cmd === "/bin/ps" && args[1] === "pid=,etime=,user=,ruser=,svuid=,comm=") return { code: 0, stdout: "1 9-00:00:00 root root 0 /sbin/launchd\n", stderr: "" };
    const tart = cmd.endsWith("/tart") ? this.tart(args) : undefined;
    if (tart) return tart;
    const line = [cmd, ...args].join(" ");
    this.unknown.push(line);
    throw new Error(`FakeSys: no answer for ${line}`);
  }

  // Tart's own answers for the VMs it holds. exec and pull are the tests' to answer.
  private tart(args: string[]): RunResult | undefined {
    const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
    const no = (stderr: string) => ({ code: 1, stdout: "", stderr });
    const [verb, name = ""] = args;
    const vm = this.vms.get(name);
    const running = !!vm?.run && !vm.run.done;
    if (verb === "clone") {
      this.vms.set(args[2]!, { ip: this.freeIP() });
      return ok();
    }
    if (verb === "list") return ok(JSON.stringify([...this.vms].map(([Name, v]) => ({ Name, Source: v.source ?? "local", State: v.run && !v.run.done ? "running" : "stopped", Size: v.size ?? 20 }))));
    if (verb === "ip") return running ? ok(`${vm!.ip}\n`) : no(`no IP address found for ${name}`);
    if (verb === "stop") {
      if (running && !this.tartIgnoresStop) vm!.run!.exit(0);
      return ok();
    }
    if (verb === "delete") {
      if (!vm) return no(`the specified VM "${name}" does not exist`);
      if (running) return no(`the VM "${name}" is running`);
      this.vms.delete(name);
      return ok();
    }
    if (verb === "set") return ok();
    return undefined;
  }

  // A pulled image in Tart's cache, which tart list shows beside the VMs.
  image(name: string, sizeGB = 50): void {
    this.vms.set(name, { ip: "", source: "OCI", size: sizeGB });
  }

  // A VM up and running, as a clone and a tart run leave it.
  runVM(name: string): FakeProc {
    this.spawn("/opt/taskbox/bin/tart", ["run", name]);
    return this.spawned.at(-1)!;
  }

  // The first VM gets vmIP, the next the address after it, and so on.
  private freeIP(): string {
    const taken = new Set([...this.vms.values()].map((v) => v.ip));
    const [a, b, c, d] = this.vmIP.split(".").map(Number);
    for (let i = 0; ; i++) {
      const ip = `${a}.${b}.${c}.${d! + i}`;
      if (!taken.has(ip)) return ip;
    }
  }

  spawn(cmd: string, args: string[], opts: SpawnOptions = {}): Proc {
    let settle!: (n: number) => void;
    const exited = new Promise<number>((r) => (settle = r));
    const resolve = (n: number) => {
      p.done = true;
      settle(n);
    };
    const p: FakeProc = {
      cmd,
      args,
      opts,
      killed: false,
      done: false,
      exit: (n) => resolve(n),
    };
    this.spawned.push(p);
    if (cmd.endsWith("/tart") && args[0] === "run") {
      const vm = this.vms.get(args[1]!) ?? { ip: this.freeIP() };
      this.vms.set(args[1]!, { ...vm, run: p });
    }
    this.events.push(`spawn ${cmd.split("/").pop()} ${args.slice(0, 2).join(" ")}`);
    this.onSpawn(p);
    return {
      exited,
      // A process that already ended can't be killed.
      kill: () => {
        if (p.done) return;
        p.killed = true;
        p.killedAt = this.now();
        resolve(137);
      },
      pid: this.pids++,
    };
  }

  // What Cloudflare's trace reports as the box's public address; null makes the read fail.
  publicIP: string | null = "203.0.113.7";
  // What ipify reports (v2.5.0's second source); undefined says what the trace says.
  ipify: string | null | undefined = undefined;
  traces = 0;

  async fetch(url: string, init?: RequestInit): Promise<Response> {
    if (url === "https://1.1.1.1/cdn-cgi/trace") {
      this.traces++;
      return this.publicIP ? new Response(`fl=1\nh=1.1.1.1\nip=${this.publicIP}\nts=1\n`) : new Response("", { status: 503 });
    }
    if (url === "https://api.ipify.org") {
      const ip = this.ipify === undefined ? this.publicIP : this.ipify;
      return ip ? new Response(ip) : new Response("", { status: 503 });
    }
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const auth = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? "");
    this.requests.push({ method, url, body, auth });
    this.events.push(`${method} ${new URL(url).pathname}`);
    for (const r of this.routes) {
      const res = r(method, url, body);
      if (res) return res;
    }
    return new Response("not found", { status: 404 });
  }

  // The VM's own address: Softnet drops the box's tries, unless a test says otherwise.
  vmIP = "192.168.64.5";
  vmProbe: ProbeResult = "timeout";
  async tcpProbe(host: string, _port: number, _timeoutMs: number): Promise<ProbeResult> {
    return host === this.vmIP || [...this.vms.values()].some((v) => v.ip === host) ? this.vmProbe : this.probe;
  }

  localIPv4(): string[] {
    return this.addresses;
  }

  now(): number {
    return this.clock;
  }

  // Fake time: each sleep waits in a queue by deadline (ties in call order). One timer wakes per
  // setImmediate turn, and the clock moves to its deadline. A sleep that lost a race stays queued,
  // so a test that reads elapsed fake time must not await real I/O between the two reads.
  timers: { at: number; wake: () => void }[] = [];
  sleep(ms: number): Promise<void> {
    return new Promise((wake) => {
      const at = this.clock + ms;
      let i = this.timers.length;
      while (i > 0 && this.timers[i - 1]!.at > at) i--;
      this.timers.splice(i, 0, { at, wake });
      if (this.timers.length === 1) this.pump();
    });
  }
  private pump(): void {
    setImmediate(() => {
      const t = this.timers.shift();
      if (!t) return;
      this.clock = Math.max(this.clock, t.at);
      t.wake();
      if (this.timers.length) this.pump();
    });
  }

  // Every string the box would have shown to another process.
  allArgs(): string {
    return [...this.calls.map((c) => [c.cmd, ...c.args].join(" ")), ...this.spawned.map((p) => [p.cmd, ...p.args].join(" "))].join("\n");
  }

  tartCalls(): string[] {
    return [
      ...this.calls.filter((c) => c.cmd.endsWith("/tart")).map((c) => c.args.slice(0, 2).join(" ")),
    ];
  }
}

export const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });

export const SECRETS = {
  token: "ghs_" + "A".repeat(36),
  jit: "eyJKSVQiOiJ0aGlzIGlzIGEgZmFrZSBydW5uZXIgY29uZmlnIn0=",
};

// The head of the branch main in the fake GitHub. A compare to it is the on-main check.
export const MAIN_SHA = "eeee1234def5678abc1234def5678abc1234def5";

export function githubRoutes(sys: FakeSys, opts: { compareStatus?: string; followStatus?: string; head?: Record<string, unknown>; groupRepo?: string; releases?: { tag_name: string; name: string; draft: boolean; prerelease: boolean }[] } = {}): void {
  sys.routes.push((method, url) => {
    const u = new URL(url);
    if (u.hostname !== "api.github.com") return undefined;
    const p = u.pathname;
    if (method === "GET" && p === "/orgs/example-org/installation") return json({ id: 42 });
    if (method === "POST" && p === "/app/installations/42/access_tokens") return json({ token: SECRETS.token });
    // One published release, v2.0.0, unless a test says otherwise.
    if (method === "GET" && p === "/repos/example-org/taskbox/releases") return json(opts.releases ?? [{ tag_name: "v2.0.0", name: "taskbox 2", draft: false, prerelease: false }]);
    if (method === "GET" && p.startsWith("/repos/example-org/taskbox/releases/tags/")) {
      const r = (opts.releases ?? [{ tag_name: "v2.0.0", name: "taskbox 2", draft: false, prerelease: false }]).find((x) => x.tag_name === p.split("/").pop());
      return r ? json(r) : new Response("{}", { status: 404 });
    }
    if (method === "GET" && p.startsWith("/repos/example-org/taskbox/git/ref/tags/")) return json({ object: { type: "commit", sha: "abc1234def5678abc1234def5678abc1234def56" } });
    if (method === "GET" && p === "/repos/example-org/taskbox/git/ref/heads/main") return json({ object: { type: "commit", sha: MAIN_SHA } });
    if (method === "GET" && p.startsWith("/repos/example-org/taskbox/commits/")) {
      return json(
        opts.head ?? {
          sha: "abc1234def5678abc1234def5678abc1234def56",
          committer: { login: "web-flow" },
          commit: {
            message: "feat: install the box (#2)\n\nbody",
            committer: { date: "2026-11-12T10:00:00Z" },
            verification: { verified: true },
          },
        },
      );
    }
    if (method === "GET" && p.startsWith("/repos/example-org/taskbox/compare/")) {
      const st = (p.endsWith(`...${MAIN_SHA}`) ? undefined : opts.followStatus) ?? opts.compareStatus ?? "ahead";
      if (st === "error") return json({ message: "Server Error" }, 502);
      return json({ status: st, behind_by: st === "diverged" || st === "behind" ? 1 : 0, files: [{}, {}] });
    }
    if (method === "GET" && p === "/orgs/example-org/actions/runner-groups") {
      return json({ runner_groups: [{ id: 7, name: "taskbox", visibility: "selected", allows_public_repositories: false }] });
    }
    if (method === "GET" && p === "/orgs/example-org/actions/runner-groups/7/repositories") {
      return json({ repositories: [{ full_name: opts.groupRepo ?? "example-org/app" }] });
    }
    if (method === "POST" && p === "/orgs/example-org/actions/runners/generate-jitconfig") {
      return json({ encoded_jit_config: SECRETS.jit, runner: { id: 99 } });
    }
    if (method === "DELETE" && p.startsWith("/orgs/example-org/actions/runners/")) return new Response(null, { status: 204 });
    return undefined;
  });
}

// netstat on a clean box: printing (631) on loopback only, and an outgoing connection.
export const NETSTAT_CLEAN = `Active Internet connections (including servers)
Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)
tcp4       0      0  172.20.10.7.50122      140.82.112.3.443       ESTABLISHED
tcp4       0      0  127.0.0.1.631          *.*                    LISTEN
tcp6       0      0  ::1.631                *.*                    LISTEN
`;
