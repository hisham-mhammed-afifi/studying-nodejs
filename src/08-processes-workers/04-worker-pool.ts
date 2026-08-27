/**
 * 04 — Why you pool, measured
 *
 * Run:  node src/08-processes-workers/04-worker-pool.ts
 */

import { Worker } from "node:worker_threads";
import { once } from "node:events";
import { availableParallelism } from "node:os";
import path from "node:path";
import { crunch } from "./_cpu-worker.ts";

const WORKER = path.join(import.meta.dirname, "_cpu-worker.ts");
const CORES = availableParallelism();

const TASKS = 24;
const ITERATIONS = 700_000; // ~15-25ms of CPU each

interface Task {
  payload: { id: number; seed: number; iterations: number };
  resolve: (value: number) => void;
  reject: (err: Error) => void;
}

/** The smallest thing that deserves to be called a pool. */
class MiniPool {
  readonly #idle: Worker[] = [];
  readonly #all: Worker[] = [];
  readonly #queue: Task[] = [];

  constructor(script: string, size: number) {
    for (let i = 0; i < size; i++) {
      const worker = new Worker(script);
      this.#all.push(worker);
      this.#idle.push(worker);
    }
  }

  run(payload: Task["payload"]): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      this.#queue.push({ payload, resolve, reject });
      this.#pump();
    });
  }

  #pump(): void {
    while (this.#queue.length > 0 && this.#idle.length > 0) {
      const worker = this.#idle.pop()!;
      const task = this.#queue.shift()!;

      // once() attaches a one-shot listener, so nothing accumulates across
      // the thousands of tasks a long-lived pool handles (module 03 §6).
      const onMessage = (msg: { value: number }) => {
        worker.off("error", onError);
        this.#idle.push(worker);
        task.resolve(msg.value);
        this.#pump();
      };
      const onError = (err: Error) => {
        worker.off("message", onMessage);
        task.reject(err);
        // NOTE: a real pool would replace the dead worker here. This one
        // just loses a slot — which is exactly the bug the exercise fixes.
      };

      worker.once("message", onMessage);
      worker.once("error", onError);
      worker.postMessage(task.payload);
    }
  }

  async shutdown(): Promise<void> {
    await Promise.all(this.#all.map((w) => w.terminate()));
  }
}

/** Max event-loop lag over the measured window (module 02 §6.1). */
function startLagMonitor(intervalMs = 10) {
  let max = 0;
  let expected = performance.now() + intervalMs;
  const timer = setInterval(() => {
    const now = performance.now();
    max = Math.max(max, now - expected);
    expected = now + intervalMs;
  }, intervalMs);
  timer.unref();
  return {
    async stop(): Promise<number> {
      // A monitor can't sample WHILE the loop is blocked; it records the
      // damage on the first tick after. Let it breathe once before reading.
      await new Promise((r) => setTimeout(r, 40));
      clearInterval(timer);
      return max;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────

console.log(`${TASKS} CPU-bound tasks · ${ITERATIONS.toLocaleString()} iterations each · availableParallelism() = ${CORES}\n`);

// ── Baseline: do it inline on the main thread ───────────────────────────────
console.log("=== 1. Inline on the main thread ===");
{
  const lag = startLagMonitor();
  const t0 = performance.now();
  let checksum = 0;
  for (let i = 0; i < TASKS; i++) checksum += crunch(i, ITERATIONS);
  const ms = performance.now() - t0;
  const maxLag = await lag.stop();
  console.log(`  ${ms.toFixed(0)}ms total   max loop lag ${maxLag.toFixed(0)}ms   (checksum ${checksum.toFixed(2)})`);
  console.log("  → the event loop was frozen for essentially the whole run");
}

// ── One worker per task: correct, but pays startup 24 times ─────────────────
console.log("\n=== 2. A new Worker per task ===");
{
  const t0 = performance.now();
  const results = await Promise.all(
    Array.from({ length: TASKS }, async (_, i) => {
      const w = new Worker(WORKER);
      w.postMessage({ id: i, seed: i, iterations: ITERATIONS });
      const [msg] = (await once(w, "message")) as [{ value: number }];
      await w.terminate();
      return msg.value;
    }),
  );
  const ms = performance.now() - t0;
  console.log(`  ${ms.toFixed(0)}ms total   (checksum ${results.reduce((a, b) => a + b, 0).toFixed(2)})`);
  console.log(`  → ${TASKS} × ~25ms of startup, plus ${TASKS} fresh V8 heaps, all at once`);
}

// ── A pool: N workers, reused ───────────────────────────────────────────────
console.log("\n=== 3. A pool of workers, reused ===");
{
  const lag = startLagMonitor();
  const t0 = performance.now();

  const pool = new MiniPool(WORKER, CORES);
  const results = await Promise.all(
    Array.from({ length: TASKS }, (_, i) => pool.run({ id: i, seed: i, iterations: ITERATIONS })),
  );
  await pool.shutdown();

  const ms = performance.now() - t0;
  const maxLag = await lag.stop();
  console.log(`  ${ms.toFixed(0)}ms total   max loop lag ${maxLag.toFixed(0)}ms   (checksum ${results.reduce((a, b) => a + b, 0).toFixed(2)})`);
  console.log(`  → ${CORES} workers created ONCE, each handling ~${Math.ceil(TASKS / CORES)} tasks`);
}

console.log(`
=== Reading the numbers ===

  Compare the LAG column between §1 and §3. Inline, the loop was blocked for
  the entire run — no requests served, no health checks answered. With a
  pool it stayed responsive throughout, which is the actual reason to do
  this. Wall-clock speedup is a bonus and is capped by your core count
  (${CORES} here).

  §2 shows why pooling matters even when workers are the right answer:
  ~25ms of startup and a fresh V8 heap PER TASK. Below a few hundred
  milliseconds of work per task, startup dominates everything.

  If §2 or §3 is SLOWER than §1 on your machine, that's the real lesson:
  with ${CORES} cores there is little parallelism to win, and the overhead is
  not free. Always measure before adding workers.
`);

console.log("=== 4. Sizing the pool ===");
console.log(`
  CPU-bound work    → availableParallelism(), minus one if the main thread
                      also serves traffic
  Mixed workloads   → measure; more workers than cores just adds context
                      switching and memory
  In a container    → ⚠ availableParallelism() reports the HOST's cores, not
                      your cgroup CPU limit. A 1-CPU container spawning 64
                      workers is a real and common production mistake.
                      Make it configurable:

                          const size = Number(process.env.POOL_SIZE) ||
                                       Math.max(1, availableParallelism() - 1);

  Memory: each worker is a separate V8 heap. Eight workers is roughly eight
  times the baseline heap, before your data.
`);

console.log("=== 5. What a real pool needs ===");
console.log(`
  The MiniPool at the top of this file is ~40 lines and deliberately
  incomplete. A production pool also handles:

    • TIMEOUTS       — a task that never replies must not hold a worker forever
    • WORKER DEATH   — 'error' AND 'exit' both fire; replace the worker and
                       fail the in-flight task exactly once
    • BACKPRESSURE   — an unbounded queue is an unbounded memory leak
    • SHUTDOWN       — drain in-flight work, then terminate, with a deadline
    • FAIRNESS       — FIFO, so one slow caller can't starve the rest

  You build all of that in the exercise. Or use piscina, which is this done
  properly — but write one first, so you know what it's doing for you.
`);

