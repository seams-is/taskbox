// The box's own GET (fetch.ts getWith) against a loopback HTTPS server, under Bun: the connection
// goes to the checked address whatever the name, gzip bytes are hashed as sent, and the deadline ends
// a body that stalls. The certificate is the test's own (test/fixtures/tls), trusted by this test only.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { type FetchDeps, fetchBlob, getWith } from "../src/tools/fetch.ts";
import type { ToolEntry } from "../src/tools/settings.ts";
import { blobPath, ensureStore, storeOf } from "../src/tools/store.ts";

const dir = join(import.meta.dir, "fixtures/tls");
const cert = readFileSync(join(dir, "test.crt"), "utf8");
const key = readFileSync(join(dir, "test.key"), "utf8");
const HOST = "tools.example.test"; // no DNS has it: only the pinned lookup reaches the server
const PLAIN = "tool bytes ".repeat(500);
const GZ = gzipSync(PLAIN);
const sha = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");

let server: ReturnType<typeof Bun.serve>;
const lookedUp: string[] = [];
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    tls: { cert, key },
    fetch(req, srv) {
      lookedUp.push(srv.requestIP(req)?.address ?? "");
      const path = new URL(req.url).pathname;
      if (path === "/gz") return new Response(GZ, { headers: { "Content-Encoding": "gzip", "Content-Type": "application/gzip" } });
      if (path === "/slow")
        return new Response(
          new ReadableStream({
            start: (c) => c.enqueue(new TextEncoder().encode("a first part")),
            // Then nothing more, ever.
          }),
        );
      return new Response("plain");
    },
  });
});
afterAll(() => server.stop(true));

const url = (p: string) => `https://${HOST}:${server.port}${p}`;
const get = getWith({ ca: cert });
const timers = (): FetchDeps["after"] => (ms, f) => {
  const t = setTimeout(f, ms);
  return () => clearTimeout(t);
};
// The fetch's own checks see a public address for the name; the GET goes to loopback, as the box's
// would go to the address its check passed.
const deps = (): FetchDeps => ({ get: (u, o) => get(u, { ...o, address: "127.0.0.1", family: 4 }), resolve: async () => ["140.82.112.3"], after: timers() });
const store = () => {
  const s = storeOf(join(mkdtempSync(join(tmpdir(), "taskbox-tls-")), "tools"));
  ensureStore(s);
  return s;
};

describe("the box's GET over real TLS", () => {
  test("it connects to the address it is given, whatever the name says", async () => {
    const r = await get(url("/"), { address: "127.0.0.1", family: 4, headers: { "User-Agent": "taskbox" }, signal: new AbortController().signal });
    let body = "";
    for await (const c of r.body) body += Buffer.from(c).toString();
    expect([r.status, body]).toEqual([200, "plain"]);
    expect(lookedUp.at(-1)).toBe("127.0.0.1");
  });
  test("outside a test's own trust it refuses to run in a test", async () => {
    await expect(getWith()(url("/"), { address: "127.0.0.1", family: 4, headers: {}, signal: new AbortController().signal })).rejects.toThrow("the real network was used inside a test");
  });
  test("gzip bytes are hashed as sent: a pin of the compressed bytes matches, and the blob is them", async () => {
    const s = store();
    const e: ToolEntry = { name: "tool.tar.gz", os: "linux", url: url("/gz"), sha256: sha(GZ) };
    expect(await fetchBlob(deps(), s, e, 1e6)).toEqual({ ok: true, bytes: GZ.length });
    expect(Buffer.compare(readFileSync(blobPath(s, e.sha256)), GZ)).toBe(0);
    // A pin of the decompressed bytes doesn't match.
    expect(await fetchBlob(deps(), store(), { ...e, sha256: sha(PLAIN) }, 1e6)).toMatchObject({ ok: false, why: expect.stringContaining("its SHA-256 is") });
  });
  test("the deadline ends a body that stalls, and nothing stays in staging", async () => {
    const s = store();
    const e: ToolEntry = { name: "tool.tar.gz", os: "linux", url: url("/slow"), sha256: sha("never") };
    const started = performance.now();
    expect(await fetchBlob(deps(), s, e, 1e6, () => {}, 1_500)).toEqual({ ok: false, why: "the download was cut off: it took longer than 2 s" });
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(readdirSync(s.staging)).toEqual([]);
  }, 10_000);
});
