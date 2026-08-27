/**
 * 03 — Backpressure, measured
 *
 * The reason streams exist. Run this and watch the memory difference.
 *
 * Run:  node src/05-streams/03-backpressure.ts
 */

import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { once } from "node:events";

interface Stats {
  peak: number;
  writes: number;
  bytes: number;
}

/** A destination that takes 2ms per _write call — a database, a socket, a slow disk. */
function slowSink(stats: Stats) {
  const w = new Writable({
    highWaterMark: 16 * 1024, // 16KB
    write(chunk: Buffer, _enc, cb) {
      stats.peak = Math.max(stats.peak, w.writableLength);
      stats.writes += 1;
      stats.bytes += chunk.length;
      setTimeout(cb, 2); // ← the callback is what signals "done"
    },
  });
  return w;
}

const newStats = (): Stats => ({ peak: 0, writes: 0, bytes: 0 });
const report = (label: string, ms: number, s: Stats) =>
  console.log(
    `  ${label}  time ${ms.toFixed(0).padStart(4)}ms   peak buffered ${(s.peak / 1024).toFixed(0).padStart(4)}KB   ` +
      `_write calls ${String(s.writes).padStart(3)}   bytes ${(s.bytes / 1024).toFixed(0)}KB`,
  );

/** A source that can produce as fast as anyone will take it. */
function fastSource(chunks: number, size = 8 * 1024) {
  let n = 0;
  return new Readable({
    read() {
      this.push(n++ < chunks ? Buffer.alloc(size, 0x61) : null);
    },
  });
}

const CHUNKS = 200;
const SIZE = 8 * 1024;
console.log(`Producing ${CHUNKS} × ${SIZE / 1024}KB = ${(CHUNKS * SIZE) / 1024}KB into a sink that takes 2ms/chunk\n`);

console.log("=== 1. ✗ Ignoring the return value of write() ===");
{
  const stats = newStats();
  const sink = slowSink(stats);

  const t0 = performance.now();
  for await (const chunk of fastSource(CHUNKS, SIZE)) {
    sink.write(chunk); // ← the return value is DISCARDED
  }
  sink.end();
  await once(sink, "finish");

  report("✗", performance.now() - t0, stats);
  console.log(`
  Peak buffered is ${(stats.peak / (16 * 1024)).toFixed(0)}× the 16KB highWaterMark — essentially the whole input.

  write() ALWAYS accepts the chunk; it never rejects data. The boolean is
  ADVICE, and ignoring it just grows the internal buffer. Here ${(CHUNKS * SIZE) / 1024}KB ended
  up queued in RAM. With a 2GB upload it would be 2GB.
`);
}

console.log("=== 2. ✓ Respecting it ===");
{
  const stats = newStats();
  const sink = slowSink(stats);

  const t0 = performance.now();
  let drains = 0;
  for await (const chunk of fastSource(CHUNKS, SIZE)) {
    if (!sink.write(chunk)) {
      drains++;
      await once(sink, "drain"); // ← wait until the buffer has emptied
    }
  }
  sink.end();
  await once(sink, "finish");

  report("✓", performance.now() - t0, stats);
  console.log(`      (awaited 'drain' ${drains} times)`);
}

console.log("\n=== 3. ✓✓ Just use pipeline ===");
{
  const stats = newStats();
  const sink = slowSink(stats);

  const t0 = performance.now();
  await pipeline(fastSource(CHUNKS, SIZE), sink);

  report("✓", performance.now() - t0, stats);
}

console.log(`
  Read those three lines together. Same bytes delivered in all cases, but:

  • Peak buffered is the headline: ~1600KB unbounded vs tens of KB bounded.
    That number is your memory-per-connection, and it scales with the input,
    not with the highWaterMark.

  • The '_write calls' column is the surprise. Case 2 makes ~8× FEWER calls
    than the others, with larger chunks — when several chunks are queued
    behind a slow write, Node coalesces them into one _write. So respecting
    backpressure was also the FASTEST here, not a tax you pay for safety.

  • pipeline reports the same call count as the naive version but keeps peak
    buffered at one chunk. It pulls the source only when the sink is ready,
    so chunks rarely queue up to be merged in the first place. It optimises
    for bounded memory, which is the right default.

  Don't over-read the timings — they're dominated by this sink's 2ms. The
  durable lesson is the memory column.
`);

