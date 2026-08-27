/**
 * SOLUTION 08 — reference implementation.
 */

import { Worker } from "node:worker_threads";
import { availableParallelism } from "node:os";
import {
  PoolClosedError,
  PoolQueueFullError,
  PoolTimeoutError,
  type PoolOptions,
  type PoolStats,
} from "./exercise.ts";

interface Task {
  payload: unknown;
  resolve: (value: never) => void;
  reject: (err: Error) => void;
}

interface Slot {
  worker: Worker;
  /** The task this worker is currently running, if any. */
  task: Task | null;
  /** Timer that fires if the current task overruns. */
  timer: NodeJS.Timeout | null;
  /** Guards against 'error' AND 'exit' both settling the same task. */
  settled: boolean;
}

export class WorkerPool {
  readonly #script: string | URL;
  readonly #size: number;
  readonly #maxQueue: number;
  readonly #taskTimeoutMs: number | undefined;
  readonly #workerData: unknown;

  readonly #slots = new Set<Slot>();
  readonly #queue: Task[] = [];

  #closing = false;
  #closePromise: Promise<void> | null = null;
  #completed = 0;
  #failed = 0;

  constructor(script: string | URL, options: PoolOptions = {}) {
    this.#script = script;
    // Leave a core for the main thread when it's also serving traffic.
    // In a container availableParallelism() reports the HOST's cores, so a
    // real service should let this be configured from the environment.
    this.#size = options.size ?? Math.max(1, availableParallelism() - 1);
    this.#maxQueue = options.maxQueue ?? Infinity;
    this.#taskTimeoutMs = options.taskTimeoutMs;
    this.#workerData = options.workerData;

    for (let i = 0; i < this.#size; i++) this.#spawn();
  }

  // ── Worker lifecycle ──────────────────────────────────────────────────────

  #spawn(): Slot {
    const worker = new Worker(this.#script, { workerData: this.#workerData });
    const slot: Slot = { worker, task: null, timer: null, settled: false };

    // One persistent listener per worker, not one per task. Attaching a
    // fresh listener for every task on a long-lived pool is how you get
    // MaxListenersExceededWarning and then a leak (module 03 §6).
    worker.on("message", (reply: unknown) => this.#onReply(slot, reply));
    worker.on("error", (err: Error) => this.#onDeath(slot, err));
    worker.on("exit", (code: number) => {
      // 'error' fires first and 'exit' follows, so this is usually a no-op —
      // #onDeath is idempotent per task via slot.settled.
      this.#onDeath(slot, new Error(`worker exited with code ${code}`));
    });

    this.#slots.add(slot);
    return slot;
  }

  #onReply(slot: Slot, reply: unknown): void {
    const task = slot.task;
    if (!task || slot.settled) return; // a late reply from a timed-out task
    this.#finish(slot);
    this.#completed += 1;
    task.resolve(reply as never);
    this.#pump();
  }

  #onDeath(slot: Slot, err: Error): void {
    if (!this.#slots.has(slot)) return; // already replaced
    this.#slots.delete(slot);

    const task = slot.task;
    if (task && !slot.settled) {
      slot.settled = true;
      if (slot.timer) clearTimeout(slot.timer);
      slot.task = null;
      this.#failed += 1;
      task.reject(err);
    }

    // Keep the pool at full strength — unless we're shutting down, in which
    // case a dying worker is expected and replacing it would hang close().
    if (!this.#closing) {
      this.#spawn();
      this.#pump();
    }
  }

  #finish(slot: Slot): void {
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = null;
    slot.task = null;
    slot.settled = false;
  }

  // ── Scheduling ────────────────────────────────────────────────────────────

  #pump(): void {
    for (const slot of this.#slots) {
      if (this.#queue.length === 0) return;
      if (slot.task) continue; // busy

      // shift() keeps it FIFO. pop() would be LIFO, which starves the
      // earliest callers under sustained load.
      const task = this.#queue.shift()!;
      slot.task = task;
      slot.settled = false;

      if (this.#taskTimeoutMs !== undefined) {
        slot.timer = setTimeout(() => this.#onTimeout(slot), this.#taskTimeoutMs);
        // Don't let a pending timeout keep the process alive by itself.
        slot.timer.unref();
      }

      slot.worker.postMessage(task.payload);
    }
  }

  #onTimeout(slot: Slot): void {
    const task = slot.task;
    if (!task || slot.settled) return;

    slot.settled = true;
    slot.task = null;
    this.#failed += 1;
    task.reject(new PoolTimeoutError(`task exceeded ${this.#taskTimeoutMs}ms`));

    // The worker may be stuck in a synchronous loop forever — you cannot
    // interrupt a thread, only kill it. So terminate and replace.
    this.#slots.delete(slot);
    void slot.worker.terminate();
    if (!this.#closing) {
      this.#spawn();
      this.#pump();
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────

  run<T = unknown>(payload: unknown): Promise<T> {
    if (this.#closing) {
      return Promise.reject(new PoolClosedError("pool is closed"));
    }
    if (this.#queue.length >= this.#maxQueue) {
      // Backpressure. Without this the queue grows without bound and you
      // trade a slow service for an OOM kill (module 05 §4).
      return Promise.reject(new PoolQueueFullError(`queue is full (max ${this.#maxQueue})`));
    }

    return new Promise<T>((resolve, reject) => {
      this.#queue.push({ payload, resolve: resolve as (v: never) => void, reject });
      this.#pump();
    });
  }

  stats(): PoolStats {
    let busy = 0;
    for (const slot of this.#slots) if (slot.task) busy += 1;
    return {
      size: this.#slots.size,
      idle: this.#slots.size - busy,
      busy,
      queued: this.#queue.length,
      completed: this.#completed,
      failed: this.#failed,
    };
  }

  close(options: { timeoutMs?: number } = {}): Promise<void> {
    // Idempotent: return the SAME promise, so two callers can't race two
    // shutdown sequences against each other.
    this.#closePromise ??= this.#doClose(options.timeoutMs ?? 5_000);
    return this.#closePromise;
  }

  async #doClose(timeoutMs: number): Promise<void> {
    this.#closing = true;

    // Queued-but-not-started tasks can never run now — fail them fast rather
    // than leaving their promises pending forever.
    while (this.#queue.length > 0) {
      const task = this.#queue.shift()!;
      this.#failed += 1;
      task.reject(new PoolClosedError("pool closed before the task started"));
    }

    // Give in-flight tasks a chance to finish.
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      let busy = false;
      for (const slot of this.#slots) if (slot.task) busy = true;
      if (!busy) break;
      await new Promise((r) => setTimeout(r, 10));
    }

    // Terminate everything. terminate() is abrupt — no finally blocks in the
    // worker — which is why we waited above rather than starting here.
    const slots = [...this.#slots];
    this.#slots.clear();

    for (const slot of slots) {
      if (slot.timer) clearTimeout(slot.timer);
      if (slot.task && !slot.settled) {
        slot.settled = true;
        this.#failed += 1;
        slot.task.reject(new PoolClosedError("pool closed while the task was running"));
        slot.task = null;
      }
    }

    await Promise.all(slots.map((s) => s.worker.terminate()));
  }
}

// --- Task 2 ------------------------------------------------------------------

export function parallelMap<T, R>(
  pool: WorkerPool,
  items: readonly T[],
  toPayload: (item: T, index: number) => unknown,
): Promise<R[]> {
  // Submit everything and let the POOL do the throttling — it already has a
  // fixed worker count and a FIFO queue. Adding a second concurrency limit
  // here would just make the pool's workers idle.
  //
  // Promise.all preserves INPUT order regardless of completion order, which
  // is exactly the guarantee we want.
  return Promise.all(items.map((item, i) => pool.run<R>(toPayload(item, i))));
}
