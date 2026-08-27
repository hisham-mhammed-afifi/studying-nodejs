# 03 — EventEmitter

`EventEmitter` is the substrate almost every Node core API is built on: streams, HTTP servers and requests, sockets, child processes, `process` itself. Understanding it once explains a dozen APIs at a stroke.

---

## 1. The model

An emitter holds a map of `eventName → listener[]`. `emit(name, ...args)` walks that array and calls each listener **synchronously, in registration order, on the caller's stack**. There is no queue, no scheduling, no async.

```ts
import { EventEmitter } from "node:events";

const bus = new EventEmitter();
bus.on("x", () => console.log("listener"));

console.log("before");
bus.emit("x");
console.log("after");

// before
// listener
// after        ← no "later", ever
```

That synchronicity is the single most misunderstood thing about it. Consequences:

- If a listener blocks, `emit` blocks.
- If a listener throws, `emit` throws — to the *emitter's* caller.
- `emit` returns before any `async` listener has finished.

### 1.1 Registration order, and jumping the queue

```ts
bus.on("x", () => console.log("second"));
bus.prependListener("x", () => console.log("first"));
bus.on("x", () => console.log("third"));
bus.emit("x");
// first / second / third
```

`prependListener` exists for interceptors and instrumentation that must observe an event before application handlers can mutate anything.

### 1.2 `emit` tells you if anyone was listening

```ts
bus.emit("nobody-home");        // false — no listeners
bus.on("hello", () => {});
bus.emit("hello");              // true
```

Useful for "log it if nothing handled it" fallbacks. It says nothing about whether the listeners *succeeded*.

### 1.3 `once` removes itself **before** running

```ts
const bus = new EventEmitter();
bus.once("boot", () => {
  console.log(bus.listenerCount("boot"));   // 0 — already removed
  bus.emit("boot");                          // does NOT re-enter this handler
});
bus.emit("boot");
```

Deliberate design: it prevents a whole class of accidental infinite recursion.

### 1.4 Removal is by function **identity**

```ts
bus.on("tick", () => console.log("hi"));
bus.off("tick", () => console.log("hi"));   // ✗ a DIFFERENT function object
bus.listenerCount("tick");                   // 1 — nothing was removed

const handler = () => console.log("hi");
bus.on("tick", handler);
bus.off("tick", handler);                    // ✓ same reference
bus.listenerCount("tick");                   // 0
```

The classic trap is `bind`, which creates a new function every call:

```ts
// ✗ can never be removed
emitter.on("data", this.handle.bind(this));
emitter.off("data", this.handle.bind(this));   // different object!

// ✓ bind once, store it
this.boundHandle = this.handle.bind(this);
emitter.on("data", this.boundHandle);
emitter.off("data", this.boundHandle);
```

### 1.5 API surface

| Method | Notes |
|---|---|
| `on` / `addListener` | append a listener |
| `once` | append a self-removing listener |
| `prependListener` / `prependOnceListener` | put it at the **front** |
| `off` / `removeListener` | remove by function identity |
| `removeAllListeners([name])` | nuclear; **without a name it also kills your `error` handler** |
| `emit(name, ...args)` | returns `true` if ≥1 listener ran |
| `listenerCount(name)` / `eventNames()` | introspection |
| `listeners(name)` / `rawListeners(name)` | `raw` gives you the `once` **wrapper**, not the original |
| `setMaxListeners(n)` | raise the leak-warning threshold (default 10) |

Static helpers on the class — this is where the real ergonomics live:

```ts
import { once, on, getEventListeners } from "node:events";

const [arg1, arg2] = await once(emitter, "ready", { signal });   // Promise
for await (const [arg] of on(emitter, "tick", { signal })) { }   // async iterator
getEventListeners(emitter, "data");                              // introspection
```

---

## 2. The `error` event will crash your process

This is special-cased in Node. If you `emit("error", err)` and there is **no** `error` listener, Node throws it as an uncaught exception:

```ts
const e = new EventEmitter();
e.emit("error", new Error("boom"));
// ✗ process dies here with a stack trace and a non-zero exit code
```

Every other event name with no listeners is a silent no-op. `error` is the one exception — and it's why "our server randomly restarts" is so often an unhandled socket error.

```ts
// ✓ attach one at construction time, before anything can fail
const e = new EventEmitter();
e.on("error", (err) => logger.error({ err }));
e.emit("error", new Error("boom"));   // handled; process survives
```

