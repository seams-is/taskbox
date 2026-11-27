// The source tree this code runs from: the app folder (an install's app/, or a checkout), or
// undefined in the compiled engine, which carries its files inside it (src/embedded.ts). This is
// the one file in src that asks where its own code is (test/compiled.test.ts).
import { existsSync } from "node:fs";
import { join } from "node:path";

// bun names a compiled engine's own files under /$bunfs/, and keeps no file by itself there. Either
// says compiled, so a bun that names them otherwise still gets no source tree.
const here = import.meta.dir;
export const SOURCE_TREE: string | undefined = !here.startsWith("/$bunfs/") && existsSync(join(here, "self.ts")) ? join(here, "..") : undefined;
