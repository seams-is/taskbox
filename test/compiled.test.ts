// The engine compiles to one binary that reads nothing from disk about itself. So no file in src
// asks where its own code is, but src/self.ts; none loads a module by a name made at run time; and
// every data file the engine uses is read in when it is built (src/embedded.ts), byte for byte. CI
// builds the binary and runs it (.github/workflows/ci.yml, compiled).
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { EMBEDDED, SIGNERS_TEXT, TEMPLATE_TEXT } from "../src/embedded.ts";
import { SOURCE_TREE } from "../src/self.ts";

const REPO = join(import.meta.dir, "..");

// Each way code finds or loads its own files at run time, which a compiled engine doesn't have.
const SELF_READS: { what: string; re: RegExp }[] = [
  { what: "import.meta.dir and its kin", re: /import\.meta\.(dir|dirname|path|url|file|filename|resolve)\b/ },
  { what: "__dirname or __filename", re: /\b__(dirname|filename)\b/ },
  { what: "Bun.main", re: /\bBun\.main\b/ },
  { what: "process.argv[1]", re: /process\.argv\[1\]/ },
  { what: "require of a module that isn't node's", re: /\brequire\(\s*(?!["']node:)/ },
  { what: "import() of a name made at run time", re: /\bimport\(\s*(?!["'])/ },
  { what: "a read of a path in this repo", re: /\b(readdirSync|readFileSync|readdir|readFile|existsSync|statSync|lstatSync|opendirSync|Bun\.file)\(\s*["'`](\.\.?\/|src\/|templates\/|signers\/|launchd\/|versions\.json)/ },
];

// What a file's code says, with its comments and the words of its strings left out, so a sentence
// about import.meta.dir is not a use of it. Template literals keep their text: a path in one counts.
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

function selfReads(text: string): string[] {
  const body = code(text);
  return SELF_READS.filter((r) => r.re.test(body)).map((r) => r.what);
}

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));
}

describe("the compiled engine reads nothing from disk about itself", () => {
  test("no file in src asks where its code is, or loads a module by a name made at run time, but src/self.ts", () => {
    const found: Record<string, string[]> = {};
    for (const f of sources(join(REPO, "src"))) {
      const rel = relative(REPO, f);
      if (rel === "src/self.ts") continue;
      const why = selfReads(readFileSync(f, "utf8"));
      if (why.length) found[rel] = why;
    }
    expect(found).toEqual({});
  });

  test("src/self.ts asks only for its folder, and names no source tree in the compiled engine", () => {
    const text = code(readFileSync(join(REPO, "src/self.ts"), "utf8"));
    expect(new Set(text.match(/import\.meta\.\w+/g))).toEqual(new Set(["import.meta.dir"]));
    expect(text).toContain('startsWith("/$bunfs/")');
    expect(SOURCE_TREE).toBe(REPO);
  });

  test("the check finds each way in", () => {
    const bad = [
      "const d = import.meta.dir;",
      "const u = new URL('.', import.meta.url);",
      "const d = __dirname;",
      "if (Bun.main) 1;",
      "const s = process.argv[1];",
      "const m = require(join(dir, f));",
      "const m = await import(name);",
      'readdirSync("src/cmd");',
      "readFileSync(`../templates/x.yml`);",
    ];
    for (const b of bad) expect({ b, found: selfReads(b).length }).toEqual({ b, found: 1 });
    const fine = ['const fs = require("node:fs");', 'const { x } = await import("../x.ts");', "// import.meta.dir in a comment", 'readFileSync(join(root, "opt/taskbox/installed.json"));'];
    for (const f of fine) expect({ f, found: selfReads(f) }).toEqual({ f, found: [] });
  });
});

describe("the engine's data files are read in when it is built", () => {
  test("each is the repo's file, byte for byte", () => {
    for (const [path, text] of Object.entries(EMBEDDED)) expect({ path, same: text === readFileSync(join(REPO, path), "utf8") }).toEqual({ path, same: true });
    expect(SIGNERS_TEXT).toBe(readFileSync(join(REPO, "signers/allowed_signers"), "utf8"));
    expect(TEMPLATE_TEXT).toEqual({ canary: EMBEDDED["templates/taskbox-canary.yml"]!, load: EMBEDDED["templates/taskbox-load.yml"]!, watchdog: EMBEDDED["templates/taskbox-watchdog.yml"]! });
  });

  test("every template, plist and signers file in the repo is one of them, with versions.json", () => {
    const want = [
      ...readdirSync(join(REPO, "launchd")).map((f) => `launchd/${f}`),
      ...readdirSync(join(REPO, "signers")).map((f) => `signers/${f}`),
      ...readdirSync(join(REPO, "templates")).filter((f) => f.endsWith(".yml")).map((f) => `templates/${f}`),
      "versions.json",
    ].sort();
    expect(Object.keys(EMBEDDED)).toEqual(want);
  });
});
