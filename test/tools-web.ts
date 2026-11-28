// A fake web for the tool cache's fetch: each URL's answer as a Response, the names' addresses, and
// the timers a fetch sets, which a test fires itself.
import type { FetchDeps, Got } from "../src/tools/fetch.ts";

export type Web = FetchDeps & { asked: string[]; gets: { url: string; address: string; headers: Record<string, string> }[]; timers: { ms: number; f: () => void; live: boolean }[] };

export function web(routes: Record<string, () => Response>, addrs: Record<string, string[]> = {}): Web {
  const w: Web = {
    asked: [],
    gets: [],
    timers: [],
    async get(url, o) {
      w.asked.push(url);
      w.gets.push({ url, address: o.address, headers: o.headers });
      const r = routes[url]?.() ?? new Response("no", { status: 404 });
      return got(r, o.signal);
    },
    resolve: async (h) => addrs[h] ?? ["140.82.112.3"],
    after(ms, f) {
      const t = { ms, f, live: true };
      w.timers.push(t);
      return () => void (t.live = false);
    },
  };
  return w;
}

// A Response as the wire gives it, stopping when the fetch's signal aborts.
export function got(r: Response, signal: AbortSignal): Got {
  const reader = r.body?.getReader();
  return {
    status: r.status,
    header: (n) => r.headers.get(n) ?? undefined,
    body: {
      async *[Symbol.asyncIterator]() {
        if (!reader) return;
        for (;;) {
          if (signal.aborted) throw new Error("aborted");
          const { done, value } = await reader.read();
          if (done) return;
          yield value;
        }
      },
    },
    cancel: () => void reader?.cancel().catch(() => {}),
  };
}
