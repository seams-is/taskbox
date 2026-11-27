// The engine compiles to one binary that reads nothing from disk about itself. So no file in src
// asks where its own code is, but src/self.ts; none loads a module by a name made at run time; every
// file src imports is in src, or a data file src/embedded.ts reads in; and each data file is the
// repo's, byte for byte. CI builds each binary and runs it (.github/workflows/ci.yml, compiled).
// Files are read with TypeScript's own parser, so comments and the words of strings are never code.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { EMBEDDED } from "../src/embedded.ts";
import { SOURCE_TREE } from "../src/self.ts";

const REPO = join(import.meta.dir, "..");

// The scanner is a guard against mistakes, never proof: review stays the authority on what src reads.
// It allows, by name, the few members of process and Bun that say nothing of where the code is, and
// flags every other reference to them, to require, module, globalThis, eval and Function, so an
// alias, a destructuring or an element access is caught without chasing it.

// Calls that open or list a path. A first word that is a repo path in a string is a self read.
const OPENERS = new Set(["readdirSync", "readFileSync", "readdir", "readFile", "existsSync", "statSync", "lstatSync", "opendirSync", "openSync", "open", "createReadStream", "realpathSync", "readlinkSync", "accessSync", "file"]);
const REPO_PATH = /^(\.\.?\/|src\/|templates\/|signers\/|launchd\/|test\/|versions\.json)/;
const PROCESS_OK = new Set(["arch", "env", "exit", "exitCode", "getuid", "getgid", "kill", "on", "once", "off", "pid", "platform", "stdin", "stdout", "stderr", "hrtime", "umask", "uptime", "nextTick"]);
const BUN_OK = new Set(["gunzipSync", "gzipSync", "serve", "spawn", "spawnSync", "stdin", "stdout", "stderr", "sleep", "hash", "CryptoHasher"]);
// The entries bun runs, which read their own words as process.argv.slice(2) and nothing else of argv.
export const ENTRIES = ["src/cli.ts", "src/gate.ts", "src/shell.ts", "src/listen.ts", "src/workspace/probe.ts", "src/controller/main.ts"];
// Files that hand the whole process object to a function, which reads only its named members
// (remove.ts: proc for signals; core/events.ts: on, off and exit).
const WHOLE_PROCESS = ["src/cmd/remove.ts", "src/core/events.ts"];
// Modules a named file may import beyond node's and relative ones: gate.ts lowers its process limit
// through libc (bun:ffi).
const MODULES: Record<string, string[]> = { "src/gate.ts": ["bun:ffi"] };
const NEVER = new Set(["module", "globalThis", "eval", "Function", "__dirname", "__filename", "createRequire"]);
// A module a file may load: one of node's, or a relative path to one in the tree the bundle holds.
const LOADABLE = /^(node:|\.\.?\/)/;

const text = (n: ts.Node | undefined): string | undefined => (n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : n && ts.isTemplateExpression(n) ? n.head.text : undefined);

// Whether an identifier names a value here, rather than being a property's or a declaration's name.
function isReference(n: ts.Identifier): boolean {
  const p = n.parent;
  if (ts.isPropertyAccessExpression(p) && p.name === n) return false;
  if ((ts.isPropertyAssignment(p) || ts.isPropertySignature(p) || ts.isPropertyDeclaration(p) || ts.isMethodDeclaration(p) || ts.isMethodSignature(p)) && p.name === n) return false;
  if (ts.isBindingElement(p) && p.propertyName === n) return false;
  if (ts.isQualifiedName(p) && p.right === n) return false;
  return true;
}

