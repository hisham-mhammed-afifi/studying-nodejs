# 02 — The Event Loop

The single most valuable thing to actually understand about Node. Browser JS gave you *a* microtask queue; Node gives you **six loop phases, two microtask queues, and a thread pool**. The interactions between them explain most "why did that run in that order" confusion — and most production latency bugs.

---

## 1. The shape of it

Node is a C++ program (V8 + libuv) that runs your JavaScript on **one thread** and hands blocking work to the OS or to a **thread pool**. The "loop" is libuv repeatedly asking: is there anything to do? If yes, do it, then check again. When the answer is no, the process exits.

```
   ┌───────────────────────────────────────────────┐
   │  timers          setTimeout / setInterval     │
   ├───────────────────────────────────────────────┤
   │  pending callbacks   deferred system errors   │
   ├───────────────────────────────────────────────┤
   │  idle, prepare       (internal)               │
   ├───────────────────────────────────────────────┤
   │  poll     ← retrieve I/O events; BLOCK HERE   │
   ├───────────────────────────────────────────────┤
   │  check           setImmediate                 │
   ├───────────────────────────────────────────────┤
   │  close callbacks     'close' events           │
   └───────────────────────────────────────────────┘
        ↑                                    │
        └────────────────────────────────────┘

   Between EVERY callback (and every phase transition):
        drain process.nextTick queue    ← higher priority
        then drain the microtask queue  ← promises, queueMicrotask
```

**Poll is the phase that blocks.** If nothing else is scheduled, Node sits inside `epoll`/`kqueue`/IOCP waiting, consuming no CPU. That's the whole "non-blocking I/O" story: the thread isn't spinning, it's parked in a syscall.

### 1.1 Watch the loop exit

The loop runs while there is *referenced* work pending. This script exits immediately:

```ts
console.log("done");
// nothing pending → process exits
```

This one runs for a second:

```ts
setTimeout(() => console.log("later"), 1000);
// a pending timer keeps the loop alive
```

And this one runs **forever**, because `setInterval` never stops being pending:

```ts
setInterval(() => {}, 1000);   // ✗ the process never exits
```

`unref()` opts a handle out of keeping the loop alive:

```ts
setInterval(() => console.log("tick"), 1000).unref();
console.log("done");
// prints "done", then exits immediately — the interval never fires
```

You can inspect what's holding the process open:

```ts
setTimeout(() => {}, 5000);
console.log(process.getActiveResourcesInfo());
// [ 'Timeout' ]     ← Node 17.3+; invaluable for "why won't my CLI exit"
```

---

## 2. Priority rules

1. `process.nextTick` callbacks — drained completely first.
2. Promise microtasks (`.then`, `await` continuations, `queueMicrotask`) — drained completely.
3. Then, and only then, the next macrotask/phase.

```ts
setTimeout(() => console.log("4 timer"), 0);
setImmediate(() => console.log("5 immediate"));
Promise.resolve().then(() => console.log("3 promise"));
process.nextTick(() => console.log("2 nextTick"));
console.log("1 sync");

// inside a CJS file or anywhere in the loop:
// 1 sync / 2 nextTick / 3 promise / 4 timer / 5 immediate
```

### 2.1 The ESM caveat — and why it doesn't matter

At the **top level of an ESM module**, rule 1 inverts:

```bash
# CommonJS: nextTick first, as documented
node -e 'Promise.resolve().then(()=>console.log("promise")); process.nextTick(()=>console.log("nextTick"))'
# → nextTick / promise

# ESM top level: promise first
node --input-type=module -e 'Promise.resolve().then(()=>console.log("promise")); process.nextTick(()=>console.log("nextTick"))'
# → promise / nextTick

# ESM, but inside a timer: back to normal
node --input-type=module -e 'setTimeout(()=>{Promise.resolve().then(()=>console.log("promise")); process.nextTick(()=>console.log("nextTick"))},0)'
# → nextTick / promise
```

Why: ESM module evaluation is itself driven by promises, so your `.then` callbacks drain as part of *that* microtask checkpoint, before control returns to the layer that processes `nextTick`.

