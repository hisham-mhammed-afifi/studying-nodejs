# 07 — Errors, Diagnostics & Async Context

Everything so far has been about making things work. This module is about what happens when they don't: how to represent failure, how to keep enough information to debug it at 3am, and how to carry request context through async code without threading it through every function signature.

---

## 1. The `Error` object

```ts
const err = new Error("something failed");
err.name;      // "Error"    — used by the stack's first line
err.message;   // "something failed"
err.stack;     // "Error: something failed\n    at foo (/app/x.ts:3:9)\n    at ..."
err.cause;     // undefined  — see §2
```

### 1.1 Error properties are non-enumerable

```ts
JSON.stringify(new Error("boom"));   // "{}"     ← everything vanishes
Object.keys(new Error("boom"));      // []
```

This bites every logging pipeline. `logger.info({ err })` with a JSON serialiser produces `{"err":{}}` unless the logger knows about errors (pino and bunyan do; a hand-rolled `JSON.stringify` does not).

Fix it explicitly:

```ts
function serializeError(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) return { value: String(err) };
  return {
    name: err.name,
    message: err.message,
    stack: err.stack,
    ...(err.cause !== undefined ? { cause: serializeError(err.cause) } : {}),
    // Custom own-properties (code, statusCode, …) ARE enumerable:
    ...Object.fromEntries(Object.entries(err)),
  };
}
```

### 1.2 Stacks are captured at construction, not at throw

```ts
const err = new Error("later");   // ← stack captured HERE
setTimeout(() => { throw err; }, 1000);   // not here
```

So creating errors ahead of time, or reusing a singleton error object, gives you a stack pointing at the wrong place. Always construct at the failure site.

`Error.stackTraceLimit` defaults to **10** frames. Raise it while debugging:

```ts
Error.stackTraceLimit = 50;        // or: node --stack-trace-limit=50
```

`Error.captureStackTrace(this, MyError)` omits the constructor frames, so the stack starts at your caller instead of inside your error class:

```ts
class NotFound extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFound";
    Error.captureStackTrace?.(this, NotFound);   // V8-only; optional-chain for portability
  }
}
```

---

## 2. `cause`: the chain that saves you

`new Error(msg, { cause })` (ES2022) is the single most valuable error feature in modern JS. Use it **every time you rewrap**.

```ts
try {
  await db.query(sql);
} catch (err) {
  throw new Error(`Failed to load user ${id}`, { cause: err });
}
```

```
Error: Failed to load user 42
    at loadUser (/app/users.ts:12:11)
  [cause]: Error: connection terminated
      at Connection.query (/app/db.ts:88:15)
    [cause]: Error: ECONNREFUSED 10.0.0.5:5432
```

`console.error` prints the whole chain. Without `cause` you get *either* the useful low-level detail *or* the useful high-level context — never both.

Walking the chain:

```ts
function* causes(err: unknown): Generator<Error> {
  let current = err;
  const seen = new Set<unknown>();          // guard against cycles
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    yield current;
    current = current.cause;
  }
}

function rootCause(err: unknown): Error | undefined {
  let last: Error | undefined;
  for (const e of causes(err)) last = e;
  return last;
}

function findCause<T>(err: unknown, pred: (e: Error) => e is Error & T): (Error & T) | undefined {
  for (const e of causes(err)) if (pred(e)) return e;
  return undefined;
}
```

That last one is how you answer "was this ultimately a timeout?" without string-matching messages.

---

## 3. Custom error classes

```ts
export class AppError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly isOperational = true;

  constructor(message: string, opts: { code: string; statusCode?: number; cause?: unknown }) {
    super(message, { cause: opts.cause });
    this.name = new.target.name;          // ← subclasses get their own name, free
    this.code = opts.code;
    this.statusCode = opts.statusCode ?? 500;
    Error.captureStackTrace?.(this, new.target);
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id: string, cause?: unknown) {
    super(`${resource} ${id} not found`, { code: "NOT_FOUND", statusCode: 404, cause });
  }
}
```

