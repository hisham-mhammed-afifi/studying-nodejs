/**
 * 01 — Three fs APIs, and what sync actually costs
 *
 * Run:  node src/06-filesystem/01-apis.ts
 */

import { readFile as readFilePromise, writeFile } from "node:fs/promises";
import { readFile as readFileCallback, readFileSync } from "node:fs";
import path from "node:path";
import { withTempDir } from "./_helpers.ts";

await withTempDir(async (dir) => {
  const MB = 32;
  const READS = 15;
  const file = path.join(dir, "data.bin");
  await writeFile(file, Buffer.alloc(MB * 1024 * 1024, 0x61));

  console.log("=== 1. The same read, three ways ===");
  {
    const a = await readFilePromise(file);
    console.log("  fs/promises →", a.length, "bytes");

    const b = await new Promise<Buffer>((resolve, reject) =>
      readFileCallback(file, (err, data) => (err ? reject(err) : resolve(data))),
    );
    console.log("  callback    →", b.length, "bytes");

    const c = readFileSync(file);
    console.log("  sync        →", c.length, "bytes");
  }

  console.log(`
  Use node:fs/promises. Always. The callback form exists for interop with
  older code; the sync form exists for startup scripts. Neither belongs in a
  request handler.
`);

  console.log("=== 2. What sync costs: measured loop lag ===");
  {
    // The lag monitor from module 02: schedule a timer, measure how LATE it
    // fires. The loop can only be late if something blocked it.
    function monitor(intervalMs = 5) {
      let max = 0;
      let expected = performance.now() + intervalMs;
      const timer = setInterval(() => {
        const now = performance.now();
        max = Math.max(max, now - expected);
        expected = now + intervalMs;
      }, intervalMs);
      timer.unref();
      return { get maxLagMs() { return max; }, stop: () => clearInterval(timer) };
    }

    async function measure(label: string, fn: () => void | Promise<void>) {
      const m = monitor();
      const t0 = performance.now();
      await fn();
      const wall = performance.now() - t0;
      // A monitor cannot sample WHILE the loop is blocked — it records the
      // damage on the first sample after. So let the loop breathe once.
      await new Promise((r) => setTimeout(r, 40));
      m.stop();
      console.log(
        `  ${label.padEnd(34)} wall ${wall.toFixed(0).padStart(4)}ms   max loop lag ${m.maxLagMs.toFixed(0).padStart(4)}ms`,
      );
    }

    await measure(`${READS} × readFileSync (${MB}MB)`, () => {
      for (let i = 0; i < READS; i++) readFileSync(file);
    });

    await measure(`${READS} × await readFile (${MB}MB)`, async () => {
      for (let i = 0; i < READS; i++) await readFilePromise(file);
    });

    await measure(`${READS} × readFile, concurrent`, async () => {
      await Promise.all(Array.from({ length: READS }, () => readFilePromise(file)));
    });
  }

  console.log(`
  Read the LAG column, not the wall column.

  For the sync version, lag ≈ wall: the process was frozen for the ENTIRE
  duration. No requests accepted, no responses written, no health checks
  answered. For the async versions lag is near zero — the work went to the
  libuv thread pool and the loop kept turning.

  Scale it up mentally: if one handler does this per request at 100 req/s,
  every millisecond of lag is 100 requests' worth of queueing.

  Node can flag accidental sync I/O for you:
      node --trace-sync-io app.ts
`);

  console.log("=== 3. Async fs is not free either ===");
  {
    // fs work runs on the libuv THREAD POOL (module 02 §5), 4 threads by
    // default. It is not kernel-async the way sockets are.
    const N = 24;
    const t0 = performance.now();
    await Promise.all(Array.from({ length: N }, () => readFilePromise(file)));
    const ms = performance.now() - t0;
    const pool = Number(process.env["UV_THREADPOOL_SIZE"] ?? 4);
    console.log(`  ${N} concurrent ${MB}MB reads: ${ms.toFixed(0)}ms  (UV_THREADPOOL_SIZE = ${pool})`);
    console.log(`  → roughly ${Math.ceil(N / pool)} waves of ${pool}`);
    console.log(`
  Try:  UV_THREADPOOL_SIZE=16 node src/06-filesystem/01-apis.ts

  Two consequences:
    • Concurrent fs is bounded by the pool, not by your Promise.all width.
    • fs contends with crypto.pbkdf2, zlib, and dns.lookup for those same
      4 threads. Password hashing can make file reads look "slow disk".
`);
  }

  console.log("=== 4. Where each API belongs ===");
  console.log(`
  fs/promises            everything in a running server
  fs callbacks           interop with callback-based libraries
  fs sync                startup, CLIs, build scripts — before you serve traffic
  createReadStream       files too large to hold in memory (module 05)

  The startup exception is real and fine:

      // ✓ once, at boot, before listen()
      const config = JSON.parse(readFileSync("config.json", "utf8"));
      const server = createServer(handler);
      server.listen(config.port);

  Blocking for 5ms before you accept your first connection costs nothing.
  Blocking for 5ms per request costs you your p99.
`);
});