// Each self read in a file's code, as "line: what". file: its path in the repo, for what it may use.
function selfReads(source: string, file = "src/x.ts"): string[] {
  const sf = ts.createSourceFile("x.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: string[] = [];
  const hit = (n: ts.Node, what: string) => found.push(`${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}: ${what}`);
  const entry = ENTRIES.includes(file);
  const visit = (n: ts.Node) => {
    // import.meta is only ever import.meta.main, the entry check, and in src/self.ts import.meta.dir.
    if (ts.isMetaProperty(n) && n.keywordToken === ts.SyntaxKind.ImportKeyword) {
      const p = n.parent;
      const name = ts.isPropertyAccessExpression(p) && p.expression === n ? p.name.text : undefined;
      if (!(name === "main" || (file === "src/self.ts" && name === "dir"))) hit(n, `import.meta${name ? `.${name}` : " by itself"}`);
    }
    if (ts.isIdentifier(n) && isReference(n)) {
      const p = n.parent;
      const member = ts.isPropertyAccessExpression(p) && p.expression === n ? p.name.text : undefined;
      if (NEVER.has(n.text)) hit(n, n.text);
      if (n.text === "process" && !(member && PROCESS_OK.has(member))) {
        // process.argv.slice(2), in an entry: the words it was given.
        const slice = member === "argv" && ts.isPropertyAccessExpression(p.parent) && p.parent.name.text === "slice" && ts.isCallExpression(p.parent.parent) && p.parent.parent.arguments.length === 1 && text(p.parent.parent.arguments[0]) === undefined && p.parent.parent.arguments[0]!.getText(sf) === "2";
        const whole = member === undefined && WHOLE_PROCESS.includes(file) && !ts.isElementAccessExpression(p) && !ts.isVariableDeclaration(p) && !ts.isBindingElement(p);
        if (!(slice && entry) && !whole) hit(n, `process${member ? `.${member}` : " but by an allowed member"}`);
      }
      if (n.text === "Bun" && !(member && BUN_OK.has(member))) hit(n, `Bun${member ? `.${member}` : " but by an allowed member"}`);
      if (n.text === "require") {
        const call = ts.isCallExpression(p) && p.expression === n ? p : undefined;
        const first = call?.arguments[0];
        if (!(call && first && ts.isStringLiteral(first) && first.text.startsWith("node:"))) hit(n, "require of a module that isn't node's");
      }
    }
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      const first = n.arguments[0];
      const word = text(first);
      if (callee.kind === ts.SyntaxKind.ImportKeyword && !(first && ts.isStringLiteral(first) && LOADABLE.test(first.text))) hit(n, "import() of a module that isn't node's or a relative path");
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
      if (name && OPENERS.has(name) && word !== undefined && REPO_PATH.test(word)) hit(n, `${name} of a repo path`);
    }
    // A static import from node's own process or module: process and require by another name.
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      const m = n.moduleSpecifier.text;
      if (["process", "node:process", "module", "node:module"].includes(m)) hit(n, `import from ${m}`);
      else if (!LOADABLE.test(m) && !(MODULES[file] ?? []).includes(m)) hit(n, `import from ${m}`);
    }
    if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && (n.expression.text === "Worker" || n.expression.text === "Glob")) hit(n, `new ${n.expression.text}`);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

// Every relative module a file imports or exports from, by its words.
function importsOf(source: string): string[] {
  const sf = ts.createSourceFile("x.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) out.push(n.moduleSpecifier.text);
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) out.push(n.arguments[0].text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out.filter((m) => m.startsWith("."));
}

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));
}

