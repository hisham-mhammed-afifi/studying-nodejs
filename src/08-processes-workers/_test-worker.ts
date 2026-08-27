/**
 * The worker used by the module 08 tests.
 *
 * Understands a few commands so the tests can exercise every path a real
 * pool has to survive: slow tasks, crashes, hangs, and hard exits.
 */

import { parentPort, threadId, workerData } from "node:worker_threads";

interface Job {
  op: "echo" | "double" | "slow" | "throw" | "exit" | "hang" | "whoami";
  value?: number;
  ms?: number;
}

parentPort?.on("message", (job: Job) => {
  switch (job.op) {
    case "echo":
      parentPort!.postMessage({ value: job.value, threadId });
      return;

    case "double":
      parentPort!.postMessage({ value: (job.value ?? 0) * 2, threadId });
      return;

    case "slow":
      setTimeout(() => parentPort!.postMessage({ value: job.value, threadId }), job.ms ?? 50);
      return;

    case "throw":
      // An uncaught throw → the parent gets an 'error' event, then 'exit'.
      throw new Error("worker task failed");

    case "exit":
      // A hard exit → 'exit' only, no 'error'. The pool must still fail the
      // in-flight task and replace the worker.
      process.exit(7);
      return;

    case "hang":
      // Never replies, and blocks the worker's own loop so it cannot even
      // be asked to stop. Only terminate() can reclaim this thread.
      for (;;) {
        /* deliberately stuck */
      }

    case "whoami":
      parentPort!.postMessage({ threadId, workerData });
      return;

    default:
      parentPort!.postMessage({ error: "unknown op" });
  }
});
