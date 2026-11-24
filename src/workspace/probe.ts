// The proof before Active (docs/workspaces-design.md, section 5.5). Before a workspace goes Active,
// the guard proves its fence with a control:
// - it listens on the box's own LAN address, TCP and UDP, on its IPv6 address and its Tailscale
//   address when it has them;
// - the probe run as nobody must reach the listener, so the listener is reachable at all;
// - the same probe run as the pool account must be refused: it must exit BLOCKED, which it gives only
//   for ECONNREFUSED or EHOSTUNREACH (what pf's block return gives), or for a TCP connect that
//   never opened within its time (timeoutCode), and the listener must not have seen it. Any other
//   failure is a failed proof, never a pass;
// - the probe run as the pool account must reach the internet, TCP and UDP, so the fence leaves it
//   open; over IPv6 too when the box has a global IPv6 address.
// Each probe is taskbox's own code, this file, run by taskbox's bun with env -i HOME=/var/empty, from
// /, with no .env and no bunfig but taskbox's: never the pool account's curl or its settings.
// This also proves pf's user match works on this macOS. Any failure keeps the workspace waiting,
// and the state says why.
import { createSocket } from "node:dgram";
import { connect, createServer } from "node:net";

export const PROBE_TIMEOUT_MS = 3_000;
// The probe's exit codes: 0 reached and answered; BLOCKED refused by the network; 1 any other
// failure, such as a timeout; 2 words it doesn't take.
export const BLOCKED = 3;
const REFUSED = ["ECONNREFUSED", "EHOSTUNREACH"];
export const failCode = (e: unknown) => (REFUSED.includes(String((e as NodeJS.ErrnoException)?.code)) ? BLOCKED : 1);
// The code when the probe's time runs out. On macOS 27.2, pf's block return out for a user match
// sends a TCP connect no RST and no error: it hangs (seen in the Tart run). So a TCP try at the
// guard's listener that never connected is BLOCKED. That is sound only beside the control: proveFence
// first has nobody reach the same listener, and the listener must not see the pool's token. Anything
// else that runs out of time, such as a connection that opened but never answered, or tcp-open to the
// internet, is a plain failure.
export const timeoutCode = (kind: string | undefined, connected: boolean) => (kind === "tcp" && !connected ? BLOCKED : 1);
// The internet ends the pool probe reaches: Cloudflare's resolver, TCP 443 and a DNS query on UDP 53.
export const INTERNET_V4 = "1.1.1.1";
export const INTERNET_V6 = "2606:4700:4700::1111";
const TOKEN = /^[0-9a-f]{32}$/;

export type Proto = "tcp" | "udp";

// A listener the guard holds while it proves: got says whether a probe's token reached it.
export interface Listener {
  port: number;
  got(token: string): boolean;
  close(): void;
}

export interface ProbeDeps {
  listen(host: string, proto: Proto): Promise<Listener>;
  // Runs this file as the user, with these words. Its exit code: 0 reached and answered.
  runAs(user: "nobody" | string, args: string[]): Promise<number>;
  token(): string;
}

export type Proof = { ok: true } | { ok: false; why: string };

// The proof, for one pool account. lan: the box's own addresses (fence.ts lanAddresses).
export async function proveFence(d: ProbeDeps, o: { user: string; lan: { v4?: string; v6?: string; ts?: string; v6global?: boolean } }): Promise<Proof> {
  if (!o.lan.v4) return { ok: false, why: "the box has no LAN address to prove the fence on" };
  const hosts: [string, string][] = [["IPv4", o.lan.v4]];
  if (o.lan.v6) hosts.push(["IPv6", o.lan.v6]);
  if (o.lan.ts) hosts.push(["Tailscale", o.lan.ts]);
  for (const [fam, host] of hosts) {
    for (const proto of ["tcp", "udp"] as const) {
      let l: Listener;
      try {
        l = await d.listen(host, proto);
      } catch (e) {
        return { ok: false, why: `the guard couldn't listen on ${host} for ${proto.toUpperCase()}: ${String((e as Error).message ?? e).slice(0, 80)}` };
      }
      try {
        const control = d.token();
        const pool = d.token();
        const c = await d.runAs("nobody", [proto, host, String(l.port), control]);
        if (c !== 0 || !l.got(control)) return { ok: false, why: `the control didn't reach the box's own ${fam} address over ${proto.toUpperCase()} as nobody, so the fence can't be proved` };
        const p = await d.runAs(o.user, [proto, host, String(l.port), pool]);
        if (p === 0 || l.got(pool)) return { ok: false, why: `${o.user} reached the box's own ${fam} address over ${proto.toUpperCase()}, so the fence isn't holding` };
        if (p !== BLOCKED) return { ok: false, why: `${o.user}'s try at the box's own ${fam} address over ${proto.toUpperCase()} wasn't refused (exit ${p}), so the fence isn't proved` };
      } finally {
        l.close();
      }
    }
  }
  const out: [string, string][] = [["IPv4", INTERNET_V4]];
  // The internet over IPv6 only with a global address: the LAN step above tries any IPv6 the box
  // has, a ULA included, but a ULA alone has no route out.
  if (o.lan.v6global) out.push(["IPv6", INTERNET_V6]);
  for (const [fam, host] of out) {
    for (const proto of ["tcp", "udp"] as const) {
      const r = await d.runAs(o.user, [proto === "tcp" ? "tcp-open" : "dns", host, proto === "tcp" ? "443" : "53", d.token()]);
      if (r !== 0) return { ok: false, why: `${o.user} couldn't reach the internet over ${fam} ${proto.toUpperCase()}, so its workspace wouldn't work` };
    }
  }
  return { ok: true };
}

