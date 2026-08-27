/**
 * 03 — Message costs: clone vs transfer vs shared memory
 *
 * The central design question for workers. Run it and read the numbers.
 *
 * Run:  node src/08-processes-workers/03-messaging.ts
 */

import { Worker } from "node:worker_threads";
import { once } from "node:events";

const MB = 1024 * 1024;
const SIZE = 32 * MB;

// A worker that just acknowledges whatever it receives, so we're timing the
// TRANSPORT, not any work.
const echo = new Worker(
  `
  const { parentPort } = require("node:worker_threads");
  parentPort.on("message", (m) => {
    parentPort.postMessage({ bytes: m.buf ? m.buf.byteLength : 0 });
  });
  `,
  { eval: true },
);

// `Transferable` is a DOM lib type; in Node the transferList is typed as
// readonly TransferListItem[] (ArrayBuffer, MessagePort, and friends).
async function roundTrip(
  payload: Record<string, unknown>,
  transfer: readonly ArrayBuffer[] = [],
): Promise<number> {
  const t0 = performance.now();
  const done = once(echo, "message");
  echo.postMessage(payload, [...transfer]);
  await done;
  return performance.now() - t0;
}

console.log(`=== Sending ${SIZE / MB}MB to a worker, three ways ===\n`);

// 1. Structured clone: the default. Copies every byte.
const cloned = new ArrayBuffer(SIZE);
const cloneMs = await roundTrip({ buf: cloned });
console.log(`  clone     ${cloneMs.toFixed(1).padStart(6)}ms   source after: ${cloned.byteLength / MB}MB (still usable)`);

// 2. Transfer: moves ownership. Zero copy, but the sender loses it.
const moved = new ArrayBuffer(SIZE);
const transferMs = await roundTrip({ buf: moved }, [moved]);
console.log(`  transfer  ${transferMs.toFixed(1).padStart(6)}ms   source after: ${moved.byteLength}B  ← DETACHED`);

// 3. SharedArrayBuffer: both threads see the same memory.
const shared = new SharedArrayBuffer(SIZE);
const sharedMs = await roundTrip({ buf: shared });
console.log(`  shared    ${sharedMs.toFixed(1).padStart(6)}ms   source after: ${shared.byteLength / MB}MB (shared)`);

console.log(`
  transfer is ~${(cloneMs / transferMs).toFixed(0)}× faster than clone; shared is ~${(cloneMs / sharedMs).toFixed(0)}× faster.

  The numbers scale with payload size, and that is the whole point:

      cost of moving data  vs  work you moved off the main thread

  Sending 32MB to save 20ms of CPU is a NET LOSS with clone. People
  "parallelise" a JSON parse, measure, and find it slower — this is why.
`);

console.log("=== 1. Clone: simple, safe, copies ===");
console.log(`
  worker.postMessage({ buf });        // both sides own their own copy

  ✓ the sender keeps its data
  ✓ handles Date, Map, Set, RegExp, TypedArray, Error, cycles
  ✗ allocates and copies the whole payload, on BOTH sides
  ✗ loses class identity — a Buffer arrives as a plain Uint8Array

  Fine for small messages: a task descriptor, a result, an id. Bad for
  megabytes on a hot path.
`);

console.log("=== 2. Transfer: zero-copy, one owner ===");
{
  const buf = new ArrayBuffer(1024);
  new Uint8Array(buf).fill(42);
  console.log("  before transfer: byteLength =", buf.byteLength);

  await roundTrip({ buf }, [buf]);

  console.log("  after transfer:  byteLength =", buf.byteLength, "← detached");
  try {
    new Uint8Array(buf)[0] = 1;
    console.log("  writing to it: silently did nothing (length 0)");
  } catch (err) {
    console.log("  writing to it threw:", (err as Error).message);
  }
}
console.log(`
  worker.postMessage({ buf }, [buf]);   // ownership MOVES

  ✓ no copy — constant time regardless of size
  ✗ the sender's buffer is DETACHED: byteLength 0, unusable
  ✗ only works for ArrayBuffer, MessagePort, and a few others — not for a
    plain object graph

  Use it for a one-way handoff: you built the payload, you're done with it,
  the worker owns it now. Reusing a transferred buffer is a silent no-op
  bug, not a loud error — the classic symptom is "the second request sends
  an empty body".
`);

console.log("=== 3. SharedArrayBuffer: both threads, one memory ===");
{
  const sab = new SharedArrayBuffer(1024);
  const view = new Int32Array(sab);
  view[0] = 100;

  const mutator = new Worker(
    `
    const { parentPort, workerData } = require("node:worker_threads");
    const view = new Int32Array(workerData.sab);
    Atomics.add(view, 0, 23);           // read-modify-write, atomically
    Atomics.store(view, 1, 999);
    parentPort.postMessage("done");
    `,
    { eval: true, workerData: { sab } },
  );

  await once(mutator, "message");
  await mutator.terminate();

  console.log("  main thread wrote 100; worker added 23 →", Atomics.load(view, 0));
  console.log("  worker also wrote index 1 →", Atomics.load(view, 1));
  console.log("  no message was needed to read the result ✓");
}

console.log(`
  ✓ genuinely shared — no copy, no transfer, no message per update
  ✓ the only way to have both threads work on one dataset
  ✗ raw bytes only: no objects, no strings, no structure
  ✗ you are now writing concurrent code, with real data races

  Because there are no locks, every read-modify-write needs Atomics:

      Atomics.add(view, 0, 1);                       // atomic increment
      Atomics.load(view, 0);                          // atomic read
      Atomics.store(view, 0, 5);                      // atomic write
      Atomics.compareExchange(view, 0, expect, next); // CAS

  A plain \`view[0]++\` from two threads loses increments — it's a read, an
  add, and a write, and the other thread can land in between.
`);

console.log("=== 4. Atomics.wait / notify ===");
console.log(`
  Atomics.wait(view, 0, expected);   // BLOCK until view[0] !== expected
  Atomics.notify(view, 0, 1);        // wake one waiter

  ⚠ Atomics.wait BLOCKS THE THREAD — event loop and all. On the main thread
  of a server that is every problem from module 02 at once: no timers, no
  I/O, no health checks, for as long as you wait. Node throws if you try it
  on the main thread of a Worker-less process in some modes, but do not rely
  on that.

  It is meant for a WORKER deliberately parking until there is work — a
  lock-free queue where the consumer sleeps instead of spinning.

  For anything less specialised, postMessage is the right tool and the
  event loop stays alive.
`);

console.log("=== 5. Choosing ===");
console.log(`
  small payload, simple objects     → clone (just postMessage)
  large buffer, one-way handoff     → transfer
  large dataset, both sides work    → SharedArrayBuffer + Atomics
  many small updates, hot loop      → SharedArrayBuffer (no message overhead)

  And the question before all of those:

      Is the work I'm moving bigger than the data I'm moving?

  If not, do it inline. A worker is not free (module 08 §6), and neither is
  the copy.
`);

await echo.terminate();
