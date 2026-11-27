// The pinned tool cache's settings, its fetch and its store: every refusal a fetch makes, and
// generations that are stable, hard linked and sealed.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkConfig, type Config } from "../src/config.ts";
import { fetchBlob, type FetchDeps, hostProblem, privateAddress } from "../src/tools/fetch.ts";
import { checkTools, entriesFor, type ToolEntry, toolsOf, urlProblem } from "../src/tools/settings.ts";
import { blobPath, buildGeneration, dropBadBlobs, ensureStore, generationProblem, genIdOf, manifestText, removeTree, storeOf } from "../src/tools/store.ts";
import { CFG } from "./helpers.ts";

const sha = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");
const BUN = "bun zip bytes";
const NODE = "node tarball bytes";
const bun: ToolEntry = { name: "bun-1.3.13.zip", os: "linux", url: "https://github.com/oven-sh/bun/releases/download/bun-v1.3.13/bun-linux-aarch64.zip", sha256: sha(BUN) };
const node: ToolEntry = { name: "node-24.22.3.tar.xz", os: "linux", url: "https://nodejs.org/dist/v24.22.3/node-v24.22.3-linux-arm64.tar.xz", sha256: sha(NODE), toolcache: { tool: "node", version: "24.22.3", arch: "arm64", strip: 1 } };

function store() {
  const s = storeOf(join(mkdtempSync(join(tmpdir(), "taskbox-tools-")), "tools"));
  ensureStore(s);
  return s;
}
function put(s: ReturnType<typeof store>, body: string): void {
  writeFileSync(blobPath(s, sha(body)), body, { mode: 0o444 });
}

describe("the tools settings", () => {
  const cfg = (tools: unknown) => ({ ...structuredClone(CFG), tools }) as unknown as Config;
  test("the spec's example passes, and the defaults are on, 5 GB and no pins", () => {
    expect(() => checkConfig(cfg({ enabled: true, maxGB: 5, entries: [bun, node] }))).not.toThrow();
    expect(toolsOf(CFG)).toEqual({ enabled: true, maxGB: 5, entries: [] });
    expect(entriesFor(toolsOf(cfg({ entries: [node, bun, { ...bun, os: "macos" }] })), "linux").map((e) => e.name)).toEqual(["bun-1.3.13.zip", "node-24.22.3.tar.xz"]);
  });
  test.each([
    [{ ...bun, url: "http://example.com/x" }, "https only"],
    [{ ...bun, url: "https://user:pw@example.com/x" }, "no user or password"],
    [{ ...bun, url: `https://example.com/${"a".repeat(2050)}` }, "at most 2048"],
    [{ ...bun, url: "https://example.com/a b" }, "printable ASCII"],
    [{ ...bun, sha256: "ABC" }, "64 hex"],
    [{ ...bun, sha256: sha(BUN).toUpperCase() }, "64 hex"],
    [{ ...bun, os: "windows" }, "macos or linux"],
    [{ ...bun, name: "../bun" }, "a file name"],
    [{ ...bun, name: "a/b" }, "a file name"],
    [{ ...bun, extra: 1 }, "no key extra"],
    [{ ...node, toolcache: { ...node.toolcache, tool: "../x" } }, "tool's name"],
    [{ ...node, toolcache: { ...node.toolcache, strip: 4 } }, "strip is 0 to 3"],
    [{ ...node, name: "node.pkg" }, "so the bake can unpack it"],
  ])("a pin that can't be one is refused: %j", (e, why) => {
    expect(() => checkTools({ tools: { entries: [e] } })).toThrow(why);
  });
  test("a name twice for one os is refused; the same name for each os is fine", () => {
    expect(() => checkTools({ tools: { entries: [bun, { ...bun, url: "https://example.com/b.zip" }] } })).toThrow("used twice");
    expect(() => checkTools({ tools: { entries: [bun, { ...bun, os: "macos" }] } })).not.toThrow();
  });
  test("maxGB is at most 50, and an unknown key is refused", () => {
    expect(() => checkTools({ tools: { maxGB: 51 } })).toThrow("at most 50");
    expect(() => checkTools({ tools: { maxGB: 0 } })).toThrow("above 0");
    expect(() => checkTools({ tools: { latest: true } })).toThrow("no key latest");
  });
  test("urlProblem takes the pins' URLs", () => {
    expect(urlProblem(bun.url)).toBeUndefined();
    expect(urlProblem("ftp://example.com/x")).toBe("is https only");
  });
});

