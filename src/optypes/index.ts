// Every op type's declaration (decl.ts), by static import, so the engine compiles to one binary. A
// package adds src/optypes/<package>.ts and one line below, sorted by file. A test checks that every
// op type in src is declared here.
import * as availability from "./availability.ts";
import type { OpDecl } from "./decl.ts";
import * as remove from "./remove.ts";

export const opTypeFiles: readonly { file: string; optypes: readonly OpDecl[] }[] = [
  { file: "availability.ts", optypes: availability.optypes },
  { file: "remove.ts", optypes: remove.optypes },
];

export const opDecls = (): OpDecl[] => {
  const all = opTypeFiles.flatMap((f) => f.optypes);
  const names = all.map((d) => d.type);
  if (new Set(names).size !== names.length) throw new Error("two files declare one op type");
  return all;
};
export const declOf = (type: string): OpDecl | undefined => opDecls().find((d) => d.type === type);