console.log("=== 4. The signal in detail ===");
{
  const w = new Writable({ highWaterMark: 100, write: (_c, _e, cb) => void setTimeout(cb, 30) });

  console.log("  write(50 bytes)  →", w.write(Buffer.alloc(50)), " (buffer below the 100B mark)");
  console.log("  write(200 bytes) →", w.write(Buffer.alloc(200)), "(over the mark — stop!)");
  console.log("  writableLength:  ", w.writableLength, "bytes buffered");
  console.log("  writableNeedDrain:", w.writableNeedDrain);
  console.log("  ...note the 200-byte write was still ACCEPTED in full.");
  console.log("     highWaterMark is a threshold, not a hard cap.");

  await once(w, "drain");
  console.log("  after 'drain'    → writableLength:", w.writableLength, "| needDrain:", w.writableNeedDrain);
  w.destroy();
}

console.log("\n=== 5. highWaterMark defaults ===");
{
  const r = new Readable({ read() {} });
  const w = new Writable({ write: (_c, _e, cb) => cb() });
  const ro = new Readable({ objectMode: true, read() {} });
  console.log("  byte-mode readable:  ", r.readableHighWaterMark, "bytes (64KB)");
  console.log("  byte-mode writable:  ", w.writableHighWaterMark, "bytes (64KB)");
  console.log("  object-mode readable:", ro.readableHighWaterMark, "objects");
  r.destroy();
  w.destroy();
  ro.destroy();
  console.log(`
  In byte mode it counts BYTES; in object mode it counts ITEMS.

  Tuning it is rarely the answer. Bigger = fewer syscalls, more memory per
  connection (multiply by your concurrency!). Smaller = tighter memory, more
  overhead. 64KB is a good default; change it only with a measurement.
`);
}

console.log("=== 6. The chain, and how one bad stage breaks it ===");
console.log(`
     source          transform         destination
       │                 │                  │
     read() ◄──── pull ──┤ ◄──── pull ──────┤
       └──── push ─────► │ ──── push ─────► │
                      (64KB)             (64KB)

  When the destination's buffer fills it stops pulling; the transform's
  buffer fills so IT stops pulling; the source stops reading. Total memory
  is ~highWaterMark × stages.

  That only holds if EVERY stage respects the signal. The usual offenders:

    ✗ .on("data", async handler)          the promise is never awaited
    ✗ for await (...) dest.write(chunk)   return value discarded
    ✗ _write(chunk, enc, cb) { save(chunk); cb(); }
                                          cb() BEFORE the work finished —
                                          the stream thinks it's ready for
                                          more, so the queue is unbounded
    ✗ collecting into an array "just for now"

  The last one is the sneakiest, because it looks like it isn't a stream
  problem at all:

      const rows = [];
      for await (const row of hugeQuery) rows.push(row);   // ✗ no limit
`);

console.log("=== 7. Correct async _write ===");
{
  const saved: number[] = [];
  const sink = new Writable({
    objectMode: true,
    highWaterMark: 4,
    write(chunk: number, _enc, cb) {
      // The callback is the backpressure signal. Call it only when the work
      // is DONE — otherwise you have told the stream a lie and it will hand
      // you the entire input as fast as it can read it.
      setTimeout(() => {
        saved.push(chunk);
        cb();
      }, 1);
    },
    // Called once at the end, before 'finish'. Flush anything still batched.
    final(cb) {
      console.log("  _final ran — flushed. total saved:", saved.length);
      cb();
    },
  });

  await pipeline(Readable.from([1, 2, 3, 4, 5, 6, 7, 8]), sink);
  console.log("  saved in order:", saved.join(","));
  console.log(`
  Error handling: pass the error to the callback — cb(err) — do NOT throw
  inside _write. Throwing escapes the stream machinery and becomes an
  uncaught exception instead of an 'error' event pipeline can catch.
`);
}