describe("the compiled engine reads nothing from disk about itself", () => {
  test("no file in src asks where its code is, or loads a module by a name made at run time, but src/self.ts", () => {
    const found: Record<string, string[]> = {};
    for (const f of sources(join(REPO, "src"))) {
      const rel = relative(REPO, f);
      const why = selfReads(readFileSync(f, "utf8"), rel);
      if (why.length) found[rel] = why;
    }
    expect(found).toEqual({});
  });

  test("every file src imports is in src, or one of the data files src/embedded.ts reads in", () => {
    const outside: string[] = [];
    for (const f of sources(join(REPO, "src"))) {
      for (const m of importsOf(readFileSync(f, "utf8"))) {
        const to = relative(REPO, resolve(dirname(f), m));
        if (to.startsWith("src/")) continue;
        if (relative(REPO, f) === "src/embedded.ts" && to in EMBEDDED) continue;
        outside.push(`${relative(REPO, f)} imports ${to}`);
      }
    }
    expect(outside).toEqual([]);
  });

  test("src/self.ts reads import.meta.dir, and names no source tree in the compiled engine", () => {
    const self = readFileSync(join(REPO, "src/self.ts"), "utf8");
    expect(selfReads(self)).toEqual([expect.stringContaining("import.meta.dir")]);
    expect(selfReads(self, "src/self.ts")).toEqual([]);
    expect(self).toContain('startsWith("/$bunfs/")');
    expect(SOURCE_TREE).toBe(REPO);
  });

  test("the check finds each way in", () => {
    const bad = [
      "const d = import.meta.dir;",
      "const u = new URL('.', import.meta.url);",
      "const r = import.meta.require('./x');",
      "const m = import.meta; const d = m.dir;",
      'const d = import.meta["dir"];',
      // A glob or a comment's marks in a string never hide code after them.
      'const a = "src/*.ts"; const d = import.meta.dir; const b = "*/";',
      'const u = "a // b"; const d = import.meta.dir;',
      "const t = `/*`; const d = import.meta.dir;",
      "const d = __dirname;",
      "if (Bun.main) 1;",
      "const a = Bun.argv[1];",
      "const s = process.argv[1];",
      "const s = process.argv.at(1);",
      "const s = process.argv0;",
      'readFileSync(join(dirname(process.execPath), "signers/allowed_signers"));',
      "const m = require(join(dir, f));",
      'const m = require("./x.ts");',
      'const p = require.resolve("node:fs");',
      'const r = createRequire(x)("./y");',
      "const m = await import(name);",
      'new Worker("./x.ts");',
      'const g = new Glob("src/*.ts");',
      'readdirSync("src/cmd");',
      "readFileSync(`../templates/${name}.yml`);",
      'openSync("signers/allowed_signers", "r");',
      'createReadStream("./templates/x.yml");',
      'realpathSync("../..");',
      'Bun.file("versions.json");',
      // process, Bun and require by another name, or taken apart.
      "const p = process; const e = p.execPath;",
      "const { execPath } = process;",
      'const e = process["execPath"];',
      "const e = globalThis.process.execPath;",
      "const B = Bun; const m = B.main;",
      "const [, me] = process.argv;",
      "const me = process.argv.slice(1)[0];",
      'const r = require; r("./x");',
      'module.require("./x");',
      'const m = await import("/opt/taskbox/app/src/x.ts");',
      'const m = await import("some-package");',
      'import { execPath } from "node:process";',
      'import { createRequire as make } from "node:module";',
      'eval("1");',
      'const f = new Function("return 1");',
      "const c = process.cwd();",
    ];
    for (const b of bad) expect({ b, found: selfReads(b).length > 0 }).toEqual({ b, found: true });
    const fine = [
      'const fs = require("node:fs");',
      'const { x } = await import("../x.ts");',
      "// import.meta.dir in a comment",
      "/* import.meta.dir */ const a = 1;",
      'const s = "import.meta.dir and require(x) in a message";',
      'readFileSync(join(root, "opt/taskbox/installed.json"));',
      "const o = { execPath: 1 }.execPath;",
    ];
    for (const f of fine) expect({ f, found: selfReads(f) }).toEqual({ f, found: [] });
    // An entry reads its own words, and only an entry; a named file may hand process on whole.
    expect(selfReads("if (import.meta.main) run(process.argv.slice(2));", "src/cli.ts")).toEqual([]);
    expect(selfReads("if (import.meta.main) run(process.argv.slice(2));")).toEqual(["1: process.argv"]);
    expect(selfReads("run({ proc: process });", "src/cmd/remove.ts")).toEqual([]);
    expect(selfReads("const p = process; p.execPath;", "src/cmd/remove.ts")).toEqual(["1: process but by an allowed member"]);
    expect(selfReads('import { dlopen } from "bun:ffi";', "src/gate.ts")).toEqual([]);
    expect(selfReads('import { dlopen } from "bun:ffi";')).toEqual(["1: import from bun:ffi"]);
    // Property and declaration names are not references.
    expect(selfReads("const o = { module: 1, process: 2 }; const { module: m } = x; interface I { module: string }")).toEqual([]);
    // Each finding names its line.
    expect(selfReads("const a = 1;\nconst d = import.meta.dir;\n")).toEqual(["2: import.meta.dir"]);
    expect(importsOf('import a from "../x.ts";\nexport { b } from "./y.ts";\nawait import("../z.ts");\nimport "node:fs";')).toEqual(["../x.ts", "./y.ts", "../z.ts"]);
  });
});

describe("the engine's data files are read in when it is built", () => {
  test("each is the repo's file, byte for byte", () => {
    for (const [path, body] of Object.entries(EMBEDDED)) expect({ path, same: body === readFileSync(join(REPO, path), "utf8") }).toEqual({ path, same: true });
  });

  test("every template and signers file in the repo is one of them", () => {
    const want = [...readdirSync(join(REPO, "signers")).map((f) => `signers/${f}`), ...readdirSync(join(REPO, "templates")).filter((f) => f.endsWith(".yml")).map((f) => `templates/${f}`)].sort();
    expect(Object.keys(EMBEDDED).sort()).toEqual(want);
  });
});