The real lesson isn't the trivia. **If your correctness depends on nextTick-vs-promise ordering, your code is broken.** That ordering is an implementation detail that already changed once.

### 2.2 Both queues drain to exhaustion

A callback that schedules more of its own kind gets drained **in the same pass**:

```ts
let depth = 0;
process.nextTick(function recurse() {
  depth++;
  if (depth < 5) process.nextTick(recurse);   // added DURING the drain
});
setImmediate(() => console.log(depth));       // 5 — the loop waited for all of them
```

### 2.3 Starvation

Because the drain is unbounded, this **hangs the process forever at 100% CPU**:

```ts
process.nextTick(function spin() { process.nextTick(spin); });
setTimeout(() => console.log("never printed"), 0);
// No timers. No I/O. No incoming connections. No graceful shutdown. Nothing.
```

A promise loop starves it identically:

```ts
(function spin() { Promise.resolve().then(spin); })();   // ✗ same result
```

The safe equivalent schedules into the **check** phase, so each loop iteration completes:

```ts
setImmediate(function spin() { setImmediate(spin); });   // ✓ I/O still flows
```

### 2.4 Rules of thumb

| | Meaning | Use when |
|---|---|---|
| `queueMicrotask(fn)` | after the current stack, before any I/O | you need a microtask; the portable standard choice |
| `process.nextTick(fn)` | same, but ahead of promises | **avoid.** Node-only, legacy, easy to starve with |
| `setImmediate(fn)` | end of this loop iteration | chunking CPU work — it lets I/O through |
| `setTimeout(fn, 0)` | some time later, ≥1ms | you actually want a delay |

The one defensible use of `nextTick` is deferring an emit so a caller can attach listeners first — and `setImmediate` is usually clearer even there.

---

## 3. `setTimeout(0)` vs `setImmediate`

### 3.1 At the top level: non-deterministic

```ts
setTimeout(() => console.log("timeout"), 0);
setImmediate(() => console.log("immediate"));
// Order VARIES between runs. Try it five times.
```

`setTimeout(fn, 0)` is clamped to 1ms. When the loop first reaches the timers phase, either that millisecond has elapsed (timer fires) or it hasn't (loop falls through to check). Which one wins depends on how long process startup happened to take. It's a genuine race.

### 3.2 Inside an I/O callback: guaranteed

```ts
import { readFile } from "node:fs";

readFile(import.meta.filename, () => {
  // We are in the POLL phase. The loop's position is known.
  setTimeout(() => console.log("timeout"), 0);
  setImmediate(() => console.log("immediate"));
});
// ALWAYS: immediate / timeout
```

Phase order within one iteration is `… → poll (we are here) → check → close → [next lap] → timers → …`. So `check` is microseconds away; `timers` is a whole lap away.

**Mental model:** `setImmediate` = "at the end of *this* iteration". `setTimeout(fn, 0)` = "at the start of *some future* iteration".

### 3.3 Timers are a floor, not a promise

```ts
const t0 = performance.now();
setTimeout(() => console.log(performance.now() - t0), 20);

// Block the thread for 120ms:
const until = Date.now() + 120;
while (Date.now() < until) {}

// prints ~120, not ~20. Timers are not preemptive.
```

Consequences:

- A `setInterval(fn, 1000)` does **not** tick 60 times per minute under load. It drifts, and it does not catch up.
- Never measure elapsed time by counting ticks. Use `performance.now()` deltas.

```ts
// ✗ drifts
let seconds = 0;
setInterval(() => { seconds++; }, 1000);

// ✓ accurate
const start = performance.now();
const elapsed = () => (performance.now() - start) / 1000;
```

### 3.4 `unref()` in practice

```ts
// A metrics flush that must not stop the CLI from exiting
const flusher = setInterval(() => metrics.flush(), 30_000);
flusher.unref();

// A shutdown watchdog that must not itself hang the process
setTimeout(() => process.exit(1), 10_000).unref();
```

