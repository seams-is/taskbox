// A security key's SSH signature, made in memory, for tests of the approver key and of signed
// releases (src/release.ts): OpenSSH's SSHSIG format
// (PROTOCOL.sshsig) around an sk-ecdsa-sha2-nistp256@openssh.com signature (PROTOCOL.u2f), the type
// the Secure Enclave key is to OpenSSH. The P-256 private half lives only in memory.
import { createHash, generateKeyPairSync, type KeyObject, sign as ecSign } from "node:crypto";
import { NAMESPACE as RELEASE_NAMESPACE } from "../src/release.ts";
// The approver key's namespace, the default; a release test names the release's.
const NAMESPACE = "taskbox-workspace";

const SK = "sk-ecdsa-sha2-nistp256@openssh.com";
const APP = "ssh:";
const str = (b: Uint8Array | string) => {
  const data = typeof b === "string" ? new TextEncoder().encode(b) : b;
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  return Buffer.concat([len, data]);
};
const mpint = (b: Buffer) => {
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  const v = b.subarray(i);
  return str(v[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), v]) : v);
};
const sha = (alg: string, b: Uint8Array) => createHash(alg).update(b).digest();

export function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  const q = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]);
  const blob = Buffer.concat([str(SK), str("nistp256"), str(q), str(APP)]);
  // key: the public key; line: the same as a signers file pins a release key.
  return { privateKey, blob, key: `${SK} ${blob.toString("base64")}`, line: `taskbox-release namespaces="${RELEASE_NAMESPACE}" ${SK} ${blob.toString("base64")}\n` };
}

// An armoured SSH signature of message by a security key, as ssh-keygen -Y sign writes it. flags 1 is
// user presence, 4 user verification. blobNamespace, for tests of ssh-keygen's own namespace check:
// the namespace the armour says, when it isn't the one signed.
export function sshsig(k: { privateKey: KeyObject; blob: Buffer }, message: Uint8Array, o: { namespace?: string; flags?: number; blobNamespace?: string } = {}): string {
  const namespace = o.namespace ?? NAMESPACE;
  const flags = o.flags ?? 0x05;
  const signed = Buffer.concat([Buffer.from("SSHSIG"), str(namespace), str(""), str("sha512"), str(sha("sha512", message))]);
  const counter = Buffer.alloc(4);
  counter.writeUInt32BE(1);
  const sk = Buffer.concat([sha("sha256", Buffer.from(APP)), Buffer.from([flags]), counter, sha("sha256", signed)]);
  const rs = ecSign("sha256", sk, { key: k.privateKey, dsaEncoding: "ieee-p1363" });
  const sig = Buffer.concat([str(SK), str(Buffer.concat([mpint(rs.subarray(0, 32)), mpint(rs.subarray(32))])), Buffer.from([flags]), counter]);
  const ver = Buffer.alloc(4);
  ver.writeUInt32BE(1);
  const body = Buffer.concat([Buffer.from("SSHSIG"), ver, str(k.blob), str(o.blobNamespace ?? namespace), str(""), str("sha512"), str(sig)]).toString("base64");
  return `-----BEGIN SSH SIGNATURE-----\n${body.match(/.{1,70}/g)!.join("\n")}\n-----END SSH SIGNATURE-----\n`;
}

