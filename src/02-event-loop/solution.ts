/**
 * SOLUTION 02 — reference implementation.
 */

import type { LagMonitor } from "./exercise.ts";

// --- Task 1 ------------------------------------------------------------------

export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`limit must be a positive integer, got ${limit}`);
  }
  if (items.length === 0) return [];

  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let failed = false;

  // The pattern: spawn exactly `limit` WORKERS, each of which loops pulling the
  // next index off a shared cursor. This is why a slow item doesn't stall the
  // others — the other workers just keep pulling. A "batch of N, await all,
  // next batch" implementation would run at the speed of the slowest item in
  // each batch, which is a common and subtly bad alternative.
  async function worker(): Promise<void> {
    while (!failed) {
      const index = nextIndex++;
      if (index >= items.length) return;
      // `as T` is safe: index < items.length. noUncheckedIndexedAccess makes
      // TS pessimistic about array reads, which is usually what you want.
      results[index] = await fn(items[index] as T, index);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  try {
    // Promise.all rejects on the FIRST rejection; the flag stops the survivors
    // from pulling new work. Note the already-in-flight ones still finish —
    // you cannot un-send a request. For real cancellation, thread an
    // AbortSignal through to fn (see module 06).
    await Promise.all(workers);
  } catch (err) {
    failed = true;
    throw err;
  }
  return results;
}

// --- Task 2 ------------------------------------------------------------------

export function createLagMonitor(intervalMs = 20): LagMonitor {
  let max = 0;
  let total = 0;
  let samples = 0;
  let stopped = false;
  let expected = performance.now() + intervalMs;

  const timer = setInterval(() => {
    if (stopped) return;
    const now = performance.now();
    // How much later than promised did we get called? Timers are a floor, so
    // a positive delta means the loop was busy. Clamp: the timer can fire a
    // hair early due to clock resolution, and negative "lag" is meaningless.
    const lag = Math.max(0, now - expected);
    max = Math.max(max, lag);
    total += lag;
    samples += 1;
    // Re-anchor from NOW, not from `expected`. Anchoring from expected would
    // accumulate drift and report ever-growing lag after a single stall.
    expected = now + intervalMs;
  }, intervalMs);

  // Critical: a monitor must never be the reason a CLI or worker won't exit.
  timer.unref();

  return {
    get maxLagMs() {
      return max;
    },
    get meanLagMs() {
      return samples === 0 ? 0 : total / samples;
    },
    get samples() {
      return samples;
    },
    reset() {
      max = 0;
      total = 0;
      samples = 0;
      expected = performance.now() + intervalMs;
    },
    stop() {
      // Idempotent: clearInterval on an already-cleared timer is a no-op, and
      // the flag guards against a callback already queued for this tick.
      stopped = true;
      clearInterval(timer);
    },
  };
}

// --- Task 3 ------------------------------------------------------------------

export function yieldToLoop(): Promise<void> {
  // setImmediate schedules into the CHECK phase, which means the loop must
  // finish the current iteration — servicing poll (I/O) and timers — before
  // resuming us. queueMicrotask/Promise.resolve would resume us BEFORE the
  // loop advances at all, which is not a yield.
  return new Promise((resolve) => setImmediate(resolve));
}

// --- Task 4 ------------------------------------------------------------------

export async function processCooperatively<T, R>(
  items: readonly T[],
  fn: (item: T, index: number) => R,
  budgetMs = 8,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let sliceStart = performance.now();
  let sinceCheck = 0;

  for (let i = 0; i < items.length; i++) {
    results[i] = fn(items[i] as T, i);

    // Only consult the clock every 256 items. performance.now() is cheap but
    // not free, and at millions of iterations it becomes a real cost. The
    // tradeoff: with very slow per-item work you could overshoot the budget by
    // up to 255 items — tune the mask if your items are expensive.
    if (++sinceCheck >= 256) {
      sinceCheck = 0;
      if (performance.now() - sliceStart > budgetMs) {
        await yieldToLoop();
        sliceStart = performance.now();
      }
    }
  }
  return results;
}
