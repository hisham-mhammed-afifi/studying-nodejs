/**
 * 02 — Reading streams: three APIs, and which to use
 *
 * Run:  node src/05-streams/02-reading.ts
 */

import { Readable } from "node:stream";
import { text, json, buffer } from "node:stream/consumers";
import { setTimeout as sleep } from "node:timers/promises";

const src = () => Readable.from([Buffer.from("hel"), Buffer.from("lo "), Buffer.from("world")]);

console.log("=== 1. for await — the one to use ===");
{
  const chunks: Buffer[] = [];
  for await (const chunk of src()) chunks.push(chunk);
  console.log("  chunks:", chunks.map((c) => JSON.stringify(c.toString())).join(", "));
  console.log("  joined:", JSON.stringify(Buffer.concat(chunks).toString()));
  console.log(`
  Handles backpressure automatically: the loop body must finish before the
  next chunk is pulled. Errors arrive as exceptions you can try/catch. And
  it cleans up if you leave early — see below.
`);
}

console.log("=== 2. Leaving early destroys the stream ===");
{
  const r = Readable.from([1, 2, 3, 4, 5]);
  const seen: number[] = [];
  for await (const v of r) {
    seen.push(v);
    if (v === 2) break;
  }
  console.log("  consumed:", seen, "| r.destroyed:", r.destroyed);
  console.log(`
  This matters for real resources: break out of a loop over a file stream or
  an HTTP response and the fd/socket is closed for you. With .on("data") you
  would have to remember to call destroy() yourself.
`);
}

console.log("=== 3. Errors propagate as exceptions ===");
{
  const failing = new Readable({
    read() {
      this.destroy(new Error("disk exploded"));
    },
  });
  try {
    for await (const _ of failing) void _;
  } catch (err) {
    console.log("  caught:", (err as Error).message, "✓");
  }
  console.log("  (with .on('data') this would be an 'error' EVENT — and an");
  console.log("   unhandled one crashes the process; see module 03 §2)");
}

console.log("\n=== 4. The .on('data') async trap ===");
{
  // The single most common streams bug in real code.
  const r = Readable.from(Array.from({ length: 10 }, (_, i) => i));
  let inFlight = 0;
  let peak = 0;

  await new Promise<void>((resolve) => {
    r.on("data", async (n: number) => {
      // This function returns a PROMISE. The stream drops it on the floor and
      // immediately emits the next chunk. Nothing is awaited, nothing is
      // throttled, and a rejection here becomes an unhandled rejection.
      peak = Math.max(peak, ++inFlight);
      await sleep(20);
      inFlight--;
      void n;
    });
    r.on("end", resolve);
  });

  console.log(`  peak concurrent handlers: ${peak} of 10 — ALL of them at once ✗`);
  console.log("  ('end' also fired before a single handler had finished)");

  // The same work, done correctly:
  let peak2 = 0;
  let inFlight2 = 0;
  for await (const n of Readable.from(Array.from({ length: 10 }, (_, i) => i))) {
    peak2 = Math.max(peak2, ++inFlight2);
    await sleep(20);
    inFlight2--;
    void n;
  }
  console.log(`  with for await, peak concurrent: ${peak2} ✓`);

  console.log(`
  With a real source — a 2GB file, a firehose socket — the broken version
  reads at full speed while your async work queues in memory. That is an
  unbounded buffer with extra steps. Symptom: RSS climbs, then OOM.
`);
}

console.log("=== 5. Flowing vs paused ===");
{
  const r = Readable.from(["a", "b"]);
  console.log("  fresh stream        → readableFlowing:", r.readableFlowing, "(nothing has asked yet)");
  r.on("data", () => {});
  console.log("  after .on('data')   → readableFlowing:", r.readableFlowing);
  r.pause();
  console.log("  after .pause()      → readableFlowing:", r.readableFlowing);

  console.log(`
    null   nobody has asked for data; nothing is emitted
    true   flowing — chunks are pushed at you via 'data'
    false  paused — you must call read() yourself

  ⚠ A stream in flowing mode with no real consumer DISCARDS data. Attaching
  a 'data' listener "just for logging" and then also using for-await loses
  chunks, silently and non-deterministically.
`);
}

console.log("=== 6. Paused mode: read(n) ===");
{
  // Useful for binary parsers that want exactly N bytes at a time.
  //
  // ⚠ Must be a BYTE-mode stream. Readable.from() defaults to objectMode,
  // where read(n) ignores n and hands you one whole item — a genuinely
  // confusing interaction. Pass { objectMode: false } to opt out.
  const r = Readable.from([Buffer.from("ABCDEFGHIJ")], { objectMode: false });
  await new Promise<void>((resolve) => {
    r.on("readable", () => {
      let chunk: Buffer | null;
      while ((chunk = r.read(3) as Buffer | null) !== null) {
        console.log("  read(3) →", JSON.stringify(chunk.toString()));
      }
    });
    r.on("end", () => {
      console.log("  (the trailing 'J' is released at EOF — read(3) would have");
      console.log("   returned null forever otherwise, waiting for 3 bytes)");
      resolve();
    });
  });
  console.log(`
  read(n) returns null until n bytes are available — which is exactly the
  "wait for a complete header" logic you hand-rolled in module 04. For a
  fixed-size binary protocol this is the tidiest API Node offers.
`);
}

console.log("=== 7. Consuming a whole stream ===");
{
  console.log("  text():  ", JSON.stringify(await text(src())));
  console.log("  buffer():", (await buffer(src())).length, "bytes");
  console.log("  json():  ", await json(Readable.from(['{"a":', "1}"])));

  console.log(`
  node:stream/consumers is correct and short. text() even decodes UTF-8
  properly across chunk boundaries (module 04 §6), which manual
  chunk.toString() concatenation does not.

  ⚠ But they all buffer EVERYTHING. For anything off the network you must
  cap the size yourself — see 03-backpressure.ts and the exercise. Every
  unguarded "await text(req)" is a memory-exhaustion vector.
`);
}

console.log("=== 8. Creating readables ===");
{
  console.log("  from an array:      ", await text(Readable.from(["a", "b"])));

  async function* gen() {
    for (const w of ["x", "y", "z"]) {
      await sleep(1);
      yield w;
    }
  }
  console.log("  from an async gen:  ", await text(Readable.from(gen())));

  // Readable.from on a generator is almost always nicer than subclassing.
  const objects = Readable.from([{ id: 1 }, { id: 2 }]); // object mode is automatic
  const ids: number[] = [];
  for await (const o of objects) ids.push((o as { id: number }).id);
  console.log("  object mode:        ", ids);
}
