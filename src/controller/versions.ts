// Each paired box's last agreed answers version and release, kept beside the pairing in
// answers.json (0600). A box that drops to an older version, as after a rollback to v2.6.1, reads
// on (N-1), and the controller says so once.
import { join } from "node:path";
import { type Home, NODE, readSmall, writePrivateFile } from "./home.ts";

type Seen = Record<string, { answers: number; release: string | null }>;

function read(h: Home): Seen {
  try {
    const f = readSmall(join(h.dir, "answers.json"), 64_000);
    if ("why" in f) return {};
    const v = JSON.parse(f.text) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Seen = {};
    for (const [node, x] of Object.entries(v as Record<string, unknown>)) {
      const o = x as { answers?: unknown; release?: unknown } | null;
      if (NODE.test(node) && o && Number.isSafeInteger(o.answers) && (o.release === null || (typeof o.release === "string" && /^v[\d.]+(-rc\.\d+)?$/.test(o.release)))) out[node] = { answers: o.answers as number, release: o.release as string | null };
    }
    return out;
  } catch {
    return {};
  }
}

// Records what hello agreed with this box. The line to show when it is lower than last time, or undefined.
export function rememberAnswers(h: Home, node: string, name: string, answers: number, release: string | null): string | undefined {
  if (!NODE.test(node)) return undefined;
  const seen = read(h);
  const before = seen[node];
  if (before?.answers === answers && before.release === release) return undefined;
  seen[node] = { answers, release };
  try {
    writePrivateFile(join(h.dir, "answers.json"), `${JSON.stringify(seen)}\n`);
  } catch {}
  if (!before || answers >= before.answers) return undefined;
  const safe = name.replace(/[^A-Za-z0-9-]/g, "").slice(0, 64);
  return `${safe} answers version ${answers} now, and answered ${before.answers} before${before.release ? ` (${before.release})` : ""}: was it rolled back? Its reads carry less, so check it at the box if you didn't roll it back.`;
}
