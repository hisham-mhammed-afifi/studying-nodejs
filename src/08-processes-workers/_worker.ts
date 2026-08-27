/**
 * A demo worker used by 02-worker-basics.ts.
 *
 * Note: this file is loaded fresh in EVERY worker — its own module registry,
 * its own V8 heap. Import-time side effects run once per worker.
 */

import { parentPort, workerData, threadId, isMainThread } from "node:worker_threads";

if (isMainThread) throw new Error("this file is meant to run as a worker");

// Announce that we're up, and prove what we can see.
parentPort!.postMessage({
  type: "ready",
  threadId,
  workerData,
  isMainThread,
  // A worker gets its own globals — nothing set on the main thread's
  // globalThis is visible here.
  sawMainThreadGlobal: (globalThis as { MAIN_ONLY?: string }).MAIN_ONLY ?? null,
});

parentPort!.on("message", (msg: { type: string; payload?: unknown }) => {
  switch (msg.type) {
    case "double": {
      const n = (msg.payload as { n: number }).n;
      parentPort!.postMessage({ type: "result", value: n * 2, threadId });
      break;
    }
    case "structured": {
      // Structured clone preserves what JSON cannot.
      parentPort!.postMessage({
        type: "structured",
        received: msg.payload,
        // Send some back so the parent can inspect round-tripped types.
        sent: {
          date: new Date("2026-01-01T00:00:00.000Z"),
          map: new Map([["a", 1]]),
          set: new Set([1, 2]),
          regex: /abc/gi,
          bytes: Buffer.from("hi"),
          undef: undefined,
        },
      });
      break;
    }
    case "throw": {
      throw new Error("worker exploded on purpose");
    }
    case "exit": {
      // A CLEAN stop: the worker decides to leave, so finally blocks and
      // flushes run. terminate() from the parent does none of that.
      process.exit(0);
    }
    default:
      parentPort!.postMessage({ type: "unknown", got: msg.type });
  }
});
