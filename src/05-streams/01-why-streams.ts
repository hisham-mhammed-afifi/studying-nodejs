/**
 * 01 — Why streams: memory and time-to-first-byte, measured
 *
 * Run:  node src/05-streams/01-why-streams.ts
 */

import { createReadStream, createWriteStream } from "node:fs";
import { readFile, writeFile, mkdtemp, rm, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import { tmpdir } from "node:os";
import path from "node:path";
import { constants as bufferConstants } from "node:buffer";

const dir = await mkdtemp(path.join(tmpdir(), "streams-"));
const bigFile = path.join(dir, "big.txt");

try {
  // ── Build a ~120MB test file, streaming (so building it doesn't blow up) ──
  const LINE = "the quick brown fox jumps over the lazy dog".repeat(3) + "\n";
  const LINES = 900_000;
  await pipeline(
    Readable.from(
      (function* () {
        for (let i = 0; i < LINES; i++) yield LINE;
      })(),
    ),
    createWriteStream(bigFile),
  );
  const size = (await stat(bigFile)).size;
  console.log(`test file: ${(size / 1024 / 1024).toFixed(1)}MB, ${LINES.toLocaleString()} lines\n`);

  const mb = () => Math.round(process.memoryUsage().rss / 1024 / 1024);

  console.log("=== 1. Buffered: read it all, transform, write it all ===");
  {
    const before = mb();
    let peak = before;
    const sampler = setInterval(() => (peak = Math.max(peak, mb())), 5);

    const t0 = performance.now();
    const data = await readFile(bigFile, "utf8"); // ← the whole file, in RAM
    const out = data.toUpperCase(); // ← and now a SECOND copy
    await writeFile(path.join(dir, "out1.txt"), out);
    const ms = performance.now() - t0;

    clearInterval(sampler);
    console.log(`  time ${ms.toFixed(0)}ms   RSS ${before}MB → peak ${peak}MB   (+${peak - before}MB)`);
  }

  // Let GC reclaim before the second measurement.
  global.gc?.();
  await new Promise((r) => setTimeout(r, 200));

  console.log("\n=== 2. Streamed: 64KB at a time ===");
  {
    const before = mb();
    let peak = before;
    const sampler = setInterval(() => (peak = Math.max(peak, mb())), 5);

    const t0 = performance.now();
    await pipeline(
      createReadStream(bigFile, "utf8"),
      new Transform({
        // `decodeStrings: false` is REQUIRED here. Even though the readable
        // was created with "utf8" and emits strings, a Transform re-encodes
        // incoming strings to Buffers by default before calling _transform.
        // Without this flag you get "chunk.toUpperCase is not a function".
        decodeStrings: false,
        // NOTE: uppercasing per-chunk is safe only because this data is ASCII.
        // A real transform must handle characters split across chunks —
        // see module 04 §6 and this module's exercise.
        transform(chunk: string, _enc, cb) {
          cb(null, chunk.toUpperCase());
        },
      }),
      createWriteStream(path.join(dir, "out2.txt")),
    );
    const ms = performance.now() - t0;

    clearInterval(sampler);
    console.log(`  time ${ms.toFixed(0)}ms   RSS ${before}MB → peak ${peak}MB   (+${peak - before}MB)`);
  }

  console.log(`
  Compare the (+N MB) deltas, not the absolute numbers: RSS is memory the
  process has taken from the OS, and V8 does not hand it back promptly. The
  second run starts from the first run's high-water mark, which is exactly
  why "it looked fine in the last request" is no defence.

  The buffered version holds the file TWICE (source string + uppercased copy)
  plus the Buffer it was read into. The streamed version holds ~64KB per stage
  no matter how large the input is — that's backpressure doing its job.

  Wall time is often similar, or even better for the buffered version on a
  small file. Memory is what changes, and memory is what kills the process.
  Scale the input 10× and the buffered version dies; the streamed one doesn't.
`);

  console.log("=== 3. There is a hard ceiling ===");
  console.log(`  buffer.constants.MAX_LENGTH:       ${(bufferConstants.MAX_LENGTH / 1024 ** 3).toFixed(0)}GB (2^53-1 bytes on 64-bit Node ≥22)`);
  console.log(`  buffer.constants.MAX_STRING_LENGTH: ${(bufferConstants.MAX_STRING_LENGTH / 1024 ** 2).toFixed(0)}MB  ← the one that bites`);
  console.log(`
  The Buffer limit is effectively unreachable now, but the STRING limit is
  ~512MB and very reachable. So:

      await readFile(p);            // Buffer — fine up to your RAM
      await readFile(p, "utf8");    // string — THROWS past ~512MB
      buf.toString("utf8");         // same ceiling
      JSON.stringify(hugeObject);   // same ceiling

  No amount of RAM helps; it's a V8 limit. A streaming pipeline has no such
  ceiling because no single value ever holds the whole payload.
`);

  console.log("=== 4. Time to first byte ===");
  {
    // Simulate a slow producer: 20 rows, 10ms apart.
    async function* rows() {
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 10));
        yield { id: i };
      }
    }

    // Buffered: collect everything, then respond.
    const t0 = performance.now();
    const all = [];
    for await (const row of rows()) all.push(row);
    const buffered = performance.now() - t0;
    console.log(`  buffered → first byte at ${buffered.toFixed(0)}ms (i.e. the very end)`);

    // Streamed: the first row goes out as soon as it exists.
    const t1 = performance.now();
    let firstByteAt = 0;
    await pipeline(
      Readable.from(rows()),
      new Transform({
        objectMode: true,
        transform(row, _enc, cb) {
          firstByteAt ||= performance.now() - t1;
          cb(null, JSON.stringify(row) + "\n");
        },
      }),
      // A sink that throws the bytes away.
      new (await import("node:stream")).Writable({ write: (_c, _e, cb) => cb() }),
    );
    console.log(`  streamed → first byte at ${firstByteAt.toFixed(0)}ms`);
    console.log(`
  ${(buffered / firstByteAt).toFixed(0)}× faster to first byte. For a user watching a browser, or a
  client with a 30s timeout, that difference is the whole product.
`);
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
