/**
 * 02 — Two microtask queues, and how to starve the loop
 *
 * Run:  node src/02-event-loop/02-nexttick-vs-microtask.ts
 */

console.log("=== 1. nextTick outranks promises — INSIDE the loop ===");

// Run this from inside a timer callback, not at the ESM top level. See
// 01-order.ts for why the top level of an ESM module reverses the order.
await new Promise<void>((resolve) => {
  setTimeout(() => {
    Promise.resolve().then(() => console.log("  promise A"));
    process.nextTick(() => console.log("  nextTick A"));
    Promise.resolve().then(() => console.log("  promise B"));
    process.nextTick(() => console.log("  nextTick B"));
    // → nextTick A, nextTick B, promise A, promise B
    // The ENTIRE nextTick queue drains before the promise queue gets a turn.
    setImmediate(resolve);
  }, 0);
});

console.log("\n=== 2. Each queue drains to exhaustion, including new entries ===");
let depth = 0;
process.nextTick(function recurse() {
  depth += 1;
  if (depth < 5) process.nextTick(recurse); // added DURING the drain — still runs now
});
setImmediate(() => console.log(`  loop advanced only after ${depth} nested nextTicks drained`));

await new Promise<void>((r) => setTimeout(r, 10));

console.log("\n=== 3. Starvation (the reason nextTick is dangerous) ===");
console.log(`
  This code hangs Node forever at 100% CPU:

      process.nextTick(function spin() { process.nextTick(spin); });
      setTimeout(() => console.log("never printed"), 0);

  The nextTick queue never empties, so the loop never advances to the timers
  phase. No timers, no I/O, no incoming connections, no graceful shutdown.
  A promise loop (\`Promise.resolve().then(spin)\`) starves it identically.

  The safe equivalent — setImmediate — schedules into the CHECK phase, so each
  iteration completes and the loop keeps servicing I/O:

      setImmediate(function spin() { setImmediate(spin); });   // safe
`);

// Demonstrate the safe version really does let I/O through.
let iterations = 0;
const stop = Date.now() + 50;
await new Promise<void>((resolve) => {
  let ioHappened = false;
  setTimeout(() => {
    ioHappened = true;
  }, 20);
  setImmediate(function spin() {
    iterations += 1;
    if (Date.now() < stop) return void setImmediate(spin);
    console.log(`  setImmediate spun ${iterations} times in 50ms`);
    console.log(`  ...and the timer still fired: ${ioHappened}`);
    resolve();
  });
});

console.log("\n=== 4. await is a microtask, not a yield ===");
// This loop NEVER lets the event loop advance, despite every line having `await`.
const start = performance.now();
let blocked = true;
setTimeout(() => {
  blocked = false;
}, 0);

for (let i = 0; i < 200_000; i++) {
  await Promise.resolve(i); // microtask → drains before the timers phase
}
console.log(`  200k awaits took ${(performance.now() - start).toFixed(1)}ms`);
console.log(`  timer STILL hasn't fired: ${blocked}`);

// To genuinely yield to the loop, schedule a macrotask:
await new Promise<void>((r) => setImmediate(r));
console.log(`  after one setImmediate yield, timer fired: ${!blocked}`);

console.log(`
=== Rules of thumb ===

  queueMicrotask(fn)   "after the current call stack, before any I/O".
                       The standard, portable choice.
  process.nextTick(fn) same, but jumps the queue ahead of promises.
                       Node-only, legacy. AVOID unless you have a specific
                       reason (the classic one: deferring an emit so the
                       caller can attach listeners first).
  setImmediate(fn)     "end of this loop iteration". The right tool for
                       chunking CPU work — it lets I/O through.
  setTimeout(fn, 0)    "some time later, ≥1ms". Least precise; use only when
                       you actually want a delay.
`);