describe("the box's side of the internet", () => {
  test.each(["10.1.2.3", "100.64.0.1", "100.127.255.254", "127.0.0.1", "169.254.1.1", "172.16.0.1", "172.31.9.9", "192.168.1.20", "192.0.0.8", "198.18.0.1", "224.0.0.1", "255.255.255.255", "0.0.0.0", "::1", "::", "fd7a:115c:a1e0::1", "fc00::1", "fe80::1", "ff02::1", "::ffff:10.0.0.1", "::ffff:a00:1", "64:ff9b::10.0.0.1", "2001:db8::1", "nonsense"])("%s is refused", (a) => {
    expect(privateAddress(a)).toBe(true);
  });
  test.each(["140.82.112.3", "104.16.1.1", "100.128.0.1", "172.32.0.1", "2606:4700::1111", "::ffff:8.8.8.8"])("%s is the internet", (a) => {
    expect(privateAddress(a)).toBe(false);
  });
  test("a name is refused when any address it resolves to is private, and when it resolves to none", async () => {
    expect(await hostProblem("example.com", async () => ["93.184.216.34", "10.0.0.5"])).toContain("10.0.0.5");
    expect(await hostProblem("example.com", async () => [])).toContain("no address");
    expect(await hostProblem("example.com", async () => Promise.reject(new Error("nx")))).toContain("couldn't be resolved");
    expect(await hostProblem("[::1]", async () => ["93.184.216.34"])).toContain("::1");
    expect(await hostProblem("example.com", async () => ["93.184.216.34"])).toBeUndefined();
  });
});

// A fake web: each URL's answer, and the names' addresses.
function web(routes: Record<string, () => Response>, addrs: Record<string, string[]> = {}): FetchDeps & { asked: string[]; inits: RequestInit[] } {
  const asked: string[] = [];
  const inits: RequestInit[] = [];
  return {
    asked,
    inits,
    async fetch(url, init) {
      asked.push(url);
      inits.push(init ?? {});
      const r = routes[url];
      if (!r) return new Response("no", { status: 404 });
      return r();
    },
    resolve: async (h) => addrs[h] ?? ["140.82.112.3"],
    timeout: () => new AbortController().signal,
  };
}
const redirect = (to: string, status = 302) => () => new Response(null, { status, headers: { location: to } });