Attach it to **every long-lived emitter**:

```ts
const server = http.createServer(handler);
server.on("error", (err) => { logger.fatal({ err }); process.exitCode = 1; });
server.on("clientError", (err, socket) => socket.destroy());

socket.on("error", (err) => logger.warn({ err }, "socket error"));
child.on("error", (err) => logger.error({ err }, "spawn failed"));
readStream.on("error", (err) => logger.error({ err }));
```

### 2.1 A throwing listener aborts the remaining listeners

```ts
bus.on("go", () => { throw new Error("boom"); });
bus.on("go", () => console.log("never runs"));

try {
  bus.emit("go");
} catch (err) {
  console.log("caught at the emit() call site:", err.message);
}
```

Because dispatch is synchronous, the exception propagates up the **caller's** stack — and it silently disables every subscriber registered after the bad one. (The exercise has you build a bus that isolates listeners instead.)

---

## 3. Async listeners are not awaited

```ts
bus.on("save", async () => { await db.write(); });
bus.emit("save");
// returns IMMEDIATELY. The write is still in flight. You get no completion
// signal, no ordering guarantee, and no error propagation.
```

An exception inside becomes an **unhandled rejection**, which by default kills the process:

```ts
bus.on("go", async () => { throw new Error("async boom"); });
bus.emit("go");
// ✗ process exits — and the stack trace points nowhere useful
```

### 3.1 `captureRejections` routes them to `error`

```ts
const bus = new EventEmitter({ captureRejections: true });
bus.on("error", (err) => logger.error({ err }));
bus.on("go", async () => { throw new Error("async boom"); });
bus.emit("go");
// → arrives at your existing 'error' handler ✓
```

Or flip the default process-wide, before creating any emitters:

```ts
EventEmitter.captureRejections = true;
```

This is cheap insurance. It does **not** make `emit()` wait for the listeners.

### 3.2 If you need to await handlers, don't use an emitter

```ts
// ✗ the emitter cannot do this
bus.emit("beforeSave");
await ???

// ✓ an explicit array of async functions
const hooks: Array<() => Promise<void>> = [];
hooks.push(async () => { await validate(); });
hooks.push(async () => { await audit(); });

await Promise.all(hooks.map((h) => h()));      // parallel
for (const h of hooks) await h();              // sequential
```

Typed, awaited, and errors propagate. Emitters are for fire-and-forget notification.

---

## 4. Typing it in TypeScript

The built-in signatures are `on(event: string | symbol, listener: (...args: any[]) => void)`. Every event name is valid and every payload is `any` — you lose everything TypeScript is for:

```ts
const bus = new EventEmitter();
bus.on("user:created", (id: number) => console.log(id + 1));

bus.emit("user:crated", 1);              // ✗ typo → silently never fires
bus.emit("user:created", "not-a-number");// ✗ "1not-a-number" at runtime
bus.emit("user:created");                // ✗ NaN
// All three COMPILE.
```

### 4.1 A generic typed wrapper

```ts
type EventMap = Record<string, unknown[]>;

class TypedEmitter<E extends EventMap> {
  readonly #inner = new EventEmitter({ captureRejections: true });

  on<K extends keyof E & string>(event: K, listener: (...args: E[K]) => void): this {
    this.#inner.on(event, listener as (...args: unknown[]) => void);
    return this;
  }

  emit<K extends keyof E & string>(event: K, ...args: E[K]): boolean {
    return this.#inner.emit(event, ...args);
  }
}
```

Define the events as a map of **argument tuples**:

```ts
type JobEvents = {
  progress: [percent: number, label: string];   // labelled tuple → nice tooltips
  done: [result: { rows: number }];
  failed: [error: Error];
  cancelled: [];                                // zero-arg = empty tuple
};

const jobs = new TypedEmitter<JobEvents>();

jobs.on("progress", (percent, label) => {       // types INFERRED, no annotations
  console.log(`${label}: ${percent.toFixed(0)}%`);
});

jobs.emit("progress", 42.5, "extracting");      // ✓
jobs.emit("progres", 50, "typo");               // ✗ not assignable to keyof JobEvents
jobs.emit("progress", "50", "wrong");           // ✗ string not assignable to number
jobs.emit("progress", 50);                      // ✗ expected 2 arguments, got 1
jobs.emit("done", { rows: "many" });            // ✗ string not assignable to number
```

