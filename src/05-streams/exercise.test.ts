/**
 *   node scripts/test.ts 05
 *   node scripts/test.ts --solutions 05
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { type IngestOptions, type NdjsonOptions, ParseError, StreamLimitError } from "./exercise.ts";

const modulePath = process.env["IMPL"] === "solution" ? "./solution.ts" : "./exercise.ts";

type Impl = {
  createLineSplitter(maxLineLength?: number): Transform;
  createNdjsonParser(options?: NdjsonOptions): Transform;
  collect(source: Readable, maxBytes: number): Promise<Buffer>;
  createBatchWriter<T>(batchSize: number, flush: (batch: T[]) => Promise<void>): Writable;
  ingest(
    source: Readable,
    flush: (batch: unknown[]) => Promise<void>,
    options?: IngestOptions,
  ): Promise<number>;
};

let impl: Impl;
before(async () => {
  impl = (await import(modulePath)) as unknown as Impl;
});

/** Run chunks through a transform and collect everything it emits. */
async function through<T>(chunks: Buffer[] | string[], t: Transform): Promise<T[]> {
  const out: T[] = [];
  await pipeline(Readable.from(chunks, { objectMode: false }), t, async (src: AsyncIterable<T>) => {
    for await (const item of src) out.push(item);
  });
  return out;
}

const bufs = (...s: string[]) => s.map((x) => Buffer.from(x));

describe("createLineSplitter", () => {
  it("splits a simple multi-line chunk", async () => {
    assert.deepEqual(await through(bufs("a\nb\nc\n"), impl.createLineSplitter()), ["a", "b", "c"]);
  });

  it("emits the final line when there is no trailing newline", async () => {
    assert.deepEqual(await through(bufs("a\nb\nlast"), impl.createLineSplitter()), ["a", "b", "last"]);
  });

  it("does not emit a phantom empty line after a trailing newline", async () => {
    assert.deepEqual(await through(bufs("a\n"), impl.createLineSplitter()), ["a"]);
  });

  it("joins a line split across chunks", async () => {
    assert.deepEqual(await through(bufs("hello ", "wor", "ld\nnext\n"), impl.createLineSplitter()), [
      "hello world",
      "next",
    ]);
  });

  it("handles a newline arriving alone in its own chunk", async () => {
    assert.deepEqual(await through(bufs("a", "\n", "b", "\n"), impl.createLineSplitter()), ["a", "b"]);
  });

  it("handles CRLF", async () => {
    assert.deepEqual(await through(bufs("a\r\nb\r\n"), impl.createLineSplitter()), ["a", "b"]);
  });

  it("handles CRLF split across chunks", async () => {
    assert.deepEqual(await through(bufs("a\r", "\nb\r\n"), impl.createLineSplitter()), ["a", "b"]);
  });

  it("preserves empty lines", async () => {
    assert.deepEqual(await through(bufs("a\n\nb\n"), impl.createLineSplitter()), ["a", "", "b"]);
  });

  it("produces nothing for empty input", async () => {
    assert.deepEqual(await through([], impl.createLineSplitter()), []);
  });

  it("does NOT corrupt a multi-byte character split across chunks", async () => {
    // "héllo 😀 wörld" — 18 bytes; the emoji sits at bytes 7-10.
    const full = Buffer.from("héllo 😀 wörld\n");
    const lines = await through<string>([full.subarray(0, 9), full.subarray(9)], impl.createLineSplitter());
    assert.deepEqual(lines, ["héllo 😀 wörld"]);
    assert.ok(!lines[0]!.includes("�"), "replacement character found — decode per chunk?");
  });

  it("survives byte-at-a-time delivery of multi-byte text", async () => {
    const full = Buffer.from("日本語\nline two 😀\n");
    const chunks = [...full].map((b) => Buffer.from([b]));
    assert.deepEqual(await through(chunks, impl.createLineSplitter()), ["日本語", "line two 😀"]);
  });

  it("rejects a line longer than maxLineLength", async () => {
    await assert.rejects(
      () => through(bufs("x".repeat(200)), impl.createLineSplitter(100)),
      StreamLimitError,
    );
  });

  it("rejects an unterminated flood accumulated across chunks", async () => {
    const chunks = Array.from({ length: 50 }, () => Buffer.from("x".repeat(10)));
    await assert.rejects(() => through(chunks, impl.createLineSplitter(100)), StreamLimitError);
  });

  it("allows many lines whose TOTAL exceeds maxLineLength", async () => {
    // The limit is per line, not for the whole stream.
    const input = Array.from({ length: 50 }, (_, i) => `line-${i}`).join("\n") + "\n";
    const lines = await through<string>(bufs(input), impl.createLineSplitter(100));
    assert.equal(lines.length, 50);
  });
});

