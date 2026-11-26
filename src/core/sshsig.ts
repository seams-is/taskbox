// The one reader of an armoured SSH signature (PROTOCOL.sshsig) made by a security key
// (PROTOCOL.u2f, sk-ecdsa-sha2-nistp256@openssh.com), the only kind taskbox takes. It decodes; it
// decides nothing. ssh-keygen -Y verify is what checks a signature, and callers read the flags,
// namespace and key from here.
export const SK = "sk-ecdsa-sha2-nistp256@openssh.com";

export interface Sshsig {
  blob: Buffer; // the signing key's public blob, as a key line's second field decodes
  namespace: string;
  reserved: Buffer;
  alg: string; // sha256 or sha512 over the message
  ecdsa: Buffer; // the ECDSA signature's blob: r and s as mpints (rs)
  flags: number; // 1: the user was present; 4: verified
  counter: Buffer; // 4 bytes
}

// SSH wire strings read in turn; a read past the end throws.
function reader(b: Buffer) {
  let off = 0;
  const take = (n: number) => {
    if (off + n > b.length) throw new Error("short");
    return b.subarray(off, (off += n));
  };
  return { take, str: () => take(take(4).readUInt32BE(0)), done: () => off === b.length };
}

// The ECDSA signature's r and s, each 32 bytes, or undefined when they aren't two P-256 mpints.
export function rsOf(ecdsa: Buffer): { r: Buffer; s: Buffer } | undefined {
  try {
    const rs = reader(ecdsa);
    const int = (v: Buffer) => {
      let i = 0;
      while (i < v.length - 1 && v[i] === 0) i++;
      const t = v.subarray(i);
      if (t.length > 32) throw new Error("long");
      return Buffer.concat([Buffer.alloc(32 - t.length), t]);
    };
    const r = int(rs.str());
    const s = int(rs.str());
    return rs.done() ? { r, s } : undefined;
  } catch {
    return undefined;
  }
}

// The signature's parts, or undefined when it isn't a security key's SSHSIG with nothing left over.
export function parseSshsig(armoured: string | Uint8Array): Sshsig | undefined {
  const text = typeof armoured === "string" ? armoured : new TextDecoder().decode(armoured);
  const m = /^-----BEGIN SSH SIGNATURE-----\n([A-Za-z0-9+/=\n]+)-----END SSH SIGNATURE-----\n?$/.exec(text);
  if (!m) return undefined;
  try {
    const outer = reader(Buffer.from(m[1]!.replace(/\n/g, ""), "base64"));
    if (outer.take(6).toString("latin1") !== "SSHSIG" || outer.take(4).readUInt32BE(0) !== 1) return undefined;
    const blob = outer.str();
    const namespace = outer.str().toString("latin1");
    const reserved = outer.str();
    const alg = outer.str().toString("latin1");
    const sig = reader(outer.str());
    if (!outer.done()) return undefined;
    if (sig.str().toString("latin1") !== SK) return undefined;
    const ecdsa = sig.str();
    const flags = sig.take(1)[0]!;
    const counter = sig.take(4);
    if (!sig.done()) return undefined;
    return { blob: Buffer.from(blob), namespace, reserved: Buffer.from(reserved), alg, ecdsa: Buffer.from(ecdsa), flags, counter: Buffer.from(counter) };
  } catch {
    return undefined;
  }
}

// The flags a security key's signature carries, or undefined when it isn't one. ssh-keygen -Y verify
// accepts a signature whatever its flags, so taskbox reads them here. namespace: the one the signature
// must name, when the caller needs one.
export function skFlags(armoured: string | Uint8Array, namespace?: string): number | undefined {
  const p = parseSshsig(armoured);
  return p && (namespace === undefined || p.namespace === namespace) ? p.flags : undefined;
}