The same idea exists on sockets and servers: `server.unref()`, `socket.unref()`.

---

## 4. `await` is not a yield

This is the misconception that costs the most production latency.

```ts
for (const item of tenThousandItems) {
  await Promise.resolve(transform(item));   // ✗ STILL blocks the loop
}
```

`await x` suspends the function and schedules the continuation as a **microtask**. Microtasks drain completely before the loop advances a phase. So the loop never gets a turn:

```ts
let fired = false;
setTimeout(() => { fired = true; }, 0);

for (let i = 0; i < 200_000; i++) await Promise.resolve(i);

console.log(fired);   // false — the timer STILL hasn't run
```

To genuinely yield:

```ts
await new Promise<void>((r) => setImmediate(r));
console.log(fired);   // true
```

### 4.1 Sequential vs parallel vs bounded

```ts
// SEQUENTIAL — 10 requests × 100ms = 1000ms. Usually accidental.
for (const url of urls) results.push(await fetch(url));

// PARALLEL — 100ms total, but NO limit. 10,000 urls = 10,000 open sockets,
// exhausted file descriptors, or an OOM.
const results = await Promise.all(urls.map(fetch));

// BOUNDED — the one you actually want. You build this in the exercise.
const results = await mapLimit(urls, 10, fetch);
```

`Promise.all` also rejects on the *first* failure and discards the rest. When you want every outcome:

```ts
const settled = await Promise.allSettled(urls.map(fetch));
const ok   = settled.filter((r) => r.status === "fulfilled").map((r) => r.value);
const bad  = settled.filter((r) => r.status === "rejected").map((r) => r.reason);
```

---

## 5. The libuv thread pool

Some work can't be done non-blockingly by the OS, so libuv runs it on a **pool of 4 threads by default**.

### 5.1 What uses it

| On the pool (4 threads) | Not on the pool (truly async) |
|---|---|
| `fs.*` — every filesystem call | `net` / `http` / `https` / `tls` sockets |
| `crypto.pbkdf2`, `randomBytes`, `scrypt` | `dns.resolve4`, `dns.resolveMx`, … |
| `zlib.*` — gzip, brotli | `child_process`, `worker_threads` |
| `dns.lookup` (calls blocking `getaddrinfo`) | |

So **10,000 concurrent HTTP connections are cheap**, but **5 concurrent `pbkdf2` calls are not** — they queue 4 at a time.

### 5.2 Watch it saturate

```ts
import { pbkdf2 } from "node:crypto";

const t0 = performance.now();
for (let i = 0; i < 8; i++) {
  pbkdf2("password", `salt-${i}`, 300_000, 64, "sha512", () => {
    console.log(`job ${i}: ${(performance.now() - t0).toFixed(0)}ms`);
  });
}
```

```
job 0:  301ms   ┐
job 1:  301ms   │ first 4 — one per thread
job 2:  303ms   │
job 3:  303ms   ┘
job 4:  570ms   ┐
job 5:  570ms   │ next 4 — they had to WAIT
job 6:  571ms   │
job 7:  573ms   ┘
```

A staircase. The last job's latency is 2× the first's, for identical work. Re-run with `UV_THREADPOOL_SIZE=8` and they all finish together.

### 5.3 The cross-contamination problem

The pool is shared, so unrelated operations interfere:

```ts
// Baseline: a trivial file read while the pool is idle
await readFile("small.txt");                // ~0.5ms

// Now saturate the pool with password hashing, then read the same file
for (let i = 0; i < 4; i++) pbkdf2(/* … 400k iterations … */);
await readFile("small.txt");                // ~400ms
```

Nothing about the file changed. This is the failure mode that gets diagnosed as "our disk is slow" when the real cause is `bcrypt` on the same four threads.

`dns.lookup` makes it worse: every outgoing `http.request()` calls it, so a service that fans out to many hosts can occupy the pool with DNS alone. Mitigations: raise `UV_THREADPOOL_SIZE`, enable `keepAlive` on your HTTP agent (fewer lookups), or add a userland DNS cache.