Zero runtime cost — the generics all erase.

> ⚠ **TypeScript gotcha:** use `type JobEvents = { … }`, not `interface`. A type alias gets an implicit index signature and satisfies `Record<string, unknown[]>`; an interface does not, and you get *"Index signature for type 'string' is missing"*. If you want an interface, declare it as `interface JobEvents extends EventMap`.

### 4.2 When not to use an emitter at all

For a **fixed, known** set of callbacks, a plain object is simpler, type-safe for free, and forces you to handle errors:

```ts
// Instead of an emitter with three events:
interface Handlers {
  onData(chunk: Buffer): void;
  onEnd(): void;
  onError(err: Error): void;
}

function process(input: Readable, handlers: Handlers) { /* … */ }
```

Emitters earn their keep when there are genuinely **N unknown subscribers**, or when you're implementing a Node-shaped API that people expect to be event-based.

Node core's own emitters *do* ship typed overloads via `@types/node`, so `socket.on("data", chunk => …)` already autocompletes. You only need this pattern for your own emitters.

---

## 5. Bridging events into `async`/`await`

### 5.1 `events.once` → a Promise for the next emission

```ts
import { once } from "node:events";

setTimeout(() => bus.emit("ready", "payload", 42), 20);
const [msg, n] = await once(bus, "ready");   // resolves with the ARGUMENT ARRAY
```

It **rejects if the emitter emits `error`** — which maps the emitter's two-channel model onto the promise's two channels, giving you `try`/`catch` for free:

```ts
setTimeout(() => bus.emit("error", new Error("connection refused")), 20);
try {
  await once(bus, "ready");
} catch (err) {
  console.log(err.message);   // "connection refused"
}
```

