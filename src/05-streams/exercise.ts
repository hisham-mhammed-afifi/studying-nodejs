/**
 * EXERCISE 05 — An NDJSON ingest pipeline
 *
 * You'll build the stages a real log/event ingester needs: split bytes into
 * lines (correctly), parse them into objects, guard against oversized input,
 * and write in batches with working backpressure.
 *
 * Check yourself:  node scripts/test.ts 05
 * Solution:        ./solution.ts   (try first!)
 */

import { Transform, Writable, type Readable } from "node:stream";

const TODO = (what: string): never => {
  throw new Error(`TODO: implement ${what}`);
};

export class StreamLimitError extends Error {
  override readonly name = "StreamLimitError";
}

export class ParseError extends Error {
  override readonly name = "ParseError";
  readonly line: number;
  constructor(message: string, line: number) {
    super(message);
    this.line = line;
  }
}

/**
 * TASK 1 — `createLineSplitter`
 *
 * A Transform: Buffers in, complete lines (strings) out, one per push.
 *
 * There are FOUR independent hazards here. Get all four:
 *
 *   a) A multi-byte CHARACTER may be split across chunks.
 *      → chunk.toString() per chunk corrupts it. Use a StringDecoder.
 *   b) A LINE may be split across chunks.
 *      → carry a remainder; the last piece of a chunk is incomplete.
 *   c) The final line may have NO trailing newline.
 *      → emit it from _flush, or you silently drop data.
 *   d) A malicious input may contain no newline at all.
 *      → if a line exceeds `maxLineLength`, destroy with a StreamLimitError
 *        rather than buffering forever.
 *        ⚠ Careful where you put this check. The limit is PER LINE. A chunk
 *        containing fifty short lines is fine even if the chunk itself is
 *        longer than the limit — what must be bounded is the unterminated
 *        remainder, since that is the part an attacker can grow.
 *
 * Also:
 *   - Handle both "\n" and "\r\n" (strip the \r).
 *   - Emit empty lines as "" — the NDJSON parser decides whether to skip them.
 *   - An empty input produces no lines.
 *   - A trailing newline does NOT produce a final empty line.
 *
 * @param maxLineLength bytes/chars a single line may reach before failing
 */
export function createLineSplitter(_maxLineLength = 1024 * 1024): Transform {
  return TODO("createLineSplitter");
}

export interface NdjsonOptions {
  /** Silently skip blank/whitespace-only lines. Default true. */
  skipEmpty?: boolean;
  /**
   * What to do with a line that isn't valid JSON.
   *  "error" (default) → destroy the stream with a ParseError
   *  "skip"            → drop the line and continue
   */
  onInvalid?: "error" | "skip";
}

/**
 * TASK 2 — `createNdjsonParser`
 *
 * A Transform: line strings in, parsed objects out.
 *
 * Requirements:
 *   - Object mode on the readable side.
 *   - Tracks a 1-based line NUMBER across the whole stream, and puts it on
 *     the ParseError. (Counting lines you skipped matters — the number must
 *     match the input file, not the number of successful parses.)
 *   - `skipEmpty` skips blank and whitespace-only lines by default.
 *   - `onInvalid: "skip"` continues past bad lines.
 *   - ⚠ A line that parses to `null` (JSON.parse("null") is legal!) must be
 *     treated as INVALID, per `onInvalid`. It must never be pushed: `null` is
 *     the object-mode EOF sentinel, so emitting it silently ENDS the stream
 *     and every later record disappears with no error. See 05-transforms.ts §5.
 */
export function createNdjsonParser(_options?: NdjsonOptions): Transform {
  return TODO("createNdjsonParser");
}

/**
 * TASK 3 — `collect`
 *
 * Read a whole stream into one Buffer, but refuse to exceed `maxBytes`.
 *
 * Requirements:
 *   - Throws StreamLimitError once the running total exceeds maxBytes.
 *   - DESTROYS the source when it bails, so the sender stops and the
 *     socket/fd is released. (Just throwing leaves it open.)
 *   - Does not use O(n²) concatenation (module 04 §7.1).
 *   - Works on an empty stream (→ a zero-length Buffer).
 */
export function collect(_source: Readable, _maxBytes: number): Promise<Buffer> {
  return TODO("collect");
}

/**
 * TASK 4 — `createBatchWriter`
 *
 * A Writable in object mode that groups items and calls `flush` per batch.
 *
 * Requirements:
 *   - Calls `flush(batch)` when the batch reaches `batchSize`.
 *   - Calls `flush` with the remainder at end of input — implement `_final`.
 *     Forgetting this silently drops the tail, which is the classic bug.
 *   - Waits for `flush` to resolve BEFORE calling the write callback. This
 *     is what makes backpressure work; call it early and the queue is
 *     unbounded.
 *   - A rejection from `flush` must destroy the stream with that error
 *     (pass it to the callback — never throw inside _write).
 *   - Never calls `flush` with an empty array.
 */
export function createBatchWriter<T>(
  _batchSize: number,
  _flush: (batch: T[]) => Promise<void>,
): Writable {
  return TODO("createBatchWriter");
}

/**
 * TASK 5 — `ingest`
 *
 * Wire it all together with `pipeline`:
 *
 *     source → lineSplitter → ndjsonParser → batchWriter
 *
 * Returns the number of records written. Must propagate errors from any
 * stage, and must honour `signal` for cancellation.
 */
export interface IngestOptions {
  batchSize?: number;
  maxLineLength?: number;
  onInvalid?: "error" | "skip";
  signal?: AbortSignal;
}

export function ingest(
  _source: Readable,
  _flush: (batch: unknown[]) => Promise<void>,
  _options?: IngestOptions,
): Promise<number> {
  return TODO("ingest");
}