### 5.4 Tuning

```bash
UV_THREADPOOL_SIZE=16 node app.ts
```

Must be set **before the pool is created** — as an env var at launch, not with `process.env` in your code, because the first pool use wins and you rarely control when that is.

Max is 1024. Sensible values: roughly your core count for CPU-bound pool work, higher (32–128) for fs/DNS-heavy services where threads mostly wait. Each thread costs a stack; measure before and after.

**The pool does not help with JavaScript CPU work.** Your JS still runs on one thread. For that you need `worker_threads` (module 08).

---

## 6. Blocking, and how to measure it

### 6.1 A 15-line lag monitor

Schedule a timer for N ms and measure how *late* it fires. The loop can only be late if it was busy. This is the core of every APM's "event loop lag" metric:

```ts
function monitorLag(intervalMs = 20) {
  let max = 0;
  let expected = performance.now() + intervalMs;
  const timer = setInterval(() => {
    const now = performance.now();
    max = Math.max(max, now - expected);
    expected = now + intervalMs;     // re-anchor from NOW, or drift accumulates
  }, intervalMs);
  timer.unref();
  return { get maxLagMs() { return max; }, stop: () => clearInterval(timer) };
}
```

> **Measurement subtlety:** a monitor cannot sample *while* the loop is blocked — it records the damage on the first sample *after*. Always let the loop breathe once before reading the result, or a fully blocking run reports 0ms.

### 6.2 The built-in histogram

```ts
import { monitorEventLoopDelay } from "node:perf_hooks";

const h = monitorEventLoopDelay({ resolution: 10 });
h.enable();
// ... let the app run ...
h.disable();

console.log({
  mean: h.mean / 1e6,            // values are in NANOseconds
  max:  h.max / 1e6,
  p99:  h.percentile(99) / 1e6,
});
```

### 6.3 Measured costs

From `04-blocking.ts` on a typical machine:

| Operation | Wall time | Loop lag |
|---|---|---|
| idle baseline | 100ms | **1ms** |
| tight 300ms CPU loop | 359ms | **280ms** |
| `JSON.parse` of ~20MB | 181ms | **103ms** |
| `pbkdf2Sync` (200k iterations) | 155ms | **75ms** |
| `createHash` over 50MB | 109ms | **30ms** |

"Loop lag" is how long the process accepted no connections, wrote no responses, and answered no health checks. At 100 req/s, 300ms of lag queues 30 requests.

**Budget for a request handler:**

| Lag | Verdict |
|---|---|
| < 1ms | fine |
| 1–10ms | acceptable if not on every request |
| > 50ms | you are the reason p99 is bad |
| > 1s | health checks fail; the orchestrator kills you |

### 6.4 Common blockers, in order of how often they bite

```ts
// 1. Large JSON. The most common by far.
JSON.parse(hugeBody);              // → stream, paginate, cap body size

// 2. Sync fs in a handler.
fs.readFileSync(p); fs.existsSync(p);   // → fs/promises

// 3. Unbounded array work.
rows.map(...).filter(...).sort(...);    // 100k+ items → chunk, or do it in SQL

// 4. Catastrophic regex backtracking on user input (ReDoS).
/^(a+)+$/.test(userInput);              // → linear-time patterns

// 5. Sync crypto.
pbkdf2Sync, scryptSync, bcrypt.hashSync; // → the async variants

// 6. Template rendering, markdown, image work.
                                         // → worker threads (module 08)
```

### 6.5 Finding them in production

```bash
node --cpu-prof app.ts        # writes a .cpuprofile — open in Chrome DevTools
node --trace-sync-io app.ts   # warns about sync I/O after the first tick
node --inspect app.ts         # attach DevTools to a live process
```

```ts
// Export lag as a metric and alert on it
setInterval(() => metrics.gauge("event_loop_lag_ms", h.percentile(99) / 1e6), 10_000).unref();
```

---

## 7. Keeping the loop breathing

### 7.1 Chunking