describe("fetching a pin", () => {
  test("a pin whose hash matches lands in blobs, 0444, and nothing stays in staging", async () => {
    const s = store();
    const w = web({ [bun.url]: () => new Response(BUN) });
    expect(await fetchBlob(w, s, bun, 1e6)).toEqual({ ok: true, bytes: BUN.length });
    const p = blobPath(s, bun.sha256);
    expect(readFileSync(p, "utf8")).toBe(BUN);
    expect(statSync(p).mode & 0o777).toBe(0o444);
    expect(readdirSync(s.staging)).toEqual([]);
    expect(w.inits[0]!.redirect).toBe("manual");
  });
  test("a hash mismatch is refused, and its bytes go", async () => {
    const s = store();
    const r = await fetchBlob(web({ [bun.url]: () => new Response("something else") }), s, bun, 1e6);
    expect(r).toMatchObject({ ok: false, why: expect.stringContaining("and the pin's is") });
    expect(readdirSync(s.blobs)).toEqual([]);
    expect(readdirSync(s.staging)).toEqual([]);
  });
  test("a file bigger than its room is refused, by its length and by what came", async () => {
    const s = store();
    expect(await fetchBlob(web({ [bun.url]: () => new Response(BUN, { headers: { "content-length": "999999" } }) }), s, bun, 100)).toMatchObject({ ok: false, why: expect.stringContaining("more than the 100") });
    const stream = () => new Response(new ReadableStream({ start: (c) => (c.enqueue(new TextEncoder().encode("x".repeat(60))), c.enqueue(new TextEncoder().encode("x".repeat(60))), c.close()) }));
    expect(await fetchBlob(web({ [bun.url]: stream }), s, bun, 100)).toMatchObject({ ok: false, why: expect.stringContaining("more than the 100") });
    expect(readdirSync(s.staging)).toEqual([]);
  });
  test("a redirect to http is refused", async () => {
    const r = await fetchBlob(web({ [bun.url]: redirect("http://objects.example.com/bun.zip") }), store(), bun, 1e6);
    expect(r).toMatchObject({ ok: false, why: "a redirect went to a URL that is https only" });
  });
  test("a redirect to a host on a private address is refused before it is asked", async () => {
    const w = web({ [bun.url]: redirect("https://inside.example.com/bun.zip"), "https://inside.example.com/bun.zip": () => new Response(BUN) }, { "inside.example.com": ["100.101.102.103"] });
    expect(await fetchBlob(w, store(), bun, 1e6)).toMatchObject({ ok: false, why: expect.stringContaining("100.101.102.103") });
    expect(w.asked).toEqual([bun.url]);
  });
  test("a redirect to an address literal on the LAN is refused", async () => {
    const w = web({ [bun.url]: redirect("https://192.168.1.20/bun.zip") });
    expect(await fetchBlob(w, store(), bun, 1e6)).toMatchObject({ ok: false, why: expect.stringContaining("192.168.1.20") });
  });
  test("five redirects are followed, a sixth is refused", async () => {
    const hops = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [i ? `https://h${i}.example.com/x` : bun.url, redirect(`https://h${i + 1}.example.com/x`)]));
    const five = web({ ...hops(5), "https://h5.example.com/x": () => new Response(BUN) });
    expect(await fetchBlob(five, store(), bun, 1e6)).toEqual({ ok: true, bytes: BUN.length });
    const six = web({ ...hops(6), "https://h6.example.com/x": () => new Response(BUN) });
    expect(await fetchBlob(six, store(), bun, 1e6)).toMatchObject({ ok: false, why: "more than 5 redirects" });
  });
  test("a download cut off part way is refused, and its part goes", async () => {
    const s = store();
    const cut = () => new Response(new ReadableStream({ start: (c) => (c.enqueue(new TextEncoder().encode("bun zip")), c.error(new Error("connection reset"))) }));
    expect(await fetchBlob(web({ [bun.url]: cut }), s, bun, 1e6)).toMatchObject({ ok: false, why: expect.stringContaining("connection reset") });
    expect(readdirSync(s.staging)).toEqual([]);
    expect(readdirSync(s.blobs)).toEqual([]);
  });
  test("a server that refuses, or a fetch that throws, is a failure with its reason", async () => {
    expect(await fetchBlob(web({ [bun.url]: () => new Response("", { status: 503 }) }), store(), bun, 1e6)).toMatchObject({ ok: false, why: "the server answered 503" });
    const w = web({});
    w.fetch = async () => Promise.reject(new Error("EOF"));
    expect(await fetchBlob(w, store(), bun, 1e6)).toMatchObject({ ok: false, why: expect.stringContaining("EOF") });
  });
  test("a link planted in staging under the next name is never written through", async () => {
    const s = store();
    // O_EXCL with O_NOFOLLOW: the random part of the name makes a planted link miss, and a hit fails.
    symlinkSync("/etc/hosts", join(s.staging, `${bun.sha256}.000000000000`));
    expect(await fetchBlob(web({ [bun.url]: () => new Response(BUN) }), s, bun, 1e6)).toEqual({ ok: true, bytes: BUN.length });
  });
});

