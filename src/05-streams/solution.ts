/**
 * SOLUTION 05 — reference implementation.
 */

import { Transform, Writable, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import {
  type IngestOptions,
  type NdjsonOptions,
  ParseError,
  StreamLimitError,
} from "./exercise.ts";

// --- Task 1 ------------------------------------------------------------------

export function createLineSplitter(maxLineLength = 1024 * 1024): Transform {
  // (a) A stateful decoder holds back an incomplete UTF-8 sequence until the
  //     bytes that finish it arrive. Without this, a character straddling a
  //     chunk boundary becomes U+FFFD — module 04 §6.
  const decoder = new StringDecoder("utf8");
  // (b) Whatever is left after the last newline in a chunk is an INCOMPLETE
  //     line. It has to survive until the next chunk.
  let pending = "";

  return new Transform({
    readableObjectMode: true, // we emit strings, not bytes

    transform(chunk: Buffer, _enc, cb) {
      pending += decoder.write(chunk);

      const parts = pending.split("\n");
      // The last element is by definition incomplete — no newline followed it.
      pending = parts.pop() ?? "";

      for (const part of parts) {
        // Handle CRLF by stripping a trailing \r. Doing it here rather than
        // splitting on /\r?\n/ keeps the remainder logic simple.
        const line = part.endsWith("\r") ? part.slice(0, -1) : part;
        if (line.length > maxLineLength) {
          cb(new StreamLimitError(`line exceeded ${maxLineLength} characters`));
          return;
        }
        this.push(line);
      }

      // (d) Check the REMAINDER, after splitting — not the whole accumulator
      //     before it. Checking `pending` up front is the obvious-looking bug:
      //     a chunk holding fifty short lines legitimately exceeds the
      //     per-LINE limit, and you'd reject valid input. What must be bounded
      //     is the unterminated tail, because that is the part that can grow
      //     without limit when an attacker sends 10GB with no newline.
      if (pending.length > maxLineLength) {
        cb(new StreamLimitError(`line exceeded ${maxLineLength} characters`));
        return;
      }

      cb();
    },

    // (c) End of input. Flush the decoder (any truncated character) and emit
    //     the final unterminated line. Skipping this drops the last record of
    //     every file that doesn't end in a newline — very common.
    flush(cb) {
      pending += decoder.end();
      if (pending.length > 0) {
        this.push(pending.endsWith("\r") ? pending.slice(0, -1) : pending);
        pending = "";
      }
      cb();
    },
  });
}

// --- Task 2 ------------------------------------------------------------------

export function createNdjsonParser(options: NdjsonOptions = {}): Transform {
  const { skipEmpty = true, onInvalid = "error" } = options;
  // Counts EVERY input line, including skipped ones, so the number in an
  // error message matches what the user sees in their editor.
  let lineNumber = 0;

  return new Transform({
    objectMode: true,

    transform(line: string, _enc, cb) {
      lineNumber += 1;

      if (skipEmpty && line.trim() === "") {
        cb();
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (err) {
        if (onInvalid === "skip") {
          cb();
          return;
        }
        // Pass the error to the callback — do NOT throw. Throwing inside
        // _transform escapes the stream machinery and becomes an uncaught
        // exception instead of something pipeline can catch.
        cb(new ParseError(`invalid JSON on line ${lineNumber}: ${(err as Error).message}`, lineNumber));
        return;
      }

      // ⚠ THE OBJECT-MODE NULL TRAP. `JSON.parse("null")` is valid and yields
      // null — but in object mode null is the EOF sentinel. Pushing it would
      // silently END the stream, and every record after this line would
      // vanish with no error at all. That is a genuinely nasty data-loss bug,
      // so treat a bare `null` record as invalid rather than emitting it.
      if (parsed === null) {
        if (onInvalid === "skip") {
          cb();
          return;
        }
        cb(new ParseError(`line ${lineNumber} is a bare null, which cannot be emitted in object mode`, lineNumber));
        return;
      }

      cb(null, parsed);
    },
  });
}

// --- Task 3 ------------------------------------------------------------------

export async function collect(source: Readable, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of source as AsyncIterable<Buffer>) {
    total += chunk.length;
    if (total > maxBytes) {
      // Destroy the SOURCE, don't just throw. Throwing exits the loop, but
      // for-await only auto-destroys on break/throw inside the loop body —
      // and either way we want the sender to stop immediately and the
      // fd/socket released now, not at some later GC.
      source.destroy();
      throw new StreamLimitError(`stream exceeded ${maxBytes} bytes`);
    }
    chunks.push(chunk);
  }

  // One allocation, not O(n²) repeated concat — module 04 §7.1. Passing the
  // known total lets Node skip a counting pass.
  return Buffer.concat(chunks, total);
}

// --- Task 4 ------------------------------------------------------------------

export function createBatchWriter<T>(batchSize: number, flush: (batch: T[]) => Promise<void>): Writable {
  let batch: T[] = [];

  const doFlush = async (): Promise<void> => {
    if (batch.length === 0) return;
    // Swap the array out BEFORE awaiting, so items arriving during the flush
    // land in a fresh batch rather than being sent twice or lost.
    const toSend = batch;
    batch = [];
    await flush(toSend);
  };

  return new Writable({
    objectMode: true,
    highWaterMark: Math.max(batchSize * 2, 16),

    write(chunk: T, _enc, cb) {
      batch.push(chunk);
      if (batch.length < batchSize) {
        cb(); // fast path — buffered, nothing to await
        return;
      }
      // THE critical line: the callback fires only after the flush RESOLVES.
      // Calling cb() before the work completes tells the stream we're ready
      // for more, which disables backpressure entirely.
      doFlush().then(() => cb(), cb);
    },

    // Runs once at end of input, before 'finish'. Without it the final
    // partial batch is silently discarded.
    final(cb) {
      doFlush().then(() => cb(), cb);
    },
  });
}

// --- Task 5 ------------------------------------------------------------------

export async function ingest(
  source: Readable,
  flush: (batch: unknown[]) => Promise<void>,
  options: IngestOptions = {},
): Promise<number> {
  const { batchSize = 100, maxLineLength = 1024 * 1024, onInvalid = "error", signal } = options;

  let count = 0;
  const counted = async (batch: unknown[]) => {
    await flush(batch);
    count += batch.length; // only count what was actually written
  };

  // pipeline gives us: backpressure between every stage, error propagation
  // from whichever stage fails, destruction of ALL streams on failure, and
  // AbortSignal support. Hand-wiring .pipe() would need all four written by
  // hand — see 04-pipeline.ts.
  await pipeline(
    source,
    createLineSplitter(maxLineLength),
    createNdjsonParser({ onInvalid }),
    createBatchWriter(batchSize, counted),
    signal ? { signal } : {},
  );

  return count;
}