`new.target.name` is the trick worth stealing: every subclass reports its own class name without repeating `this.name = "..."`.

### 3.1 Why `name` matters more than you'd think

```ts
err instanceof NotFoundError;   // ✓ works — inside one process
```

But `instanceof` **breaks across module boundaries** when two copies of a package are installed (module 01 §3.3), and across process/worker boundaries entirely. For anything that crosses a boundary, branch on a **string code**:

```ts ignore
if (err instanceof AppError && err.code === "NOT_FOUND") { ... }   // robust
```

This is exactly why Node's own `fs` errors carry `.code` (module 06 §8) rather than exposing error subclasses.

### 3.2 Don't subclass for everything

A hierarchy with forty error classes is worse than one class with a `code` field. Subclass when callers genuinely need to `catch` different types differently. Otherwise: one `AppError`, many codes.

---

## 4. Operational vs programmer errors

The distinction that determines whether you catch or crash:

| | Operational | Programmer |
|---|---|---|
| What | The world misbehaved | Your code is wrong |
| Examples | ECONNREFUSED, 404, timeout, invalid user input, disk full | `undefined is not a function`, a failed invariant, a bad type assertion |
| Response | Handle it: retry, fall back, return a 4xx/5xx | **Crash.** Log, flush, exit non-zero, let the supervisor restart |
| Predictable | Yes — you can enumerate them | No |

```ts
try {
  await chargeCard(order);
} catch (err) {
  if (err instanceof AppError && err.isOperational) {
    return res.status(err.statusCode).json({ code: err.code });
  }
  throw err;    // ← programmer error: do NOT swallow it
}
```

The failure mode to avoid is a blanket `catch (err) { logger.error(err); }` that swallows genuine bugs. A process running on broken invariants produces *wrong data*, which is far worse than a restart.

### 4.1 The last line of defence

```ts
process.on("uncaughtException", (err, origin) => {
  logger.fatal({ err, origin }, "uncaught exception");
  // Try to drain in-flight requests, but do not wait forever.
  server.close(() => process.exit(1));
  setTimeout(() => process.exit(1), 10_000).unref();
});

process.on("unhandledRejection", (reason) => {
  logger.fatal({ reason }, "unhandled rejection");
  process.exit(1);
});
```

**Log and die. Do not "recover."** After an uncaught exception, some function was interrupted halfway through — a lock is held, a transaction is open, a counter is half-incremented. You do not know which. Restarting is cheap; running on corrupt state is not.