(Exception: `await once(emitter, "error")` *resolves* with the error rather than rejecting. Waiting for `error` is legitimate, so it isn't special-cased there.)

### 5.2 Always give it an escape hatch

Without a signal, an event that never fires hangs you **and** leaks a listener on every call:

```ts
// ✗ hangs forever, leaks a listener
await once(bus, "ready");

// ✓ bounded, and the signal cleans up the listener
await once(bus, "ready", { signal: AbortSignal.timeout(30) });
// → rejects; bus.listenerCount("ready") is back to 0
```

⚠ **The rejection is not the signal's reason.** `events.once` wraps it:

```ts
try {
  await once(bus, "ready", { signal: AbortSignal.timeout(30) });
} catch (err) {
  err.name;          // "AbortError"    ← NOT "TimeoutError"
  err.code;          // "ABORT_ERR"
  err.cause.name;    // "TimeoutError"  ← the original is on .cause
  err.cause.message; // "The operation was aborted due to timeout"
}
```

So `if (err.name === "TimeoutError")` silently never matches. Check `err.cause?.name`, or distinguish timeout from user-cancel by comparing against your own controller's signal.

Compose several reasons to stop:

```ts
const userCancel = new AbortController();
req.on("close", () => userCancel.abort(new Error("client disconnected")));

const signal = AbortSignal.any([userCancel.signal, AbortSignal.timeout(5000)]);
await once(bus, "ready", { signal });
```

> ⚠ `AbortSignal.timeout()`'s internal timer is **unref'd** — it will not keep the process alive. Fine in a server that has other work; in a script it can make Node exit early, or die with *"Promise resolution is still pending"* (exit code 13).

### 5.3 `events.on` → an async iterator

```ts
import { on } from "node:events";

const ac = new AbortController();
try {
  for await (const [n] of on(bus, "tick", { signal: ac.signal })) {
    console.log("tick", n);
  }
} catch (err) {
  if (err.name !== "AbortError") throw err;
}
```

⚠ **It buffers, unboundedly.** Emissions that arrive while your loop body is busy queue up in an array that grows until you run out of memory. The emitter has no backpressure mechanism to push back with.

Use it for low-rate control events. For high-rate data, use a Readable stream (module 05), which has backpressure built in.

### 5.4 Racing sources — and cleaning up the losers

```ts
const ac = new AbortController();

const [winner] = await Promise.race([
  once(primary,  "data", { signal: ac.signal }),
  once(fallback, "data", { signal: ac.signal }),
]);

ac.abort();   // ← THE IMPORTANT LINE
```

`Promise.race` settles, but the losing promises stay **pending** and their listeners stay **attached** — forever, on a long-lived emitter. This is the number-one leak in "race with timeout" code.

### 5.5 Wrapping an event API end to end

```ts
async function connectWithTimeout(conn: Connection, ms: number): Promise<void> {
  conn.connect();
  try {
    await once(conn, "connect", { signal: AbortSignal.timeout(ms) });
  } catch (err) {
    // Check the CAUSE — see the warning in §5.2.
    const cause = (err as Error & { cause?: Error }).cause;
    if (cause?.name === "TimeoutError") {
      throw new Error(`connect timed out after ${ms}ms`, { cause: err });
    }
    throw err;
  }
}
```

`{ cause }` preserves the original error — always use it when rewrapping. Here it chains three deep: your `Error` → the `AbortError` → the `TimeoutError`.

---

## 6. Memory leaks

### 6.1 The warning

Node prints `MaxListenersExceededWarning` when a single event on a single emitter has more than **10** listeners:

```
(node:1234) MaxListenersExceededWarning: Possible EventEmitter memory leak
detected. 11 data listeners added to [EventEmitter]. MaxListeners is 10.
```

It's a heuristic, not an error, and it's usually right. Don't filter it out — surface it:

```ts
process.on("warning", (w) => logger.warn({ name: w.name, message: w.message }));
```

Raise the limit only when the listeners are genuinely supposed to be there:

```ts
hub.setMaxListeners(50);              // per emitter
EventEmitter.defaultMaxListeners = 20; // global; blunt instrument
hub.setMaxListeners(0);                // disable the check — hides real leaks
```

### 6.2 The classic leak

```ts
const appBus = new EventEmitter();   // long-lived, app-scoped

function handleRequest(req: Request) {
  appBus.on("config:changed", () => reloadFor(req));   // ✗ never removed
}
```

After 1,000 requests: 1,000 listeners, each closure pinning its captured scope. On a real server this is steadily rising RSS and, hours later, an OOM kill. The listener array also makes every subsequent `emit` linearly slower.

### 6.3 Fix A — `once`

```ts
bus.once("ready", () => {});   // self-removes after firing
```

**But** a `once` listener for an event that never fires is *still* a leak. It sits there forever. `once` only helps when the event is guaranteed to arrive — and "guaranteed" rarely survives contact with the network.

### 6.4 Fix B — `AbortSignal`

⚠ **A trap worth memorising first:** `emitter.on(name, fn, { signal })` does **not** work.

```ts
const ac = new AbortController();
bus.on("x", fn, { signal: ac.signal });   // the third argument is IGNORED
ac.abort();
bus.listenerCount("x");                    // 1. Still there. It compiles, runs, and leaks.
```

`EventEmitter#on` takes exactly two arguments. Only the **static** helpers `events.once()` and `events.on()` accept a signal. (`EventTarget.addEventListener` *does* support it natively — that's where the intuition comes from.)

So write the four-line helper:

```ts
function onWithSignal(
  emitter: EventEmitter,
  event: string,
  listener: (...args: any[]) => void,
  signal: AbortSignal,
): void {
  if (signal.aborted) return;   // never subscribe to an already-cancelled scope
  emitter.on(event, listener);
  signal.addEventListener("abort", () => emitter.off(event, listener), { once: true });
}
```

Then teardown is one call, for every listener, across every emitter:

```ts
function handleRequest(req: Request) {
  const ac = new AbortController();
  req.on("close", () => ac.abort());     // client hung up

  onWithSignal(appBus, "config:changed", () => reloadFor(req), ac.signal);
  onWithSignal(appBus, "shutdown",       () => drain(req),     ac.signal);

  try { /* … work using ac.signal … */ } finally { ac.abort(); }
}
```

Why this beats remembering to `off()` each listener:

- **One** `abort()` tears down everything registered with that signal — no matching pairs to keep in sync.
- It **composes**: pass the same signal to `fetch()`, `fs` reads, and `setTimeout` from `node:timers/promises`, and they all cancel together.
- It **survives refactors**. A new `onWithSignal(...)` is cleaned up by construction; a new bare `bus.on(...)` is a leak you have to notice.

Exercise 03 has you build a bus with `{ signal }` support baked in, so the helper becomes unnecessary.

### 6.5 Finding leaks

```ts
import { getEventListeners } from "node:events";

getEventListeners(bus, "data").length;                    // 3
getEventListeners(bus, "data").map((f) => f.name);        // ["handleA", "", "onData"]
bus.eventNames();                                         // ["data", "error"]
```

In tests, assert that teardown actually happened — a cheap, effective regression guard:

```ts
afterEach(() => assert.equal(bus.listenerCount("data"), 0));
```

In production:

```bash
node --inspect app.ts                        # DevTools → Memory → two snapshots, diff them
node --heapsnapshot-signal=SIGUSR2 app.ts    # dump from a live process
kill -USR2 <pid>
```

Rising RSS with flat traffic, and a heap diff showing growing arrays of closures, points straight at an emitter.

---

## 7. `EventTarget` — the web-standard alternative

Node also ships the DOM's `EventTarget`, `CustomEvent`, and `AbortSignal`.

```ts
const target = new EventTarget();
const ac = new AbortController();

target.addEventListener("ping", (e) => {
  console.log((e as CustomEvent).detail);   // payload lives in .detail
}, { signal: ac.signal, once: false });     // ← signal support is native here

target.dispatchEvent(new CustomEvent("ping", { detail: { n: 1 } }));
ac.abort();
target.dispatchEvent(new CustomEvent("ping", { detail: { n: 2 } }));   // nothing
```

| | `EventEmitter` | `EventTarget` |
|---|---|---|
| Payload | N positional arguments | one `Event` object (`.detail`) |
| A listener throws | **aborts** the remaining listeners | others still run; becomes an uncaught exception |
| `error` event | special-cased, crashes if unhandled | no special case |
| `{ signal }` on subscribe | ✗ not supported | ✓ native |
| `once` / `prepend` / `listenerCount` | ✓ | `once` only; introspection is worse |
| Portability | Node-only | web standard — works in browsers and workers |

**Rule:** `EventEmitter` for Node-shaped APIs, `EventTarget`/`AbortSignal` for anything crossing into web-standard territory or shared with browser code.

---

## 8. Composition beats inheritance

`class X extends EventEmitter` is idiomatic Node, but it leaks the whole emitter API to your callers — `emit`, `removeAllListeners`, `setMaxListeners`. Anyone can forge your events or wipe your `error` handler. Holding one privately is safer, and gives you typed subscription for free:

```ts
class Job {
  readonly #bus = new EventEmitter();

  on(event: "done", fn: (ms: number) => void): this {
    this.#bus.on(event, fn);
    return this;
  }

  run(): void {
    const t0 = performance.now();
    // ...work...
    this.#bus.emit("done", performance.now() - t0);
  }
}

new Job().on("done", (ms) => console.log(`done in ${ms.toFixed(1)}ms`)).run();
// Callers can subscribe. They cannot emit.
```

---

## 9. Files in this module

| File | What it demonstrates |
|---|---|
| `01-basics.ts` | synchronous dispatch, ordering, `once`, removal by identity, composition |
| `02-errors.ts` | the `error` crash (shown in a child process), `captureRejections`, async listeners |
| `03-typed-emitter.ts` | a fully typed generic emitter with `waitFor` |
| `04-async-bridge.ts` | `events.once`, `events.on`, `AbortSignal`, racing, timeouts |
| `05-leaks.ts` | the max-listeners warning, the `{ signal }` trap, `EventTarget` |
| `exercise.ts` | build `TypedBus` + `waitFor` + `waitForAny` + `pipe` |

```bash
node src/03-event-emitter/index.ts        # all five demos
node scripts/test.ts 03                   # test your exercise
node scripts/test.ts --solutions 03
```

---

## 10. Check yourself

1. `emitter.emit("x")` and a listener throws — where does the exception surface, and what happens to the other listeners?
2. Why does `emitter.off("x", () => {})` never remove anything?
3. You add a `once` listener for an event that never fires. Is that a leak?
4. A listener is `async` and rejects. What happens by default, and how do you make it visible?
5. `bus.on("x", fn, { signal })` — what does the third argument actually do?
6. After `Promise.race([once(a, "x"), once(b, "x")])` resolves, what is still attached?
7. When would you reach for `EventTarget` over `EventEmitter`?
8. Why does `type JobEvents = {…}` satisfy `Record<string, unknown[]>` when `interface JobEvents {…}` doesn't?
