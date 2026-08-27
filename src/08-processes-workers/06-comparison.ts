/**
 * 06 — What each mechanism actually costs
 *
 * Run:  node src/08-processes-workers/06-comparison.ts
 */

import { Worker } from "node:worker_threads";
import { spawn, fork } from "node:child_process";
import { once } from "node:events";
import { availableParallelism } from "node:os";
import path from "node:path";

const row = (label: string, value: string) => console.log(`  ${label.padEnd(34)} ${value.padStart(10)}`);

console.log("=== 1. Startup cost ===\n");
{
  // Worker thread: new V8 isolate in the same process.
  const t0 = performance.now();
  const w = new Worker("require('node:worker_threads').parentPort.postMessage('up');", { eval: true });
  await once(w, "message");
  const workerMs = performance.now() - t0;
  await w.terminate();
  row("worker thread", `${workerMs.toFixed(1)}ms`);

  // Child process: a whole new Node process.
  const t1 = performance.now();
  const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
  await once(child, "exit");
  const childMs = performance.now() - t1;
  row("child process (spawn node)", `${childMs.toFixed(1)}ms`);

  // fork(): same, plus an IPC channel.
  const t2 = performance.now();
  const forked = fork(path.join(import.meta.dirname, "_child.ts"), [], { silent: true });
  forked.send({ job: "square", n: 2 });
  await once(forked, "message");
  const forkMs = performance.now() - t2;
  forked.kill();
  row("fork() + first message", `${forkMs.toFixed(1)}ms`);

  row("a plain function call", "~0ms");

  console.log(`
  Both are expensive to CREATE and cheap to REUSE. That single fact is why
  every real system pools them. Below a few hundred milliseconds of work per
  task, startup dominates everything else you measure.
`);
}

console.log("=== 2. Round-trip message cost ===\n");
{
  const N = 200;

  // Worker thread, small message.
  const w = new Worker("const {parentPort}=require('node:worker_threads'); parentPort.on('message',(m)=>parentPort.postMessage(m));", {
    eval: true,
  });
  const t0 = performance.now();
  for (let i = 0; i < N; i++) {
    const done = once(w, "message");
    w.postMessage({ i });
    await done;
  }
  row(`worker thread × ${N} small msgs`, `${((performance.now() - t0) / N).toFixed(3)}ms ea`);
  await w.terminate();

  // Child process over the IPC channel (JSON).
  const c = fork(path.join(import.meta.dirname, "_child.ts"), [], { silent: true });
  const t1 = performance.now();
  for (let i = 0; i < N; i++) {
    const done = once(c, "message");
    c.send({ job: "square", n: i });
    await done;
  }
  row(`child process × ${N} small msgs`, `${((performance.now() - t1) / N).toFixed(3)}ms ea`);
  c.kill();
  await once(c, "exit");

  console.log(`
  Both are sub-millisecond for small payloads, so per-message overhead is
  rarely the problem. Payload SIZE is — see 03-messaging.ts, where 32MB
  costs 34ms cloned, 3ms transferred, and 0.2ms shared.
`);
}

console.log("=== 3. The decision table ===");
console.log(`
                      child_process      worker_threads     cluster
  ─────────────────────────────────────────────────────────────────────────
  unit                a process          a thread           N processes
  runs                any program        JavaScript only    your app, N times
  memory              isolated           isolated heaps,    isolated
                                         + SharedArrayBuffer
  communication       pipes / JSON IPC   structured clone,  JSON IPC
                                         transfer, shared
  a crash takes down  just that process  THE WHOLE PROCESS  just that worker
  good for            ffmpeg, git,       CPU-bound JS:      scaling one HTTP
                      python, any CLI    parse, hash,       server across
                                         image, compress    cores

  Note the "a crash takes down" row. An uncaught error inside a worker
  surfaces as an 'error' event, not a crash (02-worker-basics.ts §5) — but a
  worker that calls process.exit() or runs out of memory takes the ENTIRE
  process with it, main thread included. Child processes cannot do that.
  If you're running genuinely untrusted or crash-prone code, use a process.
`);

console.log("=== 4. The decision tree ===");
console.log(`
  Is it an external program?               → child_process (spawn/execFile)
  Is it CPU-bound JavaScript?              → worker_threads, in a POOL
  Do you need N copies of an HTTP server?  → cluster… or just N containers
  Is it I/O-bound?                         → none of these

  That last line is the one people get wrong. Network and file I/O are
  already concurrent (module 02 §5). Wrapping a database call in a worker
  adds a thread, a message round trip, and a clone — and removes nothing,
  because the main thread was never busy waiting in the first place.

  Before adding any of this, ask:
    1. Is the main thread actually blocked?   → measure loop lag (module 02)
    2. Can I make the work cheaper instead?   → better algorithm, or SQL
    3. Is the work bigger than the data?      → if not, do it inline
`);

console.log("=== 5. This machine ===");
row("availableParallelism()", String(availableParallelism()));
row("recommended pool size", String(Math.max(1, availableParallelism() - 1)));
console.log(`
  ⚠ availableParallelism() reports the HOST's cores. Inside a container with
  a CPU limit it does NOT reflect your quota, so always allow an override:

      const size = Number(process.env.POOL_SIZE) ||
                   Math.max(1, availableParallelism() - 1);
`);
