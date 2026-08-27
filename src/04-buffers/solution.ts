/**
 * SOLUTION 04 — reference implementation.
 */

import { timingSafeEqual } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import {
  type Frame,
  FrameType,
  HEADER_SIZE,
  MAGIC,
  MAX_PAYLOAD,
  ProtocolError,
  VERSION,
} from "./exercise.ts";

// --- Task 1 ------------------------------------------------------------------

export function hexdump(buf: Buffer): string {
  const lines: string[] = [];

  for (let offset = 0; offset < buf.length; offset += 16) {
    const row = buf.subarray(offset, offset + 16); // free — no copy

    let hex = "";
    for (let i = 0; i < 16; i++) {
      // Pad short final rows with spaces so the ASCII gutter stays aligned.
      hex += i < row.length ? row[i]!.toString(16).padStart(2, "0") + " " : "   ";
      // `hexdump -C` separates the two 8-byte groups AND closes the field with
      // an extra space, so the gutter starts at a fixed column 60.
      if (i === 7 || i === 15) hex += " ";
    }

    // Printable ASCII only. Everything else — control chars, high bytes, and
    // anything multi-byte — becomes '.'. That's the point: a hexdump shows
    // BYTES, so it must never try to decode.
    let ascii = "";
    for (const byte of row) {
      ascii += byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : ".";
    }

    lines.push(`${offset.toString(16).padStart(8, "0")}  ${hex}|${ascii}|`);
  }

  return lines.join("\n");
}

// --- Task 2 ------------------------------------------------------------------

export function checksum(payload: Buffer): number {
  let sum = 0;
  for (const byte of payload) sum += byte;
  // `>>> 0` is the unsigned 32-bit coercion. `| 0` and `<< 0` are SIGNED, so
  // any sum with the high bit set would come back negative — and then
  // writeUInt32BE would throw ERR_OUT_OF_RANGE. Classic JS bit-twiddling bug.
  return sum >>> 0;
}

// --- Task 3 ------------------------------------------------------------------

export function encodeFrame(type: FrameType, payload: Buffer): Buffer {
  // Validate BEFORE allocating — never let untrusted input size an allocation.
  if (payload.length > MAX_PAYLOAD) {
    throw new ProtocolError(`payload ${payload.length} exceeds max ${MAX_PAYLOAD}`);
  }

  // allocUnsafe is safe here precisely because we overwrite every byte below:
  // 14 header bytes written explicitly, then the full payload copied in.
  const frame = Buffer.allocUnsafe(HEADER_SIZE + payload.length);

  frame.write(MAGIC, 0, "ascii");
  frame.writeUInt8(VERSION, 4);
  frame.writeUInt8(type, 5);
  frame.writeUInt32BE(payload.length, 6);
  frame.writeUInt32BE(checksum(payload), 10);
  payload.copy(frame, HEADER_SIZE);

  return frame;
}

// --- Task 4 ------------------------------------------------------------------

function isFrameType(n: number): n is FrameType {
  return n === FrameType.TEXT || n === FrameType.BINARY;
}

export class FrameDecoder {
  // One growing buffer of unconsumed bytes. An array-of-chunks design is also
  // valid and avoids some copying, but it makes the "do I have 14 bytes yet?"
  // check much fiddlier. Start simple; optimise when a profile says to.
  #buffer: Buffer = Buffer.alloc(0);

  get pendingBytes(): number {
    return this.#buffer.length;
  }

  push(chunk: Buffer): Frame[] {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);

    const frames: Frame[] = [];
    let offset = 0;

    // Loop while progress is possible. Each pass either emits one frame or
    // decides it needs more bytes and stops.
    for (;;) {
      const available = this.#buffer.length - offset;
      if (available < HEADER_SIZE) break; // not even a full header yet

      const magic = this.#buffer.toString("ascii", offset, offset + 4);
      if (magic !== MAGIC) {
        throw new ProtocolError(`bad magic ${JSON.stringify(magic)} at offset ${offset}`);
      }

      const version = this.#buffer.readUInt8(offset + 4);
      if (version !== VERSION) throw new ProtocolError(`unsupported version ${version}`);

      const type = this.#buffer.readUInt8(offset + 5);
      if (!isFrameType(type)) throw new ProtocolError(`unknown frame type 0x${type.toString(16)}`);

      const length = this.#buffer.readUInt32BE(offset + 6);
      // Bound-check BEFORE trusting the length for anything. A malicious
      // 4-billion-byte length field must be rejected, not allocated.
      if (length > MAX_PAYLOAD) {
        throw new ProtocolError(`declared payload ${length} exceeds max ${MAX_PAYLOAD}`);
      }

      if (available < HEADER_SIZE + length) break; // header complete, payload isn't

      const expected = this.#buffer.readUInt32BE(offset + 10);
      const start = offset + HEADER_SIZE;

      // COPY the payload out. A subarray would share the decoder's internal
      // buffer, so (a) the caller could mutate our state and (b) holding one
      // small frame would retain every byte we ever buffered.
      const payload = Buffer.from(this.#buffer.subarray(start, start + length));

      const actual = checksum(payload);
      if (actual !== expected) {
        throw new ProtocolError(
          `checksum mismatch: expected ${expected.toString(16)}, got ${actual.toString(16)}`,
        );
      }

      frames.push({ type, payload });
      offset = start + length;
    }

    // Release what we consumed. Without this the buffer grows forever — the
    // decoder would be a memory leak on any long-lived connection.
    this.#buffer =
      offset === 0
        ? this.#buffer
        : offset === this.#buffer.length
          ? Buffer.alloc(0)
          : Buffer.from(this.#buffer.subarray(offset));

    return frames;
  }

  end(): void {
    if (this.#buffer.length > 0) {
      throw new ProtocolError(`stream ended with ${this.#buffer.length} bytes of a partial frame`);
    }
  }
}

// --- Task 5 ------------------------------------------------------------------

export function decodeText(frame: Frame): string {
  if (frame.type !== FrameType.TEXT) {
    throw new ProtocolError(`expected a TEXT frame, got 0x${frame.type.toString(16)}`);
  }
  return frame.payload.toString("utf8");
}

// --- Task 6 ------------------------------------------------------------------

export function safeEqual(a: Buffer, b: Buffer): boolean {
  // timingSafeEqual THROWS on a length mismatch, so check length first. The
  // early return is fine: buffer length is not the secret, the contents are.
  // (If length were secret, you'd hash both to a fixed width and compare those.)
  if (a.length !== b.length) return false;
  if (a.length === 0) return true; // timingSafeEqual is fine with 0, but be explicit
  return timingSafeEqual(a, b);
}

// --- Task 7 ------------------------------------------------------------------

export class TextFrameAssembler {
  // The whole point. A StringDecoder holds back an incomplete UTF-8 sequence
  // until the bytes that finish it arrive. Calling payload.toString() per
  // frame would emit U+FFFD for any character straddling a frame boundary —
  // and you'd only ever see it with non-ASCII text, in production.
  readonly #decoder = new StringDecoder("utf8");

  push(frame: Frame): string {
    if (frame.type !== FrameType.TEXT) {
      throw new ProtocolError(`expected a TEXT frame, got 0x${frame.type.toString(16)}`);
    }
    return this.#decoder.write(frame.payload);
  }

  end(): string {
    // Flushes any trailing partial sequence as U+FFFD — correct behaviour:
    // truncated input should be visible, not silently dropped.
    return this.#decoder.end();
  }
}