describe("createNdjsonParser", () => {
  const parse = (lines: string[], opts?: NdjsonOptions) =>
    (async () => {
      const out: unknown[] = [];
      await pipeline(Readable.from(lines), impl.createNdjsonParser(opts), async (src) => {
        for await (const v of src) out.push(v);
      });
      return out;
    })();

  it("parses objects", async () => {
    assert.deepEqual(await parse(['{"a":1}', '{"b":2}']), [{ a: 1 }, { b: 2 }]);
  });

  it("parses non-object JSON values too", async () => {
    assert.deepEqual(await parse(["1", '"two"', "[3]", "true"]), [1, "two", [3], true]);
  });

  it("treats a bare null line as invalid (it would end the stream)", async () => {
    await assert.rejects(() => parse(['{"a":1}', "null"]), ParseError);
  });

  it("a bare null does not silently truncate the stream when skipped", async () => {
    // The failure mode this guards against: pushing null in object mode is
    // EOF, so {"b":2} would vanish with no error at all.
    assert.deepEqual(await parse(['{"a":1}', "null", '{"b":2}'], { onInvalid: "skip" }), [
      { a: 1 },
      { b: 2 },
    ]);
  });

  it("skips blank and whitespace-only lines by default", async () => {
    assert.deepEqual(await parse(['{"a":1}', "", "   ", '{"b":2}']), [{ a: 1 }, { b: 2 }]);
  });

  it("errors on invalid JSON by default", async () => {
    await assert.rejects(() => parse(['{"a":1}', "{not json}"]), ParseError);
  });

  it("reports the correct 1-based line number, counting skipped lines", async () => {
    const err = await parse(['{"a":1}', "", "   ", "oops"]).catch((e: unknown) => e);
    assert.ok(err instanceof ParseError, "expected a ParseError");
    assert.equal(err.line, 4, "line number must match the INPUT, not the parse count");
  });

  it("skips invalid lines when asked", async () => {
    assert.deepEqual(await parse(['{"a":1}', "nope", '{"b":2}'], { onInvalid: "skip" }), [
      { a: 1 },
      { b: 2 },
    ]);
  });

  it("can be told not to skip empty lines", async () => {
    await assert.rejects(() => parse(['{"a":1}', ""], { skipEmpty: false }), ParseError);
  });
});

describe("collect", () => {
  it("collects a whole stream", async () => {
    const out = await impl.collect(Readable.from(bufs("hel", "lo ", "world")), 1000);
    assert.equal(out.toString(), "hello world");
  });

  it("returns an empty buffer for an empty stream", async () => {
    const out = await impl.collect(Readable.from([]), 1000);
    assert.equal(out.length, 0);
  });

  it("allows exactly maxBytes", async () => {
    const out = await impl.collect(Readable.from(bufs("12345")), 5);
    assert.equal(out.length, 5);
  });

  it("throws StreamLimitError past the cap", async () => {
    await assert.rejects(() => impl.collect(Readable.from(bufs("123456")), 5), StreamLimitError);
  });

  it("DESTROYS the source when it bails", async () => {
    let pushed = 0;
    const endless = new Readable({
      read() {
        pushed++;
        this.push(Buffer.alloc(1024));
      },
    });
    await assert.rejects(() => impl.collect(endless, 4096), StreamLimitError);
    assert.equal(endless.destroyed, true, "source must be destroyed, or the fd/socket leaks");
    const after = pushed;
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(pushed, after, "source is still producing after the limit was hit");
  });
});

describe("createBatchWriter", () => {
  it("flushes full batches", async () => {
    const batches: number[][] = [];
    const w = impl.createBatchWriter<number>(3, async (b) => void batches.push([...b]));
    await pipeline(Readable.from([1, 2, 3, 4, 5, 6]), w);
    assert.deepEqual(batches, [[1, 2, 3], [4, 5, 6]]);
  });

  it("flushes the remainder from _final", async () => {
    const batches: number[][] = [];
    const w = impl.createBatchWriter<number>(3, async (b) => void batches.push([...b]));
    await pipeline(Readable.from([1, 2, 3, 4, 5, 6, 7]), w);
    assert.deepEqual(batches, [[1, 2, 3], [4, 5, 6], [7]], "the trailing partial batch was dropped");
  });

  it("never flushes an empty batch", async () => {
    const batches: number[][] = [];
    const w = impl.createBatchWriter<number>(3, async (b) => void batches.push([...b]));
    await pipeline(Readable.from([]), w);
    assert.deepEqual(batches, []);
  });

  it("handles a batch size of 1", async () => {
    const batches: number[][] = [];
    const w = impl.createBatchWriter<number>(1, async (b) => void batches.push([...b]));
    await pipeline(Readable.from([1, 2]), w);
    assert.deepEqual(batches, [[1], [2]]);
  });

  it("waits for the flush to resolve (real backpressure)", async () => {
    let inFlight = 0;
    let peak = 0;
    const w = impl.createBatchWriter<number>(2, async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
    });
    await pipeline(Readable.from([1, 2, 3, 4, 5, 6, 7, 8]), w);
    assert.equal(peak, 1, "flushes overlapped — the callback fired before the work finished");
  });

  it("propagates a flush rejection", async () => {
    const w = impl.createBatchWriter<number>(2, async () => {
      throw new Error("db down");
    });
    await assert.rejects(() => pipeline(Readable.from([1, 2, 3, 4]), w), /db down/);
  });

  it("does not send an item twice", async () => {
    const seen: number[] = [];
    const w = impl.createBatchWriter<number>(2, async (b) => {
      await new Promise((r) => setTimeout(r, 5));
      seen.push(...b);
    });
    await pipeline(Readable.from([1, 2, 3, 4, 5]), w);
    assert.deepEqual(seen, [1, 2, 3, 4, 5]);
  });
});

