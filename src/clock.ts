// The one module that reads the real time or waits on it. Everything else takes a Clock (every Sys is
// one), so in a test the fake clock (test/fake.ts) drives every timer. test/clock.test.ts fails if a
// timer is called anywhere else in src.

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
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
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
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

// This process's own monotonic clock in ms, which no wall clock step moves: for limits within one
// process, such as an update's drain and proof in its op's child (update/box.ts).
export const monotonicMs = (): number => performance.now();

// Waits ms without returning to the event loop: for a few milliseconds in code that must stay
// synchronous, such as a child taking its lease (core/child.ts).
export function waitSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