(Since Node 15, unhandled rejections terminate the process by default, which is the right behaviour. Don't set `--unhandled-rejections=warn`.)

---

## 5. Async stack traces

Good news, then bad news.

**Across `await`, the stack survives:**

```
Error: from deep
    at deep (/app/x.ts:2:32)
    at viaAwait (/app/x.ts:6:3)       ← the async caller is there
    at async /app/x.ts:15:7
```

**Across a callback boundary, it does not:**

```
Error: from deep
    at deep (/app/x.ts:2:32)
    at Timeout._onTimeout (/app/x.ts:11:11)
    at listOnTimeout (node:internal/timers:585:17)   ← Node internals
    at process.processTimers (node:internal/timers:521:7)
```

The frames that scheduled the timer are gone. Same for `EventEmitter` callbacks, `setImmediate`, and any callback-based library.

**Practical consequences:**

- Prefer `async`/`await` over callbacks — you keep your stacks.
- When you must cross a callback boundary, capture context *at the boundary* and attach it with `cause`.
- Never `throw` a bare string or object. `throw "oops"` gives you no stack at all.

```ts
// ✗ no stack, no name, no cause
throw "user not found";

// ✓
throw new NotFoundError("user", id);
```

---

## 6. `AsyncLocalStorage` — context without plumbing

The problem: a request ID needs to appear in every log line, from the HTTP handler down through four layers to the database driver. Threading it through every signature is miserable.

```ts
import { AsyncLocalStorage } from "node:async_hooks";

const context = new AsyncLocalStorage<{ requestId: string; userId?: string }>();

// At the edge:
server.on("request", (req, res) => {
  context.run({ requestId: randomUUID() }, () => handler(req, res));
});

// Anywhere, at any depth, with no parameter passing:
function log(msg: string) {
  console.log(JSON.stringify({ msg, requestId: context.getStore()?.requestId }));
}
```

### 6.1 It survives everything async

```ts ignore
await context.run({ requestId: "req-1" }, async () => {
  context.getStore()?.requestId;        // "req-1"
  await sleep(10);
  context.getStore()?.requestId;        // "req-1"  ← survives await
  await Promise.all([...]);             // "req-1"  ← survives Promise.all
  setTimeout(() => context.getStore()?.requestId, 5);  // "req-1"  ← survives timers
});
context.getStore();                     // undefined  ← correctly scoped
```

That's `async_hooks` propagating the context along the async resource graph. It is not a global variable — two concurrent requests each see their own store.

### 6.2 The `EventEmitter` gotcha

A listener sees the context **where the event was emitted**, not where it was registered:

```ts
await context.run({ id: "register-ctx" }, async () => {
  bus.on("go", () => console.log(context.getStore()?.id));
});

await context.run({ id: "emit-ctx" }, async () => bus.emit("go"));
// prints "emit-ctx"    ← NOT "register-ctx"

bus.emit("go");
// prints undefined     ← no context at all
```

This is usually backwards from what you want: a listener registered during request A should log with A's ID. Fix it by binding at registration:

```ts
import { AsyncResource } from "node:async_hooks";

bus.on("go", AsyncResource.bind(() => console.log(context.getStore()?.id)));
// now always prints "register-ctx", whoever emits
```

`AsyncLocalStorage.snapshot()` (Node 20+) does the same for a plain function:

```ts
const snapshot = AsyncLocalStorage.snapshot();   // capture current context
queue.push(() => snapshot(() => doWorkWithContext()));
```

### 6.3 Other pitfalls

- **`enterWith()` has no scope.** It mutates the *current* async context and everything downstream of it, with no exit. Use `run()` unless you're adapting legacy middleware, and even then, know that you can leak context into unrelated work.
- **Pooled resources lose it.** A connection pool creates its sockets once, at startup. Callbacks fired by those sockets run in the pool's context, not the request's. Capture and re-enter explicitly.
- **Performance is not free.** Modern Node has made it much cheaper, but on a very hot path measure before adopting it broadly.
- **Don't put mutable state in it.** Treat the store as immutable request metadata (IDs, user, locale). If you need mutation, mutate a field of the object, and know that every downstream call sees it.

---

## 7. Structured logging

```ts
// ✗ unparseable, ungreppable, context-free
console.log("User " + id + " failed: " + err.message);

// ✓ one JSON object per line
logger.error({ err, userId: id, requestId: ctx.requestId }, "checkout failed");
```

The rules that matter:

1. **One JSON object per line.** Log aggregators parse it; humans can still read it with `| jq`.
2. **Message is a constant string.** Put the variables in fields — otherwise you can't group by message.
3. **Serialise errors properly** (§1.1), including the `cause` chain.
4. **Never log secrets.** Tokens, passwords, full card numbers, session cookies. Redact at the serialiser, not at each call site.
5. **Correlation ID on every line**, from `AsyncLocalStorage`.

`pino` is the standard choice in Node — it's fast, has error and redaction serialisers built in, and writes NDJSON.

---

## 8. Diagnostics tooling

### 8.1 `diagnostics_channel`

A zero-overhead-when-unsubscribed pub/sub built into Node. Libraries publish; observers subscribe.

```ts
import dc from "node:diagnostics_channel";

const channel = dc.channel("app:query");
if (channel.hasSubscribers) channel.publish({ sql, durationMs });   // cheap guard
```

```ts
dc.subscribe("app:query", (msg) => metrics.histogram("db.query", msg.durationMs));
```

`tracingChannel` (Node 19.9+) wraps an operation and emits start/end/error/asyncStart/asyncEnd:

```ts
const trace = dc.tracingChannel("app:handler");
trace.subscribe({
  start: (msg) => { msg.startTime = performance.now(); },
  end:   (msg) => metrics.timing("handler", performance.now() - msg.startTime),
  error: (msg) => metrics.increment("handler.error"),
});

await trace.tracePromise(() => handler(req), { route });
```

Node core publishes its own channels (`http.client.request.start`, `net.client.socket`, …), which is how APM agents instrument without monkey-patching.

### 8.2 `perf_hooks`

```ts
import { performance, PerformanceObserver, monitorEventLoopDelay } from "node:perf_hooks";

performance.mark("start");
await work();
performance.mark("end");
performance.measure("work", "start", "end");

new PerformanceObserver((list) => {
  for (const e of list.getEntries()) console.log(e.name, e.duration);
}).observe({ entryTypes: ["measure"] });
```

Plus the event-loop histogram from module 02 §6.2.

### 8.3 Profiling

```bash
node --cpu-prof app.ts               # → .cpuprofile, open in Chrome DevTools
node --heap-prof app.ts              # → .heapprofile (allocation sampling)
node --inspect app.ts                # attach DevTools to a live process
node --trace-sync-io app.ts          # warn on sync I/O after the first tick
node --trace-warnings app.ts         # stack traces for process warnings
```

### 8.4 `process.report`

A JSON dump of the whole process: stacks, heap, handles, resource limits, environment.

```bash
node --report-on-signal app.ts       # then: kill -USR2 <pid>
node --report-uncaught-exception app.ts
```

```ts
const report = process.report.getReport();
report.libuv.filter((h) => h.type === "file").length;   // open file handles → fd leaks
```

### 8.5 What to reach for

| Symptom | Tool |
|---|---|
| High CPU | `--cpu-prof`, then the flame chart |
| Growing RSS | two heap snapshots via `--inspect`, diff them |
| High p99, low CPU | event-loop lag histogram (module 02 §6.2) |
| `EMFILE` after hours | `process.report` libuv handles; `lsof -p` |
| "Which query was slow?" | `diagnostics_channel` + a histogram |
| Hung process | `kill -USR2` with `--report-on-signal` |

---

## 9. Files in this module

| File | What it demonstrates |
|---|---|
| `01-errors.ts` | anatomy, non-enumerable props, serialisation, `cause` chains, custom classes |
| `02-async-stacks.ts` | what survives `await` vs a callback; `stackTraceLimit`; `captureStackTrace` |
| `03-strategy.ts` | operational vs programmer errors, crash handling, retry with backoff |
| `04-async-context.ts` | `AsyncLocalStorage`, the EventEmitter trap, `AsyncResource.bind`, `snapshot` |
| `05-diagnostics.ts` | `diagnostics_channel`, `tracingChannel`, `perf_hooks`, `process.report` |
| `06-logging.ts` | structured logs, error serialisers, redaction, correlation IDs |
| `exercise.ts` | an `AppError` hierarchy, cause utilities, `withRetry`, a `RequestContext` |

```bash
node src/07-errors-diagnostics/index.ts
node scripts/test.ts 07
node scripts/test.ts --solutions 07
```

---

## 10. Check yourself

1. `JSON.stringify(err)` gives `{}`. Why, and what do you do about it?
2. You rewrap an error with a friendlier message. What do you lose if you don't pass `cause`?
3. Why does `err instanceof MyError` sometimes fail for an error that clearly is one?
4. Which of these do you catch, and which do you crash on: `ECONNREFUSED`, `undefined is not a function`, a 404 from an upstream API, a failed assertion?
5. A stack trace ends at `Timeout._onTimeout`. What happened, and how do you get more?
6. A listener registered during request A logs request B's ID. Why, and what's the fix?
7. When would you use `enterWith()` instead of `run()`?
8. Your p99 is 800ms but CPU is at 12%. Which tool do you open first?
