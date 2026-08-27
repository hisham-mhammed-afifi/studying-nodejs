/**
 * 05 — Writing your own streams
 *
 * Run:  node src/05-streams/05-transforms.ts
 */

import { Readable, Writable, Transform, type Duplex, type TransformCallback } from "node:stream";
import * as stream from "node:stream";
import { pipeline } from "node:stream/promises";
import { text } from "node:stream/consumers";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as sleep } from "node:timers/promises";

console.log("=== 1. A custom Readable ===");
{
  class Counter extends Readable {
    #n = 0;
    readonly #max: number;
    // NOTE: `constructor(private readonly max: number)` — a TypeScript
    // parameter property — does NOT work here. Node strips types; it does not
    // transform code, and parameter properties require generating an
    // assignment. tsconfig's `erasableSyntaxOnly` flags these for you.
    constructor(max: number) {
      super({ objectMode: true });
      this.#max = max;
    }
    // Called when the consumer wants more data. Push until push() returns
    // false (buffer full) or you hit the end. NEVER call _read yourself.
    override _read(): void {
      if (this.#n >= this.#max) {
        this.push(null); // null = EOF. Nothing may be pushed after this.
        return;
      }
      this.push({ n: this.#n++ });
    }
  }

  const seen: number[] = [];
  for await (const item of new Counter(5)) seen.push((item as { n: number }).n);
  console.log("  Counter(5) →", seen.join(","));
}

console.log("\n=== 2. ...but Readable.from is usually better ===");
{
  // Same thing, no subclass, no _read protocol, and async is trivial.
  async function* counter(max: number) {
    for (let n = 0; n < max; n++) {
      await sleep(1); // ← try doing this cleanly inside _read()
      yield { n };
    }
  }
  const seen: number[] = [];
  for await (const item of Readable.from(counter(5))) seen.push(item.n);
  console.log("  Readable.from(gen) →", seen.join(","));
  console.log(`
  Subclass Readable only when you need fine control over pull timing (e.g.
  wrapping a callback-based C library). For anything driven by an async
  source — a DB cursor, a paginated API — the generator wins.
`);
}

console.log("=== 3. A custom Writable, with batching ===");
{
  const inserted: number[][] = [];

  class BatchWriter extends Writable {
    #batch: number[] = [];
    readonly #batchSize: number;
    constructor(batchSize: number) {
      super({ objectMode: true, highWaterMark: 4 });
      this.#batchSize = batchSize;
    }

    override _write(chunk: number, _enc: BufferEncoding, cb: (e?: Error | null) => void): void {
      this.#batch.push(chunk);
      if (this.#batch.length < this.#batchSize) {
        cb(); // fast path: buffered, nothing to await
        return;
      }
      this.#flush().then(() => cb(), cb);
      //                            ^^^ pass the error to cb — never throw
    }

    // Called ONCE at end of input, before 'finish'. Your last chance to
    // flush a partial batch. Forgetting _final silently drops the tail.
    override _final(cb: (e?: Error | null) => void): void {
      this.#flush().then(() => cb(), cb);
    }

    async #flush(): Promise<void> {
      if (this.#batch.length === 0) return;
      const batch = this.#batch.splice(0);
      await sleep(2); // pretend: db.insertMany(batch)
      inserted.push(batch);
    }
  }

  await pipeline(Readable.from([1, 2, 3, 4, 5, 6, 7]), new BatchWriter(3));
  console.log("  batches inserted:", JSON.stringify(inserted));
  console.log("  ← note the trailing [7]: that came from _final ✓");
  console.log(`
  THE rule for _write: call the callback only when the work has ACTUALLY
  completed. Calling it early tells the stream you're ready for more, which
  disables backpressure and turns the write buffer into an unbounded queue.

  Also implement _writev(chunks, cb) if batching is cheaper than one-at-a-
  time — Node will hand you everything currently buffered in one call.
`);
}

console.log("=== 4. A Transform — and the bug hiding in it ===");
{
  // The naive version, which you will see in a lot of code:
  const naiveUpper = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      cb(null, Buffer.from(chunk.toString("utf8").toUpperCase()));
    },
  });

  // Split a multi-byte character across chunks (module 04 §6). "straße " is
  // 8 bytes, so the emoji occupies bytes 8-11 — cutting at 10 splits it.
  const src = Buffer.from("straße 😀 café");
  const chunks = [src.subarray(0, 10), src.subarray(10)];

  const broken = await text(Readable.from(chunks).pipe(naiveUpper));
  console.log("  naive Transform →", JSON.stringify(broken));
  console.log("  ✗ replacement characters: chunk.toString() decoded a partial character");

  // The fix: a stateful decoder, plus _flush to emit whatever is left.
  class SafeUpper extends Transform {
    readonly #decoder = new StringDecoder("utf8");
    override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
      cb(null, this.#decoder.write(chunk).toUpperCase());
    }
    override _flush(cb: TransformCallback): void {
      // _flush runs at end-of-input. This is where buffered tails go —
      // a partial character here, a final unterminated line in a splitter.
      cb(null, this.#decoder.end().toUpperCase());
    }
  }

  const fixed = await text(Readable.from(chunks).pipe(new SafeUpper()));
  console.log("  SafeUpper       →", JSON.stringify(fixed), "✓");
  console.log(`
  Every Transform that turns bytes into text, or splits on a delimiter, has
  this problem. _flush exists precisely so you can carry a remainder across
  chunks and emit it at the end. Building one properly is the exercise.
`);
}

