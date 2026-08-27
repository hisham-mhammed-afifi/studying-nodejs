/**
 * 06 — Keeping the loop breathing during long work
 *
 * Run:  node src/02-event-loop/06-yielding.ts
 */

const ITEMS = 200_000;
const data = Array.from({ length: ITEMS }, (_, i) => i);

/**
 * Deliberately non-trivial per-item work — roughly what parsing/formatting one
 * record costs. Cheap toy work (a single Math.sqrt) finishes 400k items in
 * ~15ms and teaches you nothing, because nothing ever gets a chance to block.
 */
function transform(n: number): number {
  let acc = 0;
  for (let k = 1; k <= 24; k++) {
    acc += Math.sin(n * k) / k + Math.sqrt(n + k) * 1e-6;
  }
  return acc;
}

/**
 * Max observed lateness of a 10ms interval — i.e. the longest stretch during
 * which the loop could not service a timer.
 *
 * MEASUREMENT SUBTLETY: a monitor cannot take a sample WHILE the loop is
 * blocked; it records the damage on the first sample AFTER. So we always let
 * the loop breathe once before reading the result, and exclude that from the
 * reported wall time.
 */
async function withLagReport(label: string, fn: () => Promise<number>): Promise<void> {
  let max = 0;
  let expected = performance.now() + 10;
  const timer = setInterval(() => {
    const now = performance.now();
    max = Math.max(max, now - expected);
    expected = now + 10;
  }, 10);
  timer.unref();

  const t0 = performance.now();
  const result = await fn();
  const wall = performance.now() - t0;

  await new Promise<void>((r) => setTimeout(r, 40));
  clearInterval(timer);

  console.log(
    `  ${label.padEnd(34)} ${wall.toFixed(0).padStart(5)}ms total   ` +
      `max lag ${max.toFixed(0).padStart(4)}ms   (checksum ${result.toFixed(2)})`,
  );
}

// Warm up the JIT first, otherwise whichever variant runs FIRST is unfairly
// penalised by V8 compiling `transform` from scratch. Benchmarking Node
// without a warm-up pass produces confidently wrong numbers.
for (let i = 0; i < 20_000; i++) transform(i);

console.log(`=== Four ways to process ${ITEMS.toLocaleString()} items ===\n`);

// --- 1. Naive synchronous loop. Fast, but nothing else runs. ---
await withLagReport("sync for-loop", async () => {
  let sum = 0;
  for (const n of data) sum += transform(n);
  return sum;
});

// --- 2. `await` per item. MUCH slower AND still blocking. Worst of both. ---
await withLagReport("await per item (anti-pattern)", async () => {
  let sum = 0;
  for (const n of data) sum += await Promise.resolve(transform(n));
  return sum;
});
// Why: await schedules a microtask, and microtasks drain to exhaustion before
// the loop advances. So you paid promise overhead 50,000 times and STILL
// blocked the loop. `await` is not a yield.

// --- 3. Chunked with setImmediate. Slightly slower, loop stays responsive. ---
await withLagReport("chunked via setImmediate", async () => {
  let sum = 0;
  const CHUNK = 5_000;
  for (let i = 0; i < data.length; i += CHUNK) {
    const end = Math.min(i + CHUNK, data.length);
    for (let j = i; j < end; j++) sum += transform(data[j] as number);
    // THIS is a real yield: setImmediate lands in the check phase, so the loop
    // completes an iteration and services timers and I/O in between chunks.
    await new Promise<void>((r) => setImmediate(r));
  }
  return sum;
});

// --- 4. Time-sliced: yield based on elapsed time, not item count. ---
// Better than a fixed chunk size, because per-item cost varies in real code.
await withLagReport("time-sliced (yield every 8ms)", async () => {
  let sum = 0;
  let sliceStart = performance.now();
  for (let i = 0; i < data.length; i++) {
    sum += transform(data[i] as number);
    if ((i & 0x3ff) === 0 && performance.now() - sliceStart > 8) {
      await new Promise<void>((r) => setImmediate(r));
      sliceStart = performance.now();
    }
  }
  return sum;
});
// The `(i & 0x3ff) === 0` bit checks the clock only every 1024 iterations —
// performance.now() is cheap but not free, and calling it 400k times shows up.

console.log(`
=== Reading that ===

  Total time is nearly identical across the three correct variants — the real
  difference is the LAG column. The sync loop froze everything for ~180ms;
  chunking cut that to single digits for roughly no throughput cost. In a
  server, that trade is free money.

  Row 2 is the one to internalise: adding \`await\` to every iteration made the
  job SLOWER and did not help latency at all. \`await\` schedules a microtask,
  and microtasks drain to exhaustion before the loop advances a phase. It is
  not a yield. People write this loop believing it "gives other requests a
  chance"; it does the opposite.

  Choose the chunk size by TIME, not by count: 8ms is a good target (it keeps
  you under a 60fps-ish budget and well under any sane health-check timeout).

=== When chunking is NOT the answer ===

  Chunking still burns your only JS thread — total throughput is unchanged,
  you just interleave. If the work is genuinely heavy and continuous, move it
  off-thread instead:

    worker_threads   real parallel JS. Best for CPU-bound work (module 08).
    a job queue      hand it to a separate process; return 202 Accepted.
    the database     SUM/GROUP BY in SQL beats pulling 400k rows into Node.
    native/WASM      some libraries release the thread properly.

  And the cheapest fix of all: don't move the data. Most "we need to process
  400k records in Node" problems are really "we wrote the wrong query".

=== A reusable helper ===
`);

/** Runs a generator's work, yielding to the event loop every \`budgetMs\`. */
export async function cooperative<T>(
  items: Iterable<T>,
  fn: (item: T) => void,
  budgetMs = 8,
): Promise<void> {
  let sliceStart = performance.now();
  let sinceCheck = 0;
  for (const item of items) {
    fn(item);
    if (++sinceCheck >= 512) {
      sinceCheck = 0;
      if (performance.now() - sliceStart > budgetMs) {
        await new Promise<void>((r) => setImmediate(r));
        sliceStart = performance.now();
      }
    }
  }
}

let total = 0;
const t = performance.now();
await cooperative(data, (n) => {
  total += transform(n);
});
console.log(`  cooperative() helper: ${(performance.now() - t).toFixed(0)}ms, checksum ${total.toFixed(2)}`);
