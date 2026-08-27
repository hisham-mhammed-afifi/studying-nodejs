/**
 * 05 — The libuv thread pool
 *
 * Run:  node src/02-event-loop/05-threadpool.ts
 * Then: UV_THREADPOOL_SIZE=8 node src/02-event-loop/05-threadpool.ts
 *
 * Compare the two outputs. The staircase should change shape.
 */

import { pbkdf2 } from "node:crypto";
import { readFile } from "node:fs/promises";
import { lookup } from "node:dns/promises";

const POOL = Number(process.env["UV_THREADPOOL_SIZE"] ?? 4);
console.log(`UV_THREADPOOL_SIZE = ${POOL} (default is 4)\n`);

console.log(`=== What uses the pool, and what doesn't ===

  ON THE POOL (blocking work faked as async by 4 background threads):
    fs.*            every filesystem call — the OS has no good async file API
    crypto.pbkdf2 / randomBytes / scrypt
    zlib.*          gzip, brotli
    dns.lookup      because it calls getaddrinfo(3), which is blocking

  NOT ON THE POOL (genuinely async, kernel-level readiness notification):
    net / http / https / tls sockets     epoll / kqueue / IOCP
    dns.resolve4, dns.resolveMx, ...     real async DNS protocol
    child_process, worker_threads        separate processes / threads

  Consequence: 10,000 concurrent HTTP requests are cheap. 10 concurrent
  pbkdf2 calls are not — they queue 4-at-a-time and they also delay every
  fs operation in the process, because they share the same 4 threads.
`);

console.log("=== Watch the pool saturate ===");
console.log("8 identical pbkdf2 jobs, launched simultaneously:\n");

const t0 = performance.now();
const jobs = Array.from({ length: 8 }, (_, i) => i);

await Promise.all(
  jobs.map(
    (i) =>
      new Promise<void>((resolve, reject) => {
        // ~150ms of CPU each, on a pool thread.
        pbkdf2("password", `salt-${i}`, 300_000, 64, "sha512", (err) => {
          if (err) return reject(err);
          const elapsed = performance.now() - t0;
          const bar = "█".repeat(Math.round(elapsed / 20));
          console.log(`  job ${i}: ${elapsed.toFixed(0).padStart(5)}ms ${bar}`);
          resolve();
        });
      }),
  ),
);

console.log(`
  With the default pool of 4 you get a STAIRCASE: jobs 0-3 finish together,
  then jobs 4-7 finish together at roughly double the time. The last job's
  latency is 2x the first's, even though the work is identical.

  Re-run with UV_THREADPOOL_SIZE=8 and they all finish at once — until you
  run out of physical cores, at which point you're just oversubscribing.
`);

console.log("=== The cross-contamination problem ===");
{
  // Baseline: how fast is a file read when the pool is idle?
  const a = performance.now();
  await readFile(import.meta.filename);
  const idleMs = performance.now() - a;

  // Now saturate the pool and read the same file again.
  const hogs = Array.from(
    { length: POOL },
    (_, i) =>
      new Promise<void>((resolve) => {
        pbkdf2("password", `hog-${i}`, 400_000, 64, "sha512", () => resolve());
      }),
  );
  const b = performance.now();
  const contended = readFile(import.meta.filename).then(() => performance.now() - b);
  await Promise.all(hogs);
  const contendedMs = await contended;

  console.log(`  readFile with pool idle:      ${idleMs.toFixed(1)}ms`);
  console.log(`  readFile with pool saturated: ${contendedMs.toFixed(1)}ms`);
  console.log(`
  A trivial file read got slower by an order of magnitude, and NOTHING about
  the file changed. This is the failure mode that looks like "our disk is
  slow" when the real cause is password hashing on the same 4 threads.
`);
}

console.log("=== dns.lookup vs dns.resolve ===");
try {
  const t = performance.now();
  const r = await lookup("localhost");
  console.log(`  dns.lookup("localhost") → ${r.address} in ${(performance.now() - t).toFixed(1)}ms  (POOL THREAD)`);
} catch {
  console.log("  dns.lookup skipped (no resolver in this environment)");
}
console.log(`
  Every outgoing http.request() calls dns.lookup under the hood. On a service
  that fans out to many hosts, DNS alone can occupy the pool. Mitigations:
  raise UV_THREADPOOL_SIZE, enable an HTTP agent with keepAlive (fewer
  lookups), or plug in a userland DNS cache.
`);

console.log(`=== Tuning ===

  UV_THREADPOOL_SIZE must be set BEFORE the pool is created — i.e. as an env
  var at launch, not with process.env in your code (the first pool use wins,
  and you rarely control when that is).

      UV_THREADPOOL_SIZE=16 node app.ts

  Max is 1024. Sensible values: number of cores for CPU-bound pool work, or
  higher (32-128) for fs/DNS-heavy services where the threads mostly wait.
  It is not free — each thread has a stack. Measure before and after.

  And note the pool does NOT help with JavaScript CPU work. Your JS still runs
  on one thread. For that you need worker_threads (module 08).
`);
