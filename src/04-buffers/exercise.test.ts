/**
 *   node scripts/test.ts 04
 *   node scripts/test.ts --solutions 04
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { type Frame, FrameType, HEADER_SIZE, MAX_PAYLOAD, ProtocolError } from "./exercise.ts";

const modulePath = process.env["IMPL"] === "solution" ? "./solution.ts" : "./exercise.ts";

type Impl = {
  hexdump(buf: Buffer): string;
  checksum(payload: Buffer): number;
  encodeFrame(type: FrameType, payload: Buffer): Buffer;
  FrameDecoder: new () => {
    readonly pendingBytes: number;
    push(chunk: Buffer): Frame[];
    end(): void;
  };
  decodeText(frame: Frame): string;
  safeEqual(a: Buffer, b: Buffer): boolean;
  TextFrameAssembler: new () => { push(frame: Frame): string; end(): string };
};

let impl: Impl;
before(async () => {
  impl = (await import(modulePath)) as unknown as Impl;
});

describe("hexdump", () => {
  it("formats a short buffer", () => {
    const out = impl.hexdump(Buffer.from("hello"));
    assert.equal(out, "00000000  68 65 6c 6c 6f                                    |hello|");
  });

  it("formats exactly 16 bytes on one line", () => {
    const out = impl.hexdump(Buffer.from("0123456789abcdef"));
    assert.equal(out, "00000000  30 31 32 33 34 35 36 37  38 39 61 62 63 64 65 66  |0123456789abcdef|");
  });

  it("wraps at 16 bytes and advances the offset", () => {
    const lines = impl.hexdump(Buffer.from("0123456789abcdefXY")).split("\n");
    assert.equal(lines.length, 2);
    assert.ok(lines[0]!.startsWith("00000000  "));
    assert.ok(lines[1]!.startsWith("00000010  "), `second line offset wrong: ${lines[1]}`);
    assert.ok(lines[1]!.endsWith("|XY|"));
  });

  it("replaces non-printable bytes with '.'", () => {
    const out = impl.hexdump(Buffer.from([0x00, 0x1f, 0x41, 0x7e, 0x7f, 0xff]));
    assert.ok(out.endsWith("|..A~..|"), `got ${JSON.stringify(out)}`);
  });

  it("pads a short line so the gutter aligns", () => {
    const lines = impl.hexdump(Buffer.concat([Buffer.alloc(16, 0x41), Buffer.from("z")])).split("\n");
    const gutter0 = lines[0]!.indexOf("|");
    const gutter1 = lines[1]!.indexOf("|");
    assert.equal(gutter0, gutter1, "the | columns must line up between full and short lines");
  });

  it("returns an empty string for an empty buffer", () => {
    assert.equal(impl.hexdump(Buffer.alloc(0)), "");
  });

  it("has no trailing newline", () => {
    assert.ok(!impl.hexdump(Buffer.alloc(40)).endsWith("\n"));
  });
});

describe("checksum", () => {
  it("sums the bytes", () => {
    assert.equal(impl.checksum(Buffer.from([1, 2, 3])), 6);
  });

  it("is 0 for an empty payload", () => {
    assert.equal(impl.checksum(Buffer.alloc(0)), 0);
  });

  it("returns an UNSIGNED 32-bit value for large sums", () => {
    // 20M bytes of 0xff sums to ~5.1e9, which overflows int32 and wraps.
    const big = Buffer.alloc(20_000_000, 0xff);
    const sum = impl.checksum(big);
    assert.ok(sum >= 0, `checksum must be unsigned, got ${sum}`);
    assert.ok(sum < 2 ** 32, `checksum must fit in uint32, got ${sum}`);
    assert.equal(sum, (20_000_000 * 255) >>> 0);
  });
});

describe("encodeFrame", () => {
  it("produces a correctly laid out frame", () => {
    const payload = Buffer.from("hello");
    const frame = impl.encodeFrame(FrameType.TEXT, payload);

    assert.equal(frame.length, HEADER_SIZE + payload.length);
    assert.equal(frame.toString("ascii", 0, 4), "NODE");
    assert.equal(frame.readUInt8(4), 1, "version");
    assert.equal(frame.readUInt8(5), FrameType.TEXT);
    assert.equal(frame.readUInt32BE(6), payload.length);
    assert.equal(frame.readUInt32BE(10), impl.checksum(payload));
    assert.deepEqual(frame.subarray(HEADER_SIZE), payload);
  });

  it("uses BIG-endian for the length", () => {
    const frame = impl.encodeFrame(FrameType.BINARY, Buffer.alloc(258));
    assert.equal(frame.toString("hex", 6, 10), "00000102", "length must be big-endian");
  });

  it("handles an empty payload", () => {
    const frame = impl.encodeFrame(FrameType.TEXT, Buffer.alloc(0));
    assert.equal(frame.length, HEADER_SIZE);
    assert.equal(frame.readUInt32BE(6), 0);
  });

  it("rejects an oversized payload", () => {
    assert.throws(() => impl.encodeFrame(FrameType.TEXT, Buffer.alloc(MAX_PAYLOAD + 1)), ProtocolError);
  });
});

describe("FrameDecoder", () => {
  const text = (s: string) => impl.encodeFrame(FrameType.TEXT, Buffer.from(s));

  it("decodes one whole frame", () => {
    const d = new impl.FrameDecoder();
    const frames = d.push(text("hello"));
    assert.equal(frames.length, 1);
    assert.equal(frames[0]!.type, FrameType.TEXT);
    assert.equal(frames[0]!.payload.toString(), "hello");
    assert.equal(d.pendingBytes, 0);
  });

  it("decodes several frames from one chunk", () => {
    const d = new impl.FrameDecoder();
    const frames = d.push(Buffer.concat([text("one"), text("two"), text("three")]));
    assert.deepEqual(frames.map((f) => f.payload.toString()), ["one", "two", "three"]);
  });

  it("handles a payload split across chunks", () => {
    const d = new impl.FrameDecoder();
    const frame = text("hello world");
    assert.deepEqual(d.push(frame.subarray(0, 18)), []);
    const frames = d.push(frame.subarray(18));
    assert.equal(frames.length, 1);
    assert.equal(frames[0]!.payload.toString(), "hello world");
  });

  it("handles a HEADER split across chunks", () => {
    const d = new impl.FrameDecoder();
    const frame = text("hi");
    assert.deepEqual(d.push(frame.subarray(0, 3)), [], "3 bytes is not a header");
    assert.deepEqual(d.push(frame.subarray(3, 9)), []);
    const frames = d.push(frame.subarray(9));
    assert.equal(frames.length, 1);
    assert.equal(frames[0]!.payload.toString(), "hi");
  });

  it("survives byte-at-a-time delivery", () => {
    const d = new impl.FrameDecoder();
    const wire = Buffer.concat([text("alpha"), text("beta"), text("gamma")]);
    const out: Frame[] = [];
    for (const byte of wire) out.push(...d.push(Buffer.from([byte])));
    d.end();
    assert.deepEqual(out.map((f) => f.payload.toString()), ["alpha", "beta", "gamma"]);
  });

  it("handles a chunk containing the tail of one frame and the head of the next", () => {
    const d = new impl.FrameDecoder();
    const wire = Buffer.concat([text("first"), text("second")]);
    const cut = HEADER_SIZE + 3; // mid-payload of frame 1
    assert.deepEqual(d.push(wire.subarray(0, cut)), []);
    const frames = d.push(wire.subarray(cut));
    assert.deepEqual(frames.map((f) => f.payload.toString()), ["first", "second"]);
  });

  it("decodes an empty payload", () => {
    const d = new impl.FrameDecoder();
    const frames = d.push(impl.encodeFrame(FrameType.BINARY, Buffer.alloc(0)));
    assert.equal(frames.length, 1);
    assert.equal(frames[0]!.payload.length, 0);
  });

  it("round-trips random binary", () => {
    const d = new impl.FrameDecoder();
    const payload = randomBytes(5000);
    const frames = d.push(impl.encodeFrame(FrameType.BINARY, payload));
    assert.ok(frames[0]!.payload.equals(payload));
  });

  it("reports pendingBytes for a partial frame", () => {
    const d = new impl.FrameDecoder();
    d.push(text("hello").subarray(0, 10));
    assert.equal(d.pendingBytes, 10);
  });

  it("releases consumed bytes (no unbounded growth)", () => {
    const d = new impl.FrameDecoder();
    for (let i = 0; i < 500; i++) d.push(text("payload data here"));
    assert.equal(d.pendingBytes, 0, "buffer was not drained after complete frames");
  });

  it("returns payloads that do not alias the internal buffer", () => {
    const d = new impl.FrameDecoder();
    const frames = d.push(Buffer.concat([text("aaaa"), text("bbbb")]));
    const first = frames[0]!.payload;
    d.push(text("cccc")); // more traffic through the decoder
    assert.equal(first.toString(), "aaaa", "an earlier payload was corrupted by later pushes");
  });

  it("rejects a bad magic", () => {
    const d = new impl.FrameDecoder();
    const bad = text("x");
    bad.write("XXXX", 0, "ascii");
    assert.throws(() => d.push(bad), ProtocolError);
  });

  it("rejects an unknown version", () => {
    const d = new impl.FrameDecoder();
    const bad = text("x");
    bad.writeUInt8(99, 4);
    assert.throws(() => d.push(bad), ProtocolError);
  });

  it("rejects an unknown frame type", () => {
    const d = new impl.FrameDecoder();
    const bad = text("x");
    bad.writeUInt8(0x7f, 5);
    assert.throws(() => d.push(bad), ProtocolError);
  });

  it("rejects a checksum mismatch", () => {
    const d = new impl.FrameDecoder();
    const bad = text("hello");
    bad[HEADER_SIZE] = bad[HEADER_SIZE]! ^ 0xff; // corrupt one payload byte
    assert.throws(() => d.push(bad), ProtocolError);
  });

  it("rejects an absurd declared length WITHOUT allocating it", () => {
    const d = new impl.FrameDecoder();
    const bad = Buffer.alloc(HEADER_SIZE);
    bad.write("NODE", 0, "ascii");
    bad.writeUInt8(1, 4);
    bad.writeUInt8(FrameType.BINARY, 5);
    bad.writeUInt32BE(0xffffffff, 6); // 4 GB
    assert.throws(() => d.push(bad), ProtocolError);
  });

  it("end() throws on a partial frame", () => {
    const d = new impl.FrameDecoder();
    d.push(text("hello").subarray(0, 8));
    assert.throws(() => d.end(), ProtocolError);
  });

  it("end() is fine on a frame boundary", () => {
    const d = new impl.FrameDecoder();
    d.push(text("hello"));
    d.end();
  });
});

describe("decodeText", () => {
  it("decodes a TEXT payload", () => {
    assert.equal(impl.decodeText({ type: FrameType.TEXT, payload: Buffer.from("héllo") }), "héllo");
  });

  it("rejects a BINARY frame", () => {
    assert.throws(() => impl.decodeText({ type: FrameType.BINARY, payload: Buffer.alloc(1) }), ProtocolError);
  });
});

describe("safeEqual", () => {
  it("is true for identical buffers", () => {
    assert.equal(impl.safeEqual(Buffer.from("secret"), Buffer.from("secret")), true);
  });

  it("is false when contents differ", () => {
    assert.equal(impl.safeEqual(Buffer.from("secret"), Buffer.from("secreT")), false);
  });

  it("returns false — not throws — on a length mismatch", () => {
    assert.equal(impl.safeEqual(Buffer.from("abc"), Buffer.from("abcd")), false);
  });

  it("handles empty buffers", () => {
    assert.equal(impl.safeEqual(Buffer.alloc(0), Buffer.alloc(0)), true);
  });

  it("works on 32-byte tokens", () => {
    const a = randomBytes(32);
    const b = Buffer.from(a);
    assert.equal(impl.safeEqual(a, b), true);
    b[31] = b[31]! ^ 1;
    assert.equal(impl.safeEqual(a, b), false);
  });
});

describe("TextFrameAssembler", () => {
  it("reassembles a message split across frames", () => {
    const a = new impl.TextFrameAssembler();
    let out = "";
    for (const s of ["hello ", "world", "!"]) {
      out += a.push({ type: FrameType.TEXT, payload: Buffer.from(s) });
    }
    out += a.end();
    assert.equal(out, "hello world!");
  });

  it("does not corrupt a character split across frames", () => {
    const full = Buffer.from("héllo 😀 wörld");
    const a = new impl.TextFrameAssembler();
    let out = "";
    // Split mid-emoji — the exact case that produces U+FFFD if you call
    // payload.toString() per frame.
    out += a.push({ type: FrameType.TEXT, payload: full.subarray(0, 8) });
    out += a.push({ type: FrameType.TEXT, payload: full.subarray(8) });
    out += a.end();
    assert.equal(out, "héllo 😀 wörld");
    assert.ok(!out.includes("�"), "replacement characters found — decode per frame?");
  });

  it("survives byte-at-a-time frames", () => {
    const full = Buffer.from("日本語のテキスト 😀");
    const a = new impl.TextFrameAssembler();
    let out = "";
    for (const byte of full) {
      out += a.push({ type: FrameType.TEXT, payload: Buffer.from([byte]) });
    }
    out += a.end();
    assert.equal(out, "日本語のテキスト 😀");
  });

  it("rejects a BINARY frame", () => {
    const a = new impl.TextFrameAssembler();
    assert.throws(() => a.push({ type: FrameType.BINARY, payload: Buffer.alloc(1) }), ProtocolError);
  });
});