// The guard's listeners, on the box. Each answers a line holding a token with "ok", and records it.
export function realListen(host: string, proto: Proto): Promise<Listener> {
  if (process.env.TASKBOX_TEST === "1" && !host.startsWith("127.")) throw new Error("a real listener off loopback inside a test");
  const seen = new Set<string>();
  const got = (t: string) => seen.has(t);
  if (proto === "tcp") {
    return new Promise((resolve, reject) => {
      const srv = createServer((s) => {
        s.setTimeout(PROBE_TIMEOUT_MS, () => s.destroy());
        let buf = "";
        s.on("data", (b) => {
          buf += b.toString("latin1");
          if (buf.length > 64) return void s.destroy();
          const t = buf.trim();
          if (buf.includes("\n") && TOKEN.test(t)) {
            seen.add(t);
            s.end("ok\n");
          }
        });
        s.on("error", () => undefined);
      });
      srv.on("error", reject);
      srv.listen({ host, port: 0, exclusive: true }, () => {
        const a = srv.address();
        resolve({ port: typeof a === "object" && a ? a.port : 0, got, close: () => srv.close() });
      });
    });
  }
  return new Promise((resolve, reject) => {
    const s = createSocket(host.includes(":") ? "udp6" : "udp4");
    s.on("error", reject);
    s.on("message", (m, from) => {
      const t = m.toString("latin1").trim();
      if (m.length <= 64 && TOKEN.test(t)) {
        seen.add(t);
        s.send("ok\n", from.port, from.address);
      }
    });
    s.bind({ address: host, port: 0, exclusive: true }, () => resolve({ port: s.address().port, got, close: () => s.close() }));
  });
}

// The probe itself, as the user it runs as. tcp and udp send the token to the guard's listener and
// wait for "ok". tcp-open opens a TCP connection; dns sends a DNS query and waits for any answer.
export async function probe(args: readonly string[], timeoutMs = PROBE_TIMEOUT_MS): Promise<number> {
  const [kind, host, portText, token] = args;
  const port = Number(portText);
  if (!host || !/^[0-9a-f.:]{2,45}$/i.test(host) || !Number.isInteger(port) || port < 1 || port > 65535 || !token || !TOKEN.test(token)) return 2;
  return new Promise<number>((resolve) => {
    let done = false;
    const end = (code: number, close: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        close();
      } catch {}
      resolve(code);
    };
    let close = () => {};
    let connected = false;
    const timer = setTimeout(() => end(timeoutCode(kind, connected), close), timeoutMs);
    if (kind === "tcp" || kind === "tcp-open") {
      const s = connect({ host, port });
      close = () => s.destroy();
      s.on("error", (e) => end(failCode(e), close));
      s.on("connect", () => {
        connected = true;
        if (kind === "tcp-open") end(0, close);
        else s.write(`${token}\n`);
      });
      let buf = "";
      s.on("data", (b) => {
        buf += b.toString("latin1");
        if (buf.startsWith("ok\n")) end(0, close);
      });
      return;
    }
    if (kind === "udp" || kind === "dns") {
      // A connected socket, so an ICMP refusal comes back as ECONNREFUSED.
      const s = createSocket(host.includes(":") ? "udp6" : "udp4");
      close = () => s.close();
      s.on("error", (e) => end(failCode(e), close));
      s.on("message", (m) => (kind === "dns" ? end(m.length >= 12 && m[0] === 0x7a && m[1] === 0x7a ? 0 : 1, close) : m.toString("latin1") === "ok\n" && end(0, close)));
      // A DNS query for example.com's A record, with id 0x7a7a.
      const q = Buffer.concat([Buffer.from([0x7a, 0x7a, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0]), Buffer.from("\x07example\x03com\x00", "latin1"), Buffer.from([0, 1, 0, 1])]);
      s.connect(port, host, () => s.send(kind === "dns" ? q : Buffer.from(`${token}\n`, "latin1"), (e) => e && end(failCode(e), close)));
      return;
    }
    end(2, close);
  });
}

if (import.meta.main) process.exit(await probe(process.argv.slice(2)));
