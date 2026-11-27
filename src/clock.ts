// The one module that reads the real time or waits on it. Everything else takes a Clock (every Sys is
// one), so in a test the fake clock (test/fake.ts) drives every timer. test/clock.test.ts fails if a
// timer is called anywhere else in src.

export interface Clock {
  now(): number;
  // Waits ms. An abort ends the wait at once and takes it off the clock.
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  // Calls f once, ms from now, unless the cancel it returns runs first. unref: this timer alone
  // doesn't keep the process running.
  after(ms: number, f: () => void, o?: { unref?: boolean }): () => void;
  // Calls f every ms until the cancel it returns runs. The timer alone doesn't keep the process running.
  every(ms: number, f: () => void): () => void;
  // A signal that aborts ms from now, for a fetch's time limit.
  timeout(ms: number): AbortSignal;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((r) => {
      if (signal?.aborted) return r();
      const t = setTimeout(r, ms);
      signal?.addEventListener("abort", () => (clearTimeout(t), r()), { once: true });
    }),
  after(ms, f, o = {}) {
    const t = setTimeout(f, ms);
    if (o.unref) t.unref();
    return () => clearTimeout(t);
  },
  every(ms, f) {
    const t = setInterval(f, ms);
    t.unref();
    return () => clearInterval(t);
  },
  timeout: (ms) => AbortSignal.timeout(ms),
};

// p, or undefined once ms have passed. The wait ends with the race, so a p that wins early leaves no
// sleep behind to move a clock on.
export async function within<T>(c: Pick<Clock, "sleep">, p: Promise<T>, ms: number): Promise<T | undefined> {
  const stop = new AbortController();
  try {
    return await Promise.race([p, c.sleep(ms, stop.signal).then(() => undefined)]);
  } finally {
    stop.abort();
  }
}

// Waits ms without returning to the event loop: for a few milliseconds in code that must stay
// synchronous, such as a child taking its lease (core/child.ts).
export function waitSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
