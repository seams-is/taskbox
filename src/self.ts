// The source tree this code runs from: the app folder (an install's app/, or a checkout), or
// undefined in the compiled engine, which carries its files inside it (src/embedded.ts). This is
// the one file in src that asks where its own code is (test/compiled.test.ts).
import { join } from "node:path";

// bun names a compiled engine's own files under /$bunfs/.
export const SOURCE_TREE: string | undefined = import.meta.dir.startsWith("/$bunfs/") ? undefined : join(import.meta.dir, "..");
