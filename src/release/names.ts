// The PR check's name search over a unified diff's added lines: an email that isn't a no-reply one or
// an example's, a tailnet name that isn't an example's, and any of the extra words the repo's secret
// names: people's names, home folders and private repos. Each hit, by file and line.
export interface Hit {
  file: string;
  line: number;
  what: string;
}

const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+\.)+[A-Za-z]{2,}/g;
const OK_EMAIL = /@(users\.noreply\.github\.com|anthropic\.com|openssh\.com|example\.(com|org|net))$/i;
const TAILNET = /\b[a-z0-9.-]+\.ts\.net\b/gi;

export function findNames(diff: string, extra: string[] = []): Hit[] {
  const words = extra.map((w) => w.trim()).filter((w) => w.length >= 3);
  const hits: Hit[] = [];
  let file = "";
  let line = 0;
  for (const l of diff.split("\n")) {
    if (l.startsWith("+++ ")) {
      file = l.slice(4).replace(/^b\//, "");
      continue;
    }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(l);
    if (h) {
      line = Number(h[1]) - 1;
      continue;
    }
    if (l.startsWith("-")) continue;
    line++;
    if (!l.startsWith("+")) continue;
    const t = l.slice(1);
    const hit = (what: string) => hits.push({ file, line, what });
    for (const m of t.matchAll(EMAIL)) if (!OK_EMAIL.test(m[0])) hit(`an email address: ${m[0]}`);
    for (const m of t.matchAll(TAILNET)) if (!/(^|[.-])(example|x)[.-]/.test(m[0])) hit(`a tailnet name: ${m[0]}`);
    for (const w of words) if (t.toLowerCase().includes(w.toLowerCase())) hit("a name the repo's NAME_SEARCH lists");
  }
  return hits;
}
