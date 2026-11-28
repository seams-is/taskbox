// v2.6.1's src/ghfail.ts at c7d2414, cut to what hop() runs. Each part below is that file's own text, unchanged, unless marked New.

export const CALL_LIMIT_MS = 30_000; // every GitHub API call

export const DOWNLOAD_LIMIT_MS = 600_000; // a release's tarball or asset, and the install's pinned tools
