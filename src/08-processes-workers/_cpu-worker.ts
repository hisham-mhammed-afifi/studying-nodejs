/**
 * A CPU-bound worker used by 04-worker-pool.ts and the exercise tests.
 *
 * The "work" is a deliberately expensive pure function, so the numbers
 * measure parallelism rather than I/O.
 */

import { parentPort } from "node:worker_threads";

/** ~O(iterations) of floating-point work. Shared with the main thread. */
export function crunch(seed: number, iterations: number): number {
  let acc = 0;
  for (let i = 1; i <= iterations; i++) {
    acc += Math.sin(seed * i) / i + Math.sqrt(seed + i) * 1e-6;
  }
  return acc;
}

// When imported by the main thread (for the inline baseline), parentPort is
// null and we do nothing but export crunch.
parentPort?.on("message", (msg: { id: number; seed: number; iterations: number }) => {
  parentPort!.postMessage({ id: msg.id, value: crunch(msg.seed, msg.iterations) });
});
