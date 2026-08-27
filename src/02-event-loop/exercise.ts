/**
 * EXERCISE 02 — Loop health & bounded concurrency
 *
 * Two utilities you will genuinely reuse in real services.
 *
 * Check yourself:  node --test "src/02-event-loop/*.test.ts"
 * Solution:        ./solution.ts   (try first!)
 */

/**
 * TASK 1 — A bounded-concurrency map.
 *
 * `Promise.all(items.map(fn))` starts EVERYTHING at once: 10,000 sockets,
 * 10,000 DB connections, an OOM. This runs at most `limit` at a time.
 *
 * Requirements:
 *   - Results come back in INPUT order, regardless of completion order.
 *   - Never more than `limit` promises in flight at once.
 *   - Starts the next item as soon as ANY slot frees (not in batches of `limit`
 *     — one slow item must not stall the other slots).
 *   - If `fn` rejects, reject with that error. Don't start new work afterwards.
 *   - `limit < 1` → throw a RangeError.
 *   - An empty input resolves to [].
 *
 * @param items  the inputs
 * @param limit  max in-flight
 * @param fn     receives the item and its index
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  throw new Error("TODO: implement mapLimit");
}

export interface LagMonitor {
  /** Largest observed lag, in milliseconds, since start()/reset(). */
  readonly maxLagMs: number;
  /** Mean observed lag in milliseconds. 0 if nothing sampled yet. */
  readonly meanLagMs: number;
  /** How many samples have been taken. */
  readonly samples: number;
  reset(): void;
  /** Stop sampling. Must leave nothing that keeps the process alive. */
  stop(): void;
}

/**
 * TASK 2 — An event-loop lag monitor.
 *
 * Schedule a repeating timer for `intervalMs` and measure how LATE it actually
 * fires. Lateness == time the loop was too busy to service timers.
 *
 * Requirements:
 *   - Must NOT keep the process alive (hint: `.unref()`).
 *   - Lag is never negative — clamp at 0.
 *   - `reset()` clears max/mean/samples.
 *   - `stop()` is idempotent; after it, no further samples are taken.
 */
export function createLagMonitor(intervalMs = 20): LagMonitor {
  throw new Error("TODO: implement createLagMonitor");
}

/**
 * TASK 3 — Yield to the event loop.
 *
 * Return a promise that resolves after the loop has completed at least one
 * full iteration — so pending I/O and timers get a chance to run.
 *
 * Careful: `Promise.resolve()` and `queueMicrotask` do NOT do this. Neither
 * does `await 0`. Re-read 02-nexttick-vs-microtask.ts if unsure.
 */
export function yieldToLoop(): Promise<void> {
  throw new Error("TODO: implement yieldToLoop");
}

/**
 * TASK 4 — Run CPU work without hogging the loop.
 *
 * Iterate `items`, calling `fn` on each, but yield to the event loop whenever
 * more than `budgetMs` has elapsed since the last yield.
 *
 * Requirements:
 *   - Returns the accumulated results, in order.
 *   - Must actually yield: a timer scheduled before the call must be able to
 *     fire while it is still running (the test checks this).
 *   - Don't call performance.now() on every single item if you can avoid it.
 */
export async function processCooperatively<T, R>(
  items: readonly T[],
  fn: (item: T, index: number) => R,
  budgetMs = 8,
): Promise<R[]> {
  throw new Error("TODO: implement processCooperatively");
}
