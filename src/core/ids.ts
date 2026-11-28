// ULIDs (ulid/spec): 48 bits of milliseconds and 80 random bits, in Crockford's base32, 26
// characters. They sort by time as text, so ids from two writers merge in order. Ids carry a prefix
// that says what they name: ev_ for an event, op_ for an op, rq_ for a spool request, pc_ for a
// lasting change waiting for confirm.
import { randomBytes } from "node:crypto";

const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

// rand gives n random bytes; tests pass their own.
export type Rand = (n: number) => Uint8Array;
export const realRand: Rand = (n) => randomBytes(n);

export function ulid(now: number, rand: Rand = realRand): string {
  if (!Number.isSafeInteger(now) || now < 0 || now >= 2 ** 48) throw new Error("a ULID's time is out of range");
  let t = now;
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = B32[t % 32]! + time;
    t = Math.floor(t / 32);
  }
  const r = rand(10);
  if (r.length !== 10) throw new Error("a ULID needs 10 random bytes");
  // 80 bits as 16 characters of 5 bits each.
  let bits = 0n;
  for (const b of r) bits = (bits << 8n) | BigInt(b);
  let tail = "";
  for (let i = 0; i < 16; i++) {
    tail = B32[Number(bits & 31n)]! + tail;
    bits >>= 5n;
  }
  return time + tail;
}

export const PREFIXES = ["ev", "op", "rq", "pc"] as const;
export type Prefix = (typeof PREFIXES)[number];
export const idOf = (prefix: Prefix, now: number, rand: Rand = realRand) => `${prefix}_${ulid(now, rand)}`;
export const isId = (prefix: Prefix, v: unknown): v is string => typeof v === "string" && v.startsWith(`${prefix}_`) && ULID.test(v.slice(prefix.length + 1));

// ULIDs from one writer that keep their order within a millisecond (the spec's monotonic mode): an
// id made in the same millisecond as the last, or with the clock stepped back, is the last plus one.
export function monotonic(rand: Rand = realRand): (now: number) => string {
  let last = "";
  return (now) => {
    const next = ulid(now, rand);
    if (last && next.slice(0, 10) <= last.slice(0, 10)) {
      last = increment(last);
      return last;
    }
    last = next;
    return next;
  };
}

function increment(id: string): string {
  const chars = id.split("");
  for (let i = chars.length - 1; i >= 10; i--) {
    const v = B32.indexOf(chars[i]!);
    if (v < 31) {
      chars[i] = B32[v + 1]!;
      return chars.join("");
    }
    chars[i] = "0";
  }
  throw new Error("a ULID's random part ran out within one millisecond");
}
