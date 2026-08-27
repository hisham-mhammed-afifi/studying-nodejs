/**
 * 04 — Blocking the loop, and measuring it
 *
 * Run:  node src/02-event-loop/04-blocking.ts
 *
 * This is the module that will save you in production. "The service is slow"
 * almost always means "something is blocking the loop".
 */

import { createHash, pbkdf2Sync } from "node:crypto";

/**
 * Event-loop lag monitor.
 *
 * The trick: schedule a timer for N ms, then measure how late it actually
 * fires. The loop can only be late if it was busy. This ~10 lines is the core
 * of every APM's "event loop lag" metric.
 */
function monitorLag(intervalMs = 20) {
  let max = 0;
  let expected = performance.now() + intervalMs;
  const timer = setInterval(() => {
    const lag = performance.now() - expected;
    if (lag > max) max = lag;
    expected = performance.now() + intervalMs;
  }, intervalMs);
  timer.unref(); // never let the monitor keep the process alive
  return {
    get maxLagMs() {
      return max;
    },
    reset() {
      max = 0;
      expected = performance.now() + intervalMs;
    },
    stop() {
      clearInterval(timer);
    },
  };
}

const lag = monitorLag();

async function measure(label: string, fn: () => void | Promise<void>): Promise<void> {
  lag.reset();
  const t0 = performance.now();
  await fn();
  // Let the monitor observe at least one tick after the work.
  await new Promise<void>((r) => setTimeout(r, 60));
  const wall = performance.now() - t0;
  console.log(
    `  ${label.padEnd(38)} wall ${wall.toFixed(0).padStart(5)}ms   max loop lag ${lag.maxLagMs.toFixed(0).padStart(5)}ms`,
  );
}

console.log("=== Blocking vs non-blocking, measured ===\n");

await measure("idle (baseline)", async () => {
  await new Promise<void>((r) => setTimeout(r, 100));
});

await measure("a tight 300ms CPU loop", () => {
  const until = Date.now() + 300;
  while (Date.now() < until) {
    /* nothing */
  }
});

await measure("JSON.parse of a ~20MB string", () => {
  const big = JSON.stringify({ rows: Array.from({ length: 120_000 }, (_, i) => ({ i, s: "x".repeat(80) })) });
  JSON.parse(big);
});

await measure("pbkdf2Sync (the SYNC variant)", () => {
  pbkdf2Sync("password", "salt", 200_000, 64, "sha512");
});

await measure("hashing 50MB synchronously", () => {
  createHash("sha256").update(Buffer.alloc(50 * 1024 * 1024, 7)).digest("hex");
});

console.log(`
=== Reading those numbers ===

  "wall" is how long the operation took.
  "max loop lag" is how long the loop was UNABLE to do anything else.

  Lag ≈ wall  → fully blocking. During that window your server accepted no
                connections, wrote no responses, and answered no health checks.
                At 100 req/s, 300ms of lag queues 30 requests.
  Lag ≈ 0     → the work happened off-thread, or in small enough pieces.

  Rules of thumb for a request handler:
      < 1ms     fine
      1-10ms    acceptable if not on every request
      > 50ms    you are the reason p99 is bad
      > 1s      health checks are failing; the orchestrator will kill you

=== Common blockers, in rough order of how often they bite ===

  1. JSON.parse / JSON.stringify on large payloads.  → stream, paginate, or cap body size
  2. Synchronous fs (readFileSync, existsSync) in a handler.  → fs/promises
  3. Unbounded array work: .map/.filter/.sort over 100k+ items.  → chunk, or push to the DB
  4. Catastrophic regex backtracking on user input (ReDoS).  → linear-time patterns, timeouts
  5. Sync crypto: pbkdf2Sync, scryptSync, bcrypt sync mode.  → the async variants
  6. Template rendering / markdown / image work.  → worker threads (module 08)

=== How to find them in production ===

  • Track event loop lag as a metric. Node has it built in:
        import { monitorEventLoopDelay } from "node:perf_hooks";
        const h = monitorEventLoopDelay({ resolution: 10 });
        h.enable();
        // later: h.mean, h.max, h.percentile(99)   (in NANOseconds)
  • Profile a live process:  node --cpu-prof app.ts   → load the .cpuprofile in Chrome DevTools
  • Grab a profile from a running process without restarting it:  \`node --inspect\` + DevTools
  • \`node --trace-sync-io\` warns about sync I/O after the first tick.
`);

// The built-in histogram, for comparison with our hand-rolled monitor.
const { monitorEventLoopDelay } = await import("node:perf_hooks");
const h = monitorEventLoopDelay({ resolution: 10 });
h.enable();
{
  const until = Date.now() + 200;
  while (Date.now() < until) {
    /* block */
  }
}
await new Promise<void>((r) => setTimeout(r, 50));
h.disable();
console.log("=== node:perf_hooks histogram (nanoseconds) ===");
console.log(`  mean: ${(h.mean / 1e6).toFixed(1)}ms   max: ${(h.max / 1e6).toFixed(1)}ms   p99: ${(h.percentile(99) / 1e6).toFixed(1)}ms`);

lag.stop();
