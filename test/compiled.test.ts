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

// Calls that open or list a path. A first word that is a repo path in a string is a self read.
const OPENERS = new Set(["readdirSync", "readFileSync", "readdir", "readFile", "existsSync", "statSync", "lstatSync", "opendirSync", "openSync", "open", "createReadStream", "realpathSync", "readlinkSync", "accessSync", "file"]);
const REPO_PATH = /^(\.\.?\/|src\/|templates\/|signers\/|launchd\/|test\/|versions\.json)/;
// Names of the running program or its folder.
const SELF_NAMES: Record<string, string[]> = { process: ["execPath", "argv0", "mainModule"], Bun: ["main", "argv", "resolve", "resolveSync", "Glob"], require: ["resolve", "main", "cache"] };

const text = (n: ts.Node | undefined): string | undefined => (n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : n && ts.isTemplateExpression(n) ? n.head.text : undefined);

// Each self read in a file's code, as "line: what". allowDir: src/self.ts, which may read import.meta.dir.
function selfReads(source: string, allowDir = false): string[] {
  const sf = ts.createSourceFile("x.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: string[] = [];
  const hit = (n: ts.Node, what: string) => found.push(`${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}: ${what}`);
  const visit = (n: ts.Node) => {
    // import.meta is only ever import.meta.main, the entry check, and in src/self.ts import.meta.dir.
    if (ts.isMetaProperty(n) && n.keywordToken === ts.SyntaxKind.ImportKeyword) {
      const p = n.parent;
      const name = ts.isPropertyAccessExpression(p) && p.expression === n ? p.name.text : undefined;
      if (!(name === "main" || (allowDir && name === "dir"))) hit(n, `import.meta${name ? `.${name}` : " by itself"}`);
    }
    if (ts.isIdentifier(n) && (n.text === "__dirname" || n.text === "__filename" || n.text === "createRequire") && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)) hit(n, n.text);
    if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && SELF_NAMES[n.expression.text]?.includes(n.name.text)) hit(n, `${n.expression.text}.${n.name.text}`);
    // process.argv's words after the command's own are fine: argv[1] and argv.at(1) name the program.
    if (ts.isPropertyAccessExpression(n) && n.name.text === "argv" && ts.isIdentifier(n.expression) && n.expression.text === "process") {
      const p = n.parent;
      if (ts.isElementAccessExpression(p) || (ts.isPropertyAccessExpression(p) && p.name.text === "at")) hit(n, "process.argv by index");
    }
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      const first = n.arguments[0];
      const word = text(first);
      if (callee.kind === ts.SyntaxKind.ImportKeyword && word === undefined) hit(n, "import() of a name made at run time");
      if (ts.isIdentifier(callee) && callee.text === "require" && !(word !== undefined && word.startsWith("node:") && ts.isStringLiteral(first!))) hit(n, "require of a module that isn't node's");
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
      if (name && OPENERS.has(name) && word !== undefined && REPO_PATH.test(word)) hit(n, `${name} of a repo path`);
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
      const why = selfReads(readFileSync(f, "utf8"), rel === "src/self.ts");
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
    ];
    for (const b of bad) expect({ b, found: selfReads(b).length > 0 }).toEqual({ b, found: true });
    const fine = [
      'const fs = require("node:fs");',
      'const { x } = await import("../x.ts");',
      "// import.meta.dir in a comment",
      "/* import.meta.dir */ const a = 1;",
      'const s = "import.meta.dir and require(x) in a message";',
      "if (import.meta.main) run(process.argv.slice(2));",
      'readFileSync(join(root, "opt/taskbox/installed.json"));',
      "const o = { execPath: 1 }.execPath;",
    ];
    for (const f of fine) expect({ f, found: selfReads(f) }).toEqual({ f, found: [] });
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
