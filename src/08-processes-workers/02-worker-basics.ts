/**
 * 02 — worker_threads: creation, messaging, isolation, lifecycle
 *
 * Run:  node src/08-processes-workers/02-worker-basics.ts
 */

import { Worker, isMainThread, threadId } from "node:worker_threads";
import { availableParallelism } from "node:os";
import { once } from "node:events";
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";

const WORKER = path.join(import.meta.dirname, "_worker.ts");

console.log("=== 1. Where are we? ===");
console.log("  isMainThread:", isMainThread, "| threadId:", threadId);
console.log("  availableParallelism():", availableParallelism(), "← the ceiling for CPU-bound workers");

console.log("\n=== 2. Creating a worker ===");
{
  // Native TypeScript stripping applies to workers too — no build step,
  // no loader, just point at the .ts file.
  const worker = new Worker(WORKER, { workerData: { seed: 7, role: "demo" } });

  const [ready] = (await once(worker, "message")) as [Record<string, unknown>];
  console.log("  worker says:", ready);

  worker.postMessage({ type: "double", payload: { n: 21 } });
  const [result] = (await once(worker, "message")) as [Record<string, unknown>];
  console.log("  result:     ", result);

  await worker.terminate();
  console.log(`
  workerData is cloned INTO the worker at startup — a one-way initial
  payload. After that it's postMessage in both directions.
`);
}

console.log("=== 3. Isolation: nothing is shared by default ===");
{
  (globalThis as { MAIN_ONLY?: string }).MAIN_ONLY = "set on the main thread";

  const worker = new Worker(WORKER, { workerData: null });
  const [ready] = (await once(worker, "message")) as [{ sawMainThreadGlobal: string | null }];
  console.log("  worker saw MAIN_ONLY:", ready.sawMainThreadGlobal, "← separate globals ✓");
  await worker.terminate();

  console.log(`
  Each worker gets its own V8 isolate: its own heap, globals, and module
  registry. Consequences:

    • Every module is re-imported per worker, so import-time side effects
      run again (module 01 §3.3). A module that opens a DB pool at import
      opens ONE PER WORKER.
    • A module-level cache is per-worker, not shared.
    • Memory is per-worker. Eight workers ≈ eight heaps.

  What IS shared: the process itself, file descriptors, and any
  SharedArrayBuffer you pass explicitly (see 03-messaging.ts).
`);
}

console.log("=== 4. Structured clone preserves what JSON cannot ===");
{
  const worker = new Worker(WORKER, { workerData: null });
  await once(worker, "message"); // the ready message

  worker.postMessage({
    type: "structured",
    payload: { date: new Date("2020-06-01T12:00:00.000Z"), map: new Map([["k", "v"]]) },
  });
  const [msg] = (await once(worker, "message")) as [{ sent: Record<string, unknown> }];

  const sent = msg.sent;
  console.log("  Date  →", sent["date"] instanceof Date ? `Date ✓ (${(sent["date"] as Date).toISOString()})` : "lost ✗");
  console.log("  Map   →", sent["map"] instanceof Map ? `Map ✓ (size ${(sent["map"] as Map<string, number>).size})` : "lost ✗");
  console.log("  Set   →", sent["set"] instanceof Set ? "Set ✓" : "lost ✗");
  console.log("  RegExp→", sent["regex"] instanceof RegExp ? "RegExp ✓" : "lost ✗");
  // ⚠ A Buffer arrives as a plain Uint8Array: the BYTES survive, the CLASS
  // does not. Buffer.isBuffer() is false, and so are .toString("hex"),
  // .readUInt32BE(), and every other Buffer method (module 04 §1).
  console.log(
    "  Buffer→",
    Buffer.isBuffer(sent["bytes"])
      ? "Buffer ✓"
      : `${(sent["bytes"] as object)?.constructor?.name} ✗ — bytes kept, CLASS lost`,
  );
  console.log("           re-wrap on arrival: Buffer.from(view.buffer, view.byteOffset, view.byteLength)");
  console.log("  undefined preserved:", "undef" in sent && sent["undef"] === undefined);

  // Cycles survive too — JSON.stringify would throw here.
  const cyclic: Record<string, unknown> = { name: "loop" };
  cyclic["self"] = cyclic;
  worker.postMessage({ type: "structured", payload: cyclic });
  await once(worker, "message");
  console.log("  cyclic object: sent without throwing ✓ (JSON.stringify would not)");

  await worker.terminate();

  console.log(`
  Structured clone handles Date, Map, Set, RegExp, TypedArray, Error, and
  cycles. It does NOT handle functions, class identity (you get a plain
  object back, not an instance of your class), or anything with a closure.

  Compare child_process fork(), which is JSON — Date becomes a string, Map
  becomes {}, undefined disappears.
`);
}