```ts
// ✗ blocks for the whole duration
let sum = 0;
for (const n of items) sum += transform(n);

// ✓ yields between chunks
const CHUNK = 5_000;
for (let i = 0; i < items.length; i += CHUNK) {
  const end = Math.min(i + CHUNK, items.length);
  for (let j = i; j < end; j++) sum += transform(items[j]);
  await new Promise<void>((r) => setImmediate(r));   // a REAL yield
}
```

### 7.2 Time-slicing — better than a fixed chunk size

Per-item cost varies in real code, so yield based on the clock:

```ts
export async function cooperative<T>(
  items: Iterable<T>,
  fn: (item: T) => void,
  budgetMs = 8,
): Promise<void> {
  let sliceStart = performance.now();
  let sinceCheck = 0;
  for (const item of items) {
    fn(item);
    // Only consult the clock every 512 items — performance.now() is cheap but
    // not free, and at millions of iterations it becomes a real cost.
    if (++sinceCheck >= 512) {
      sinceCheck = 0;
      if (performance.now() - sliceStart > budgetMs) {
        await new Promise<void>((r) => setImmediate(r));
        sliceStart = performance.now();
      }
    }
  }
}
```

8ms is a good target: comfortably under any sane health-check timeout.

### 7.3 What it actually buys you

From `06-yielding.ts`, 200,000 items:

| Approach | Total | Max lag |
|---|---|---|
| sync for-loop | 192ms | **182ms** |
| `await` per item | 202ms | **192ms** ← slower *and* still blocking |
| chunked via `setImmediate` | 188ms | **6ms** |
| time-sliced (8ms budget) | 188ms | **9ms** |

Throughput is essentially unchanged; lag drops by 30×. In a server that trade is free money.

Row 2 is the one to internalise: adding `await` to every iteration made it *slower* and helped latency *not at all*.

### 7.4 When chunking is the wrong answer

Chunking still burns your only JS thread — total throughput is unchanged, you just interleave. If the work is heavy and continuous, move it off-thread:

| Option | Good for |
|---|---|
| `worker_threads` | real parallel JS, CPU-bound work (module 08) |
| a job queue | hand it to another process, return `202 Accepted` |
| **the database** | `SUM`/`GROUP BY` in SQL beats pulling 400k rows into Node |
| native / WASM | some libraries release the thread properly |

The cheapest fix of all: don't move the data. Most "we need to process 400k records in Node" problems are really "we wrote the wrong query".

---

## 8. Files in this module

| File | What it demonstrates |
|---|---|
| `01-order.ts` | the ordering puzzle — predict before running; includes the ESM trap |
| `02-nexttick-vs-microtask.ts` | two microtask queues, exhaustive draining, starvation |
| `03-timers-vs-immediate.ts` | non-determinism at top level, determinism in I/O, `unref` |
| `04-blocking.ts` | measuring loop lag; what sync work costs |
| `05-threadpool.ts` | the 4-thread pool saturating; cross-contamination |
| `06-yielding.ts` | four ways to process 200k items, benchmarked |
| `exercise.ts` | `mapLimit`, a lag monitor, `yieldToLoop`, cooperative processing |

```bash
node src/02-event-loop/index.ts                    # all six demos
UV_THREADPOOL_SIZE=8 node src/02-event-loop/05-threadpool.ts   # compare
node scripts/test.ts 02                            # test your exercise
node scripts/test.ts --solutions 02
```

---

## 9. Check yourself

1. Why does `process.nextTick` recursion hang the process while `setImmediate` recursion doesn't?
2. Your HTTP handler calls `crypto.pbkdf2` (the async one). At what concurrency does latency start climbing, and why?
3. `setTimeout(f, 0)` vs `setImmediate(g)` — when is the order guaranteed, and when isn't it?
4. Your p99 latency spikes every 30 seconds. Where do you look first?
5. Someone adds `await` inside a hot loop "so other requests get a chance". What actually happens?
6. Your CLI finishes its work but never exits. What's the first thing you check?
7. A file read that normally takes 0.5ms sometimes takes 400ms, with no disk pressure. What's the likely cause?
