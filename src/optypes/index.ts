// Every op type's one declaration (decl.ts), by static import, so the engine compiles to one binary.
// A package adds src/optypes/<package>.ts and one line below, sorted by file. Code that begins an op
// takes its type from here (opType), so no type is declared twice.
import * as availability from "./availability.ts";
import * as connect from "./connect.ts";
import type { OpDecl } from "./decl.ts";
import * as remove from "./remove.ts";
import * as settings from "./settings.ts";
import * as tools from "./tools.ts";
import * as workspace from "./workspace.ts";

export const opTypeFiles: readonly { file: string; optypes: readonly OpDecl[] }[] = [
  { file: "availability.ts", optypes: availability.optypes },
  { file: "connect.ts", optypes: connect.optypes },
  { file: "remove.ts", optypes: remove.optypes },
  { file: "settings.ts", optypes: settings.optypes },
  { file: "tools.ts", optypes: tools.optypes },
  { file: "workspace.ts", optypes: workspace.optypes },
];

export const opDecls = (): OpDecl[] => {
  const all = opTypeFiles.flatMap((f) => f.optypes);
  const names = all.map((d) => d.type);
  if (new Set(names).size !== names.length) throw new Error("two files declare one op type");
  return all;
};
export const declOf = (type: string): OpDecl | undefined => opDecls().find((d) => d.type === type);
// A type code begins: declared, or a throw, so a type is never begun undeclared.
export function opType(type: string): OpDecl {
  const d = declOf(type);
  if (!d) throw new Error(`the ${type} op type isn't declared in src/optypes`);
  return d;
}