console.log("=== 5. Errors: a worker crash does NOT kill the parent ===");
{
  const worker = new Worker(WORKER, { workerData: null });
  await once(worker, "message");

  worker.postMessage({ type: "throw" });

  const [err] = (await once(worker, "error")) as [Error];
  console.log("  'error' event:", err.message);

  const [code] = (await once(worker, "exit")) as [number];
  console.log("  'exit' code:  ", code);
  console.log("  main thread is still alive ✓");

  console.log(`
  An uncaught throw inside a worker surfaces as an 'error' event on the
  parent, then 'exit'. Both fire — a pool that only listens for 'exit'
  will double-count, and one that only listens for 'error' leaks a slot.

  Handle both:
      worker.on("error", (err) => { failCurrentTask(err); replaceWorker(); });
      worker.on("exit",  (code) => { if (!expected) replaceWorker(); });
`);
}

console.log("=== 6. terminate() is abrupt; exiting yourself is clean ===");
{
  const abrupt = new Worker(WORKER, { workerData: null });
  await once(abrupt, "message");
  const t0 = performance.now();
  const code = await abrupt.terminate();
  console.log(`  terminate() → exit code ${code} in ${(performance.now() - t0).toFixed(1)}ms`);

  const graceful = new Worker(WORKER, { workerData: null });
  await once(graceful, "message");
  graceful.postMessage({ type: "exit" });
  const [gcode] = (await once(graceful, "exit")) as [number];
  console.log(`  self-exit   → exit code ${gcode}`);

  console.log(`
  terminate() kills the thread where it stands: no finally blocks, no
  flushes, in-flight work lost. Exit code 1.

  For a clean shutdown, message the worker and let it finish:
      worker.postMessage({ type: "shutdown" });
      await once(worker, "exit");
      // with a terminate() fallback on a timer, so a stuck worker can't
      // hold your process open forever
`);
}

console.log("=== 7. ⚠ AsyncLocalStorage does NOT cross the boundary ===");
{
  const als = new AsyncLocalStorage<{ requestId: string }>();

  await als.run({ requestId: "req-42" }, async () => {
    console.log("  main thread sees requestId:", als.getStore()?.requestId);

    const worker = new Worker(WORKER, { workerData: { requestId: als.getStore()?.requestId } });
    const [ready] = (await once(worker, "message")) as [{ workerData: { requestId?: string } }];
    console.log("  worker's own ALS store would be: undefined (separate isolate)");
    console.log("  …so pass it EXPLICITLY via workerData:", ready.workerData.requestId);
    await worker.terminate();
  });

  console.log(`
  Async context (module 07 §6) is per-isolate. Nothing propagates across a
  worker boundary automatically. Put your requestId / traceId in workerData
  or in every message, and re-enter a context inside the worker if you want
  the same logging ergonomics there.
`);
}

console.log("=== 8. Workers keep the process alive ===");
console.log(`
  A running worker is a ref'd handle, so Node will not exit while one
  exists. A pool you forgot to shut down is the usual reason a CLI hangs
  after printing its output.

      worker.unref();          // "don't keep the process alive for me"
      await pool.shutdown();   // better: shut it down explicitly

  Check what's holding you open (module 02 §1.1):
      process.getActiveResourcesInfo()
`);
