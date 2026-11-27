// One settings commit's files, validated by this release: taskbox.json, then the box's overlay
// boxes/<box>.json over it for the keys of the box class. The product file must pass alone. An
// overlay that fails, or holds a key outside its class, is set aside or passed over alone, and the
// "Box settings" row says so; a product file that fails refuses the whole commit.
import { safeParse } from "../core/rootfile.ts";
import { BOX_LINUX, unknownKeys, within } from "./classes.ts";
import { checkConfig, type Config } from "./core.ts";
import { DOC_MAX, SETTINGS_V, type Validated } from "./inforce.ts";

type Doc = Record<string, unknown>;
const isDoc = (v: unknown): v is Doc => typeof v === "object" && v !== null && !Array.isArray(v);

// A file's JSON object, or why it isn't one. No key that reaches a prototype is taken.
export function fileDoc(name: string, text: string): Doc | string {
  if (Buffer.byteLength(text) > DOC_MAX) return `${name} is over ${DOC_MAX / 1024} KB`;
  let v: unknown;
  try {
    v = safeParse(text);
  } catch (e) {
    return `${name} isn't JSON taskbox reads: ${String((e as Error).message).replace(/[^\x20-\x7e]/g, " ").slice(0, 80)}`;
  }
  return isDoc(v) ? v : `${name} isn't a JSON object`;
}

// The overlay's own keys over the product file: the box class only, and inside linux only its
// numbers. Built from named keys, so nothing reaches a prototype.
export function overlaid(product: Doc, overlay: Doc): { doc: Doc; kept: Doc; ignored: string[] } {
  const { kept, ignored } = within(overlay, "box");
  const own: Doc = Object.fromEntries(kept);
  const linux = overlay.linux;
  if (linux !== undefined) {
    const at = ignored.indexOf("linux");
    if (at >= 0) ignored.splice(at, 1);
    if (isDoc(linux) && isDoc(product.linux)) {
      const nums: Doc = {};
      for (const [k, v] of Object.entries(linux)) {
        if ((BOX_LINUX as readonly string[]).includes(k)) nums[k] = v;
        else ignored.push(`linux.${k.replace(/[^\x20-\x7e]/g, "").slice(0, 50)}`);
      }
      if (Object.keys(nums).length) own.linux = nums;
    } else ignored.push("linux");
  }
  const doc: Doc = { ...structuredClone(product), ...structuredClone(own) };
  if (isDoc(own.linux)) doc.linux = { ...(product.linux as Doc), ...own.linux };
  return { doc, kept: own, ignored };
}

const check = (d: Doc) => checkConfig(structuredClone(d) as unknown as Config, () => {});
const why = (e: unknown) => String((e as Error)?.message ?? e).replace(/[^\x20-\x7e]/g, " ").slice(0, 240);

export type Checked = { ok: true; v: Validated } | { ok: false; why: string };

// The files of one commit, validated. product: taskbox.json's text; overlay: the box's file's, or
// undefined when the repo has none.
export function validateCommit(o: { sha: string; repo: string; box: string; product: string | undefined; overlay: string | undefined; now: number }): Checked {
  if (o.product === undefined) return { ok: false, why: "the settings repo has no taskbox.json" };
  const product = fileDoc("taskbox.json", o.product);
  if (typeof product === "string") return { ok: false, why: product };
  try {
    check(product);
  } catch (e) {
    return { ok: false, why: why(e) };
  }
  const base = { v: SETTINGS_V, sha: o.sha, repo: o.repo, box: o.box, product, unknown: unknownKeys(product), readAt: o.now } as const;
  if (o.overlay === undefined) return { ok: true, v: { ...base, overlay: null, doc: product, overlayIgnored: [] } };
  const name = `boxes/${o.box}.json`;
  const overlay = fileDoc(name, o.overlay);
  if (typeof overlay === "string") return { ok: true, v: { ...base, overlay: null, doc: product, overlayIgnored: [], overlayProblem: overlay } };
  const { doc, kept, ignored } = overlaid(product, overlay);
  try {
    check(doc);
  } catch (e) {
    return { ok: true, v: { ...base, overlay: null, doc: product, overlayIgnored: ignored, overlayProblem: `with ${name}, ${why(e).replace(/^taskbox\.json: /, "")}`.slice(0, 240) } };
  }
  return { ok: true, v: { ...base, overlay: kept, doc, overlayIgnored: ignored } };
}

// Whether settings pass this release's checks, for a doc made by holding keys back.
export function docProblem(d: Doc): string | undefined {
  try {
    check(d);
    return undefined;
  } catch (e) {
    return why(e);
  }
}

// The repo the guard reads, from the runner App's installation's repos when box.json names none:
// exactly one beside the v2 release repo. One, none or several.
export function findSettingsRepo(repos: readonly string[], releaseRepo?: string): { repo: string } | { none: true } | { several: string[] } {
  const rest = repos.filter((r) => r !== releaseRepo);
  if (rest.length === 1) return { repo: rest[0]! };
  return rest.length ? { several: rest.slice(0, 5) } : { none: true };
}
