// The one way taskbox hands ssh-keygen -Y verify a pin and a signature: a fresh folder from mkdtemp,
// owned by whoever runs this (root's when run as root), both files written into it from bytes in
// memory as new files, and the folder removed after, whatever happens, a partial write included. So
// ssh-keygen reads only files nobody else could have placed or swapped, whatever folder the caller
// keeps. readable: the folder at 755 and the files at 644, for ssh-keygen run as nobody (hop.ts);
// else 700 and 600.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export async function inVerifyFolder<T>(root: string, o: { signers: string; signature: string | Uint8Array; readable?: boolean }, run: (f: { signers: string; signature: string }) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(root, "taskbox-verify-"));
  try {
    const mode = o.readable ? 0o644 : 0o600;
    chmodSync(dir, o.readable ? 0o755 : 0o700);
    const signers = join(dir, "allowed_signers");
    const signature = join(dir, "statement.json.sig");
    writeFileSync(signers, o.signers, { mode, flag: "wx" });
    writeFileSync(signature, o.signature, { mode, flag: "wx" });
    // The umask may have taken bits off.
    chmodSync(signers, mode);
    chmodSync(signature, mode);
    return await run({ signers, signature });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