describe("a generation", () => {
  test("its id is its manifest's SHA-256, the same for the same pins in any order", async () => {
    const s = store();
    put(s, BUN);
    put(s, NODE);
    const a = (await buildGeneration(s, "linux", [bun, node])).gen!;
    const b = (await buildGeneration(s, "linux", [node, bun])).gen!;
    expect(a.id).toBe(b.id);
    expect(a.id).toBe(genIdOf(readFileSync(join(a.dir, "manifest.json"), "utf8")));
    expect(readFileSync(join(a.dir, "manifest.json"), "utf8")).toBe(manifestText(a.manifest));
    expect(readdirSync(s.gen)).toEqual([a.id]);
  });
  test("names are hard links to their hash's file, which is the blob; folders 0555, files 0444", async () => {
    const s = store();
    put(s, BUN);
    const g = (await buildGeneration(s, "linux", [bun, { ...bun, name: "bun-copy.zip" }])).gen!;
    const blob = lstatSync(blobPath(s, bun.sha256)).ino;
    expect(lstatSync(join(g.dir, "sha256", bun.sha256)).ino).toBe(blob);
    expect(lstatSync(join(g.dir, "by-name", "bun-1.3.13.zip")).ino).toBe(blob);
    expect(lstatSync(join(g.dir, "by-name", "bun-copy.zip")).ino).toBe(blob);
    for (const d of [join(s.gen, g.id), g.dir, join(g.dir, "sha256"), join(g.dir, "by-name")]) expect(statSync(d).mode & 0o777).toBe(0o555);
    expect(statSync(join(g.dir, "manifest.json")).mode & 0o777).toBe(0o444);
    expect(await generationProblem(s, g.id, "linux")).toBeUndefined();
  });
  test("a pin with no blob is left out and named; none held is no generation", async () => {
    const s = store();
    put(s, BUN);
    const r = await buildGeneration(s, "linux", [bun, node]);
    expect(r.missing).toEqual(["node-24.22.3.tar.xz"]);
    expect(r.gen!.manifest.entries.map((e) => e.name)).toEqual(["bun-1.3.13.zip"]);
    expect(await buildGeneration(s, "macos", [bun, node])).toEqual({ missing: [] });
  });
  test("a link in place of a blob is no blob", async () => {
    const s = store();
    writeFileSync(join(s.root, "elsewhere"), BUN);
    symlinkSync(join(s.root, "elsewhere"), blobPath(s, bun.sha256));
    expect((await buildGeneration(s, "linux", [bun])).missing).toEqual([bun.name]);
  });
  test("a generation with a link, an extra file or a changed file fails its check, and is made again", async () => {
    const s = store();
    put(s, BUN);
    const g = (await buildGeneration(s, "linux", [bun])).gen!;
    chmodSync(g.dir, 0o755);
    symlinkSync("/etc/hosts", join(g.dir, "extra"));
    expect(await generationProblem(s, g.id, "linux")).toBe("a folder in it can be written");
    chmodSync(g.dir, 0o555);
    expect(await generationProblem(s, g.id, "linux")).toBe("it holds files it shouldn't");
    // Built again: the bad one goes, and the new one passes.
    const again = (await buildGeneration(s, "linux", [bun])).gen!;
    expect(again.id).toBe(g.id);
    expect(await generationProblem(s, g.id, "linux")).toBeUndefined();
  });
  test("a blob changed in place fails the generation's check and is dropped as bad", async () => {
    const s = store();
    put(s, BUN);
    const g = (await buildGeneration(s, "linux", [bun])).gen!;
    chmodSync(blobPath(s, bun.sha256), 0o644);
    writeFileSync(blobPath(s, bun.sha256), "poisoned");
    // The mode is the one inode's, so the link in the generation shows it too.
    expect(await generationProblem(s, g.id, "linux")).toBe("a file in it can be written");
    chmodSync(blobPath(s, bun.sha256), 0o444);
    expect(await generationProblem(s, g.id, "linux")).toContain("doesn't match its hash");
    expect(await dropBadBlobs(s)).toEqual([bun.sha256]);
    expect(readdirSync(s.blobs)).toEqual([]);
  });
  test("a by-name entry that is a separate copy of the hash's file fails", async () => {
    const s = store();
    put(s, BUN);
    const g = (await buildGeneration(s, "linux", [bun])).gen!;
    const byName = join(g.dir, "by-name");
    chmodSync(byName, 0o755);
    removeTree(join(byName, bun.name));
    writeFileSync(join(byName, bun.name), BUN, { mode: 0o444 });
    chmodSync(byName, 0o555);
    expect(await generationProblem(s, g.id, "linux")).toBe(`${bun.name} isn't its hash's file`);
  });
  test("removeTree opens sealed folders and never follows a link", () => {
    const s = store();
    const outside = join(s.root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep"), "x");
    const t = join(s.gen, "t");
    mkdirSync(t);
    symlinkSync(outside, join(t, "link"));
    linkSync(join(outside, "keep"), join(t, "hard"));
    chmodSync(t, 0o555);
    removeTree(t);
    expect(readdirSync(outside)).toEqual(["keep"]);
  });
});
