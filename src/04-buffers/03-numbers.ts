/**
 * 03 — Numbers and endianness
 *
 * Run:  node src/04-buffers/03-numbers.ts
 */

import os from "node:os";

console.log("=== 1. The same number, two byte orders ===");
{
  const b = Buffer.alloc(4);

  b.writeUInt32BE(0x12345678, 0);
  console.log("  writeUInt32BE(0x12345678) →", b.toString("hex"), "  most significant byte FIRST");

  b.writeUInt32LE(0x12345678, 0);
  console.log("  writeUInt32LE(0x12345678) →", b.toString("hex"), "  reversed");

  console.log("\n  this machine's native order:", os.endianness());
  console.log(`
  BE ("network byte order") is what TCP/IP, DNS, TLS, and most wire protocols use.
  LE is what x86, ARM, WASM, and most file formats use.

  ALWAYS be explicit. Code that assumes the host order works on your laptop
  and corrupts data the day it runs on different hardware — or, more commonly,
  the day someone feeds it a file written on different hardware.
`);
}

console.log("=== 2. The full read/write family ===");
{
  const b = Buffer.alloc(8);

  b.writeUInt8(255, 0);
  b.writeInt8(-1, 1);
  b.writeUInt16BE(0xabcd, 2);
  b.writeInt32BE(-2, 4);
  console.log("  packed:", b.toString("hex"));
  console.log("  readUInt8(0):   ", b.readUInt8(0));
  console.log("  readInt8(1):    ", b.readInt8(1), "  ← same byte 0xff, different interpretation");
  console.log("  readUInt16BE(2):", b.readUInt16BE(2).toString(16));
  console.log("  readInt32BE(4): ", b.readInt32BE(4));

  const f = Buffer.alloc(12);
  f.writeFloatBE(1.5, 0); // 4 bytes
  f.writeDoubleBE(Math.PI, 4); // 8 bytes
  console.log("  float 1.5:  ", f.toString("hex", 0, 4), "→", f.readFloatBE(0));
  console.log("  double π:   ", f.toString("hex", 4, 12), "→", f.readDoubleBE(4));

  // Floats are lossy — 0.1 cannot be represented exactly in 32 bits:
  const g = Buffer.alloc(4);
  g.writeFloatBE(0.1, 0);
  console.log("  float 0.1 round-trips to:", g.readFloatBE(0), "← use Double for precision");
}

console.log("\n=== 3. Ranges are enforced (good) ===");
{
  try {
    Buffer.alloc(1).writeUInt8(256, 0);
  } catch (err) {
    console.log("  writeUInt8(256):  ", (err as NodeJS.ErrnoException).code);
  }
  try {
    Buffer.alloc(1).writeInt8(128, 0);
  } catch (err) {
    console.log("  writeInt8(128):   ", (err as NodeJS.ErrnoException).code, "(int8 max is 127)");
  }
  try {
    Buffer.alloc(2).readUInt32BE(0);
  } catch (err) {
    console.log("  readUInt32BE on 2:", (err as NodeJS.ErrnoException).code);
  }
  console.log(`
  Throwing turns a silent corruption into a stack trace. When parsing
  UNTRUSTED input, bounds-check before reading — a malformed length field
  should give you a 400, not an uncaught exception that kills the process:

      if (offset + 4 > buf.length) throw new ProtocolError("truncated header");
      const len = buf.readUInt32BE(offset);
`);
}

console.log("=== 4. Beyond 2^53: BigInt ===");
{
  const b = Buffer.alloc(8);

  b.writeBigUInt64BE(2n ** 63n, 0);
  console.log("  2^63 as hex:  ", b.toString("hex"));
  console.log("  read back:    ", b.readBigUInt64BE(0));

  // Why you can't use a plain number:
  const big = 2 ** 53 + 1;
  console.log("  2^53 + 1 as a JS number:", big, "← wrong;", `2^53 === 2^53+1 is ${2 ** 53 === big}`);
  console.log("  as a BigInt:            ", 2n ** 53n + 1n, "✓");
  console.log(`
  Use the BigInt variants for: 64-bit database IDs (Twitter/Discord snowflakes),
  nanosecond timestamps, file offsets above 8 PB, and anything that came from
  a C int64. Converting through Number silently rounds.
`);
}

console.log("=== 5. A worked example: parsing a binary header ===");
{
  // A made-up 12-byte frame header, big-endian, as most wire formats are.
  //   magic:   4 bytes  "NODE"
  //   version: 1 byte
  //   type:    1 byte
  //   length:  2 bytes  (payload length)
  //   crc:     4 bytes
  const header = Buffer.alloc(12);
  header.write("NODE", 0, "ascii");
  header.writeUInt8(1, 4);
  header.writeUInt8(0x0a, 5);
  header.writeUInt16BE(1024, 6);
  header.writeUInt32BE(0xdeadbeef, 8);

  console.log("  encoded:", header.toString("hex"));

  // Decoding, with the bounds check you always need on untrusted input.
  function parseHeader(buf: Buffer) {
    if (buf.length < 12) throw new Error("truncated header");
    const magic = buf.toString("ascii", 0, 4);
    if (magic !== "NODE") throw new Error(`bad magic: ${JSON.stringify(magic)}`);
    return {
      magic,
      version: buf.readUInt8(4),
      type: buf.readUInt8(5),
      length: buf.readUInt16BE(6),
      crc: buf.readUInt32BE(8).toString(16),
    };
  }

  console.log("  decoded:", parseHeader(header));

  try {
    parseHeader(Buffer.from("XXXXnope1234"));
  } catch (err) {
    console.log("  rejects bad magic:", (err as Error).message);
  }
  try {
    parseHeader(Buffer.from("NODE"));
  } catch (err) {
    console.log("  rejects truncation:", (err as Error).message);
  }
  console.log(`
  That's the shape of every binary protocol parser: fixed-size header with a
  length field, then a variable payload. You'll build a full codec — framing,
  checksums, partial reads — in this module's exercise.
`);
}

console.log("=== 6. DataView, for comparison ===");
{
  // The web-standard alternative. Endianness is a per-call argument (and the
  // default is BIG-endian, the opposite of the TypedArray default).
  const ab = new ArrayBuffer(4);
  const dv = new DataView(ab);
  dv.setUint32(0, 0x12345678); // big-endian by default
  console.log("  DataView.setUint32 default:", Buffer.from(ab).toString("hex"));
  dv.setUint32(0, 0x12345678, true); // littleEndian = true
  console.log("  DataView.setUint32 LE:     ", Buffer.from(ab).toString("hex"));
  console.log(`
  Buffer's named methods (readUInt32BE) are more readable than DataView's
  boolean flag, and they're what Node code uses. Reach for DataView only in
  code that must also run in a browser.
`);
}
