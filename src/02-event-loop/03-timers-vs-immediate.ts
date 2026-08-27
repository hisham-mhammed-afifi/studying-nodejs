/**
 * 03 — setTimeout(0) vs setImmediate: when order is guaranteed
 *
 * Run it several times.  for i in 1 2 3 4 5; do node src/02-event-loop/03-timers-vs-immediate.ts; done
 *
 * Section 1's order may flip between runs. Section 2's never will.
 */

import { readFile } from "node:fs/promises";
import { open } from "node:fs";

console.log("=== 1. At the top level: NON-DETERMINISTIC ===");
await new Promise<void>((resolve) => {
  const order: string[] = [];
  setTimeout(() => {
    order.push("setTimeout");
  }, 0);
  setImmediate(() => {
    order.push("setImmediate");
    // Give the timer a chance if it hasn't fired.
    setImmediate(() => {
      console.log("  order:", order.join(" → "));
      resolve();
    });
  });
});
console.log(`
  Why non-deterministic: setTimeout(fn, 0) is clamped to 1ms. When the loop
  first reaches the TIMERS phase, either that millisecond has already elapsed
  (timer fires first) or it hasn't (loop falls through to CHECK, setImmediate
  fires first). Which one depends on how long process startup happened to take
  — machine load, disk, V8 warm-up. It is a genuine race.
`);

console.log("=== 2. Inside an I/O callback: GUARANTEED ===");
await new Promise<void>((resolve) => {
  open(import.meta.filename, "r", (err, fd) => {
    if (err) throw err;
    const order: string[] = [];
    // We are in the POLL phase now. The loop's position is known.
    setTimeout(() => {
      order.push("setTimeout");
    }, 0);
    setImmediate(() => {
      order.push("setImmediate");
      setImmediate(() => {
        console.log("  order:", order.join(" → "));
        console.log(`
  ALWAYS setImmediate first. Phase order within one iteration is:
      ... → poll (we are here) → CHECK → close → [next lap] → TIMERS → ...
  So 'check' is a few microseconds away; 'timers' is a whole lap away.
`);
        // Clean up: an open fd keeps nothing alive by itself, but leaking fds
        // is how you hit EMFILE in production.
        void import("node:fs").then(({ close }) => close(fd, () => resolve()));
      });
    });
  });
});

console.log("=== 3. Timers are a floor, not a guarantee ===");
{
  const scheduled = performance.now();
  await new Promise<void>((r) => setTimeout(r, 50));
  const actual = performance.now() - scheduled;
  console.log(`  asked for 50ms, got ${actual.toFixed(1)}ms`);

  // Now do the same while the loop is busy. The timer cannot fire until the
  // synchronous work finishes — it is not preemptive.
  const scheduled2 = performance.now();
  const p = new Promise<number>((r) => setTimeout(() => r(performance.now() - scheduled2), 20));
  const spinUntil = Date.now() + 120;
  while (Date.now() < spinUntil) {
    /* blocking the thread on purpose */
  }
  console.log(`  asked for 20ms while blocking 120ms, got ${(await p).toFixed(1)}ms`);
  console.log(`
  Lesson: never measure elapsed time by counting timer ticks. A setInterval
  of 1000ms does NOT tick 60 times per minute under load — it drifts, and it
  does not "catch up". Use performance.now() / Date.now() deltas instead.
`);
}

console.log("=== 4. unref(): timers that don't keep the process alive ===");
{
  // Normally a pending timer holds the loop open. This one does not.
  const ghost = setInterval(() => console.log("  you will never see this"), 1000);
  ghost.unref();
  console.log("  scheduled a 1s interval, then unref'd it");
  console.log("  the process will exit immediately instead of waiting");
  console.log(`
  Use unref() for: keepalive pings, cache sweepers, metrics flushes, health
  probes — any background timer that must not stop a CLI or worker from
  exiting when its real work is done. Call ref() to opt back in.

  Same idea exists on sockets and servers: server.unref().
`);
}

// Prove the file read still works (unrelated, but shows fs/promises style).
const self = await readFile(import.meta.filename, "utf8");
console.log(`(this file is ${self.split("\n").length} lines long)`);
