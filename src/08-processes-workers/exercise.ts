/**
 * EXERCISE 08 — A production worker pool
 *
 * The MiniPool in 04-worker-pool.ts is ~40 lines and loses a worker every
 * time one dies. This is the version you'd actually ship.
 *
 * Check yourself:  node scripts/test.ts 08
 * Solution:        ./solution.ts   (try first!)
 */

const TODO = (what: string): never => {
  throw new Error(`TODO: implement ${what}`);
};

export class PoolTimeoutError extends Error {
  override readonly name = "PoolTimeoutError";
}

export class PoolClosedError extends Error {
  override readonly name = "PoolClosedError";
}

export class PoolQueueFullError extends Error {
  override readonly name = "PoolQueueFullError";
}

export interface PoolOptions {
  /** Number of workers. Default: max(1, availableParallelism() - 1). */
  size?: number;
  /** Max tasks waiting for a free worker. Default Infinity. */
  maxQueue?: number;
  /** Per-task timeout in ms. Default: no timeout. */
  taskTimeoutMs?: number;
  /** Passed to each Worker as workerData. */
  workerData?: unknown;
}

export interface PoolStats {
  size: number;
  idle: number;
  busy: number;
  queued: number;
  completed: number;
  failed: number;
}

/**
 * TASK 1 — `WorkerPool`
 *
 * Contract: the worker script receives a message and posts back exactly one
 * reply. The pool pairs replies with the task that is in flight on that
 * worker — one at a time per worker.
 *
 * Requirements:
 *
 *   CONSTRUCTION
 *     - Spawns `size` workers eagerly.
 *     - Passes `workerData` to each.
 *
 *   run(payload)
 *     - Resolves with the worker's reply.
 *     - FIFO: tasks are handed out in submission order.
 *     - Never runs two tasks on one worker at the same time.
 *     - Rejects with PoolClosedError if the pool is closing/closed.
 *     - Rejects with PoolQueueFullError when `maxQueue` waiting tasks are
 *       already queued (backpressure — an unbounded queue is an unbounded
 *       memory leak).
 *     - Rejects with PoolTimeoutError after `taskTimeoutMs`, and the worker
 *       running it must be TERMINATED and REPLACED (it may be stuck in a
 *       loop forever; you cannot recover the thread).
 *
 *   WORKER DEATH
 *     - If a worker emits 'error' or exits unexpectedly, its in-flight task
 *       rejects — EXACTLY ONCE, even though both events may fire.
 *     - The pool replaces the worker so `size` stays constant.
 *     - Queued tasks continue on the replacement.
 *
 *   close({ timeoutMs })
 *     - Stops accepting new tasks.
 *     - Waits for in-flight tasks to finish, then terminates all workers.
 *     - After `timeoutMs`, terminates anyway (in-flight tasks reject).
 *     - Idempotent: calling it twice is safe and returns the same outcome.
 *     - After close(), the process must be able to exit — no live handles.
 *
 *   stats()
 *     - Live counts. `completed` and `failed` are cumulative.
 */
export class WorkerPool {
  constructor(_script: string | URL, _options?: PoolOptions) {
    TODO("WorkerPool constructor");
  }

  run<T = unknown>(_payload: unknown): Promise<T> {
    return TODO("WorkerPool#run");
  }

  stats(): PoolStats {
    return TODO("WorkerPool#stats");
  }

  close(_options?: { timeoutMs?: number }): Promise<void> {
    return TODO("WorkerPool#close");
  }
}

/**
 * TASK 2 — `parallelMap`
 *
 * Map `items` through the pool, preserving INPUT ORDER in the results.
 *
 * Requirements:
 *   - Results in input order, regardless of completion order.
 *   - Concurrency is the pool's, not the caller's — just submit them all
 *     and let the pool queue.
 *   - If any task rejects, reject with that error.
 *   - An empty input resolves to [].
 */
export function parallelMap<T, R>(
  _pool: WorkerPool,
  _items: readonly T[],
  _toPayload: (item: T, index: number) => unknown,
): Promise<R[]> {
  return TODO("parallelMap");
}