describe("ingest", () => {
  const ndjson = (objs: unknown[]) => objs.map((o) => JSON.stringify(o)).join("\n");

  it("runs the whole pipeline and counts records", async () => {
    const written: unknown[] = [];
    const input = ndjson([{ id: 1 }, { id: 2 }, { id: 3 }]) + "\n";
    const n = await impl.ingest(Readable.from(bufs(input)), async (b) => void written.push(...b), {
      batchSize: 2,
    });
    assert.equal(n, 3);
    assert.deepEqual(written, [{ id: 1 }, { id: 2 }, { id: 3 }]);
  });

  it("handles a final line with no newline", async () => {
    const written: unknown[] = [];
    const input = ndjson([{ id: 1 }, { id: 2 }]); // no trailing \n
    const n = await impl.ingest(Readable.from(bufs(input)), async (b) => void written.push(...b));
    assert.equal(n, 2);
  });

  it("survives arbitrary chunk boundaries and multi-byte text", async () => {
    const written: unknown[] = [];
    const input = Buffer.from(ndjson([{ name: "héllo 😀" }, { name: "日本語" }]) + "\n");
    const chunks = [...input].map((b) => Buffer.from([b])); // one byte at a time
    const n = await impl.ingest(Readable.from(chunks), async (b) => void written.push(...b), {
      batchSize: 1,
    });
    assert.equal(n, 2);
    assert.deepEqual(written, [{ name: "héllo 😀" }, { name: "日本語" }]);
  });

  it("propagates a parse error", async () => {
    await assert.rejects(
      () => impl.ingest(Readable.from(bufs('{"a":1}\nbroken\n')), async () => {}),
      ParseError,
    );
  });

  it("can skip invalid lines", async () => {
    const written: unknown[] = [];
    const n = await impl.ingest(
      Readable.from(bufs('{"a":1}\nbroken\n{"b":2}\n')),
      async (b) => void written.push(...b),
      { onInvalid: "skip", batchSize: 1 },
    );
    assert.equal(n, 2);
  });

  it("propagates a line-length violation", async () => {
    await assert.rejects(
      () => impl.ingest(Readable.from(bufs("x".repeat(500))), async () => {}, { maxLineLength: 100 }),
      StreamLimitError,
    );
  });

  it("propagates a flush failure", async () => {
    await assert.rejects(
      () =>
        impl.ingest(Readable.from(bufs('{"a":1}\n')), async () => {
          throw new Error("sink exploded");
        }),
      /sink exploded/,
    );
  });

  it("honours an AbortSignal and destroys the source", async () => {
    let produced = 0;
    const forever = new Readable({
      // NOTE the setImmediate. A read() that pushes SYNCHRONOUSLY forever
      // starves the event loop (module 02 §2.3) — the abort timer would never
      // get a turn to fire, and this test would hang rather than fail. Real
      // sources are I/O-driven and yield naturally.
      read() {
        setImmediate(() => {
          produced++;
          this.push(Buffer.from(JSON.stringify({ n: produced }) + "\n"));
        });
      },
    });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 25);

    await assert.rejects(
      () => impl.ingest(forever, async () => {}, { signal: ac.signal, batchSize: 10 }),
      (err: unknown) => (err as Error).name === "AbortError",
    );
    assert.equal(forever.destroyed, true);
  });

  it("keeps memory bounded on a large input", async () => {
    // 50k records, one byte-mode chunk each, with a slow sink. If any stage
    // ignored backpressure this would balloon; we assert it stays sane.
    const RECORDS = 50_000;
    function* gen() {
      for (let i = 0; i < RECORDS; i++) yield Buffer.from(JSON.stringify({ i }) + "\n");
    }
    const before = process.memoryUsage().heapUsed;
    const n = await impl.ingest(Readable.from(gen()), async () => {}, { batchSize: 500 });
    const grewMB = (process.memoryUsage().heapUsed - before) / 1024 / 1024;
    assert.equal(n, RECORDS);
    assert.ok(grewMB < 120, `heap grew ${grewMB.toFixed(0)}MB — is a stage buffering everything?`);
  });
});
