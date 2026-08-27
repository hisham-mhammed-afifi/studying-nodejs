/**
 * 04 — pipe vs pipeline: the leak that costs you file descriptors
 *
 * Run:  node src/05-streams/04-pipeline.ts
 */

import { Readable, Writable, Transform, PassThrough } from "node:stream";
import { pipeline, finished } from "node:stream/promises";
import { setTimeout as sleep } from "node:timers/promises";

/** An endless source — so "destroyed" can only mean someone destroyed it. */
function endlessSource(): Readable {
  return new Readable({
    read() {
      this.push(Buffer.alloc(64, 0x61));
    },
  });
}

function failingSink() {
  return new Writable({
    write(_chunk, _enc, cb) {
      cb(new Error("destination exploded"));
    },
  });
}

console.log("=== 1. ✗ pipe() leaves the source running ===");
{
  const src = endlessSource();
  const dst = failingSink();

  src.pipe(dst);
  dst.on("error", () => {}); // required, or the process crashes (module 03 §2)

  await sleep(30);
  console.log("  after the destination errored:");
  console.log("    src.destroyed:  ", src.destroyed, "← never closed ✗");
  console.log("    src.readableEnded:", src.readableEnded, "← never finished ✗");
  console.log("    src.readableFlowing:", src.readableFlowing, "(unpiped, so paused — but still OPEN)");
  src.destroy(); // clean up manually, since pipe didn't
  console.log(`
  pipe() unhooked itself and walked away. The source is neither ended nor
  destroyed — it just sits there, open, forever.

  On a real source that's an open file descriptor, a socket, or a database
  cursor that is never released. One failing request leaks one fd. A few
  thousand later you hit EMFILE and the process stops accepting connections.
`);
}

console.log("=== 2. ✗ pipe() does not forward errors either ===");
{
  const src = new Readable({
    read() {
      this.destroy(new Error("source exploded"));
    },
  });
  const dst = new PassThrough();

  let dstSawError = false;
  dst.on("error", () => (dstSawError = true));
  src.on("error", () => {}); // we must handle it HERE or crash

  src.pipe(dst);
  await sleep(20);

  console.log("  source errored. dst.on('error') fired:", dstSawError, "✗");
  console.log("  dst.destroyed:", dst.destroyed, "← left dangling, never ends");
  console.log(`
  Errors travel in NEITHER direction through pipe(). Every stream in a
  hand-piped chain needs its own error handler, and you still have to
  destroy the others yourself. That's why the classic advice was:

      a.pipe(b).pipe(c);
      [a, b, c].forEach(s => s.on("error", cleanupEverything));

  Nobody writes that correctly under deadline. Which is why pipeline exists.
`);
  dst.destroy();
}

console.log("=== 3. ✓ pipeline() propagates and cleans up ===");
{
  const src = endlessSource();
  const dst = failingSink();

  const err = await pipeline(src, dst).catch((e: Error) => e);

  console.log("  rejected with:", (err as Error).message, "✓");
  console.log("  src.destroyed:", src.destroyed, "✓ cleaned up for you");
  console.log(`
  One promise. One catch. Every stream in the chain destroyed, in order,
  whichever one failed. This is the whole reason to prefer it.
`);
}

console.log("=== 4. pipeline with several stages ===");
{
  const upper = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      cb(null, Buffer.from(chunk.toString("ascii").toUpperCase()));
    },
  });
  const out: Buffer[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      out.push(chunk);
      cb();
    },
  });

  await pipeline(Readable.from(["hello ", "streams"]), upper, sink);
  console.log("  result:", JSON.stringify(Buffer.concat(out).toString()));
}

console.log("\n=== 5. Async generators as pipeline stages ===");
{
  // Anywhere a Transform can go, an async generator can go — and it is
  // usually much more readable. Backpressure still works: the generator is
  // only pulled when the next stage is ready for more.
  const out: string[] = [];

  await pipeline(
    Readable.from([1, 2, 3, 4, 5, 6]),
    async function* filterEven(source: AsyncIterable<number>) {
      for await (const n of source) if (n % 2 === 0) yield n;
    },
    async function* toLabel(source: AsyncIterable<number>) {
      for await (const n of source) yield `item-${n}`;
    },
    async function collect(source: AsyncIterable<string>) {
      for await (const s of source) out.push(s);
    },
  );

  console.log("  result:", out.join(", "));
  console.log(`
  The LAST stage may be a plain async function (a sink). Intermediate stages
  must be async GENERATORS. Compare the equivalent Transform subclass —
  three fewer concepts and no callback protocol to get wrong.
`);
}

console.log("=== 6. Cancellation with AbortSignal ===");
{
  const ac = new AbortController();
  let produced = 0;

  const forever = new Readable({
    async read() {
      await sleep(2);
      produced++;
      this.push(Buffer.alloc(8));
    },
  });

  setTimeout(() => ac.abort(new Error("client disconnected")), 40);

  const err = await pipeline(forever, new Writable({ write: (_c, _e, cb) => cb() }), {
    signal: ac.signal,
  }).catch((e: Error) => e);

  console.log("  aborted after", produced, "chunks:", (err as Error).name);
  console.log("  source destroyed:", forever.destroyed, "✓");
  console.log(`
  The standard wiring in an HTTP handler:

      const ac = new AbortController();
      req.on("close", () => ac.abort());     // browser hit stop / tab closed
      await pipeline(dbCursorStream, toNdjson(), res, { signal: ac.signal });

  Without it, a user who navigates away leaves your query streaming into a
  dead socket until it finishes.
`);
}

console.log("=== 7. finished() — wait for one stream ===");
{
  const s = Readable.from(["a", "b"]);
  s.resume(); // consume it
  await finished(s);
  console.log("  stream finished, destroyed:", s.destroyed);
  console.log(`
  finished(stream) resolves on 'end'/'finish' and rejects on 'error'. Use it
  when you're not building a pipeline but still need to await completion —
  e.g. after res.end() in a handler, or around a third-party stream.
`);
}

console.log("=== 8. The rule ===");
console.log(`
  ┌──────────────────────────────────────────────────────────────────────┐
  │  import { pipeline } from "node:stream/promises";                    │
  │  await pipeline(a, b, c, { signal });                                │
  │                                                                      │
  │  Not .pipe(). Not the callback version. This one.                    │
  └──────────────────────────────────────────────────────────────────────┘

  The only defensible use of .pipe() is a long-lived chain you deliberately
  do NOT want torn down when one side errors — rare enough that it deserves
  a comment explaining why.
`);