console.log("=== 5. Object mode ===");
{
  // Bytes in, objects out — the shape of every parser.
  const parseNumbers = new Transform({
    writableObjectMode: false, // input: Buffers
    readableObjectMode: true, // output: objects
    transform(chunk: Buffer, _enc, cb) {
      for (const part of chunk.toString().split(",")) {
        if (part.trim()) this.push({ value: Number(part) });
      }
      cb();
    },
  });

  const out: unknown[] = [];
  await pipeline(Readable.from([Buffer.from("1,2,3")]), parseNumbers, async (src) => {
    for await (const o of src) out.push(o);
  });
  console.log("  parsed:", JSON.stringify(out));
  console.log(`
  Notes on object mode:
    • highWaterMark counts ITEMS (default 16), not bytes.
    • You can push MANY items per input chunk — that's what a parser does.
    • ⚠ You can never push null as a VALUE: null is the EOF sentinel.
      Use undefined, or a sentinel object, or wrap it: { value: null }.
`);
}

console.log("=== 6. Options object vs subclass ===");
{
  // Identical behaviour, less ceremony. Note the method names differ:
  // options use `transform`/`flush`; subclasses use `_transform`/`_flush`.
  const double = new Transform({
    objectMode: true,
    transform(n: number, _enc, cb) {
      cb(null, n * 2);
    },
    flush(cb) {
      cb();
    },
  });

  const out: number[] = [];
  await pipeline(Readable.from([1, 2, 3]), double, async (s) => {
    for await (const n of s) out.push(n as number);
  });
  console.log("  doubled:", out.join(","));
  console.log("  (options: transform/flush · subclass: _transform/_flush — easy to mix up)");
}

console.log("\n=== 7. compose(): bundle stages into one reusable stream ===");
{
  const trim = new Transform({
    objectMode: true,
    transform(s: string, _e, cb) {
      cb(null, s.trim());
    },
  });
  const dropEmpty = new Transform({
    objectMode: true,
    transform(s: string, _e, cb) {
      cb(null, s === "" ? undefined : s);
    },
  });

  // One Duplex you can pass around, test, and reuse.
  //
  // NOTE: compose() has shipped since Node 16.9 but isn't in @types/node's
  // exports yet, hence the cast. A useful reminder that the types are a
  // community package that trails the runtime — when TS says a real API
  // doesn't exist, check the Node docs before believing it.
  const compose = (stream as unknown as { compose: (...s: Duplex[]) => Duplex }).compose;
  const clean = compose(trim, dropEmpty);

  const out: string[] = [];
  await pipeline(Readable.from(["  a  ", "   ", "b"]), clean, async (s: AsyncIterable<unknown>) => {
    for await (const v of s) out.push(v as string);
  });
  console.log("  cleaned:", JSON.stringify(out));
  console.log(`
  compose() is how you package a multi-stage pipeline as a single library
  export — callers just see one Duplex and don't care how many stages are
  inside. (Passing 'undefined' to cb() emits nothing, which is how a
  Transform filters items out.)
`);
}

console.log("=== 8. Choosing ===");
console.log(`
  Need a source from an async thing?     Readable.from(asyncGenerator())
  Need a source with custom pull timing? extends Readable, _read()
  Need to consume with side effects?     extends Writable, _write() + _final()
  Need to map/filter in a pipeline?      an async generator stage
  Need a REUSABLE mapper?                extends Transform, or compose()
  Need to fan out / instrument?          PassThrough

  Reach for an async generator first. Reach for Transform when you need a
  named, reusable, independently-testable unit — which is what the exercise
  builds.
`);
