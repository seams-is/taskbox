// v2.6.1's src/github.ts at c7d2414, cut to what hop() runs. Each part below is that file's own text, unchanged, unless marked New.

// A release is a version tag on a commit on main, published on GitHub with notes. From v2.6.1 a
// trial's tag, vX.Y.Z-rc.N, is one too (docs/v3-design.md §5.7).
// No leading zeros, as semver has it (rule 2), so two tags never name one version.
export const RELEASE_TAG = /^v(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})(?:-rc\.([1-9]\d{0,3}))?$/;

// Whether a release tag names a trial (a prerelease).
export function isTrial(tag: string): boolean {
  return RELEASE_TAG.exec(tag)?.[4] !== undefined;
}

// -1, 0 or 1, comparing two release tags as semver orders them: by the three numbers, then a trial
// before its release (semver's rule 11), so v3.0.0-rc.1 < v3.0.0-rc.2 < v3.0.0.
export function compareTags(a: string, b: string): number {
  const x = RELEASE_TAG.exec(a);
  const y = RELEASE_TAG.exec(b);
  if (!x || !y) throw new Error("not a release tag");
  for (let i = 1; i <= 3; i++) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) < Number(y[i]) ? -1 : 1;
  const rx = x[4] === undefined ? Infinity : Number(x[4]);
  const ry = y[4] === undefined ? Infinity : Number(y[4]);
  return rx === ry ? 0 : rx < ry ? -1 : 1;
}

// "12 November 2026", in UTC, the form main's step 3 message uses too.
export function mergeDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}
