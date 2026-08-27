/**
 * 04 — Views, sharing, copying, comparing
 *
 * Run:  node src/04-buffers/04-views.ts
 */

import { timingSafeEqual, randomBytes } from "node:crypto";

console.log("=== 1. subarray SHARES memory ===");
{
  const b = Buffer.from("hello world");
  const view = b.subarray(0, 5);

  view[0] = 0x48; // 'H'
  console.log("  mutated the view →", JSON.stringify(b.toString()), "← the ORIGINAL changed");
  console.log("  same ArrayBuffer:", view.buffer === b.buffer);
}

console.log("\n=== 2. buf.slice() is NOT Array.prototype.slice ===");
{
  const b = Buffer.from("hello");
  // On arrays, slice copies. On Buffers, slice is a deprecated ALIAS for
  // subarray — it shares. This surprises everyone exactly once.
  const s = b.slice(0, 3);
  s[0] = 0x58; // 'X'
  console.log("  buf.slice() shared:", JSON.stringify(b.toString()), "✗ probably not what you expected");

  // The TypedArray slice DOES copy — you have to call it explicitly:
  const b2 = Buffer.from("hello");
  const copy = Uint8Array.prototype.slice.call(b2, 0, 3) as Uint8Array;
  copy[0] = 0x58;
  console.log("  TypedArray slice copied:", JSON.stringify(b2.toString()), "✓");

  console.log(`
  Use:
      buf.subarray(a, b)              share, and say so
      Buffer.from(buf.subarray(a, b)) an explicit copy
      buf.slice(a, b)                 deprecated — don't
`);
}

console.log("=== 3. Views retain the WHOLE allocation ===");
{
  const big = Buffer.alloc(10 * 1024 * 1024, 1); // 10MB
  const tiny = big.subarray(0, 10); // 10 bytes... or is it?

  console.log("  tiny.length:            ", tiny.length);
  console.log("  tiny.buffer.byteLength: ", (tiny.buffer.byteLength / 1024 / 1024).toFixed(0) + "MB", "← still alive");
  console.log(`
  As long as \`tiny\` is reachable, the entire 10MB cannot be garbage
  collected. This is a classic slow leak: parse a large upload, keep a small
  header slice in a cache, and every cached entry pins its whole upload.

  Fix: copy when you intend to RETAIN.
      cache.set(key, Buffer.from(big.subarray(0, 10)));   // 10 bytes, truly
`);
  const detached = Buffer.from(tiny);
  console.log("  Buffer.from(view).buffer.byteLength:", detached.buffer.byteLength, "bytes ✓");
}

console.log("=== 4. Copying and concatenating ===");
{
  const src = Buffer.from("hello world");
  const dst = Buffer.alloc(5);

  const copied = src.copy(dst, 0, 6, 11); // → dst, at 0, from src[6..11]
  console.log("  src.copy(dst, 0, 6, 11):", copied, "bytes →", JSON.stringify(dst.toString()));

  // .set() is the TypedArray-standard equivalent
  const dst2 = Buffer.alloc(5);
  dst2.set(src.subarray(0, 5), 0);
  console.log("  dst.set(view, 0):        ", JSON.stringify(dst2.toString()));

  console.log("  concat:            ", JSON.stringify(Buffer.concat([Buffer.from("ab"), Buffer.from("cd")]).toString()));
  console.log("  concat with length 3:", JSON.stringify(Buffer.concat([Buffer.from("ab"), Buffer.from("cd")], 3).toString()), "← truncated");
  console.log("  concat with length 6:", JSON.stringify(Buffer.concat([Buffer.from("ab"), Buffer.from("cd")], 6).toString().replace(/\0/g, "\\0")), "← zero-padded");
  console.log(`
  Passing the total length lets Node skip a pass to compute it. Worth doing
  in hot paths where you already track the running total.
`);
}

console.log("=== 5. Searching bytes ===");
{
  const http = Buffer.from("GET / HTTP/1.1\r\nHost: x\r\n\r\nbody here");

  const headerEnd = http.indexOf("\r\n\r\n");
  console.log("  indexOf('\\r\\n\\r\\n'):", headerEnd, "← exactly how an HTTP parser finds the body");
  console.log("  headers:", JSON.stringify(http.toString("ascii", 0, headerEnd)));
  console.log("  body:   ", JSON.stringify(http.toString("utf8", headerEnd + 4)));

  console.log("  indexOf(byte 0x0a):", http.indexOf(0x0a), "| lastIndexOf:", http.lastIndexOf(0x0a));
  console.log("  includes('Host'):  ", http.includes("Host"));
  console.log(`
  Searching the BYTES is much cheaper than buf.toString().indexOf(...) —
  the string argument is encoded once, and the 50MB haystack is never
  converted. On large payloads this is the difference between microseconds
  and hundreds of milliseconds of blocked event loop.
`);
}

console.log("=== 6. Comparing ===");
{
  console.log("  equals:      ", Buffer.from("ab").equals(Buffer.from("ab")));
  console.log("  compare a,b: ", Buffer.compare(Buffer.from("a"), Buffer.from("b")), "(-1 = first sorts earlier)");

  const sorted = [Buffer.from("c"), Buffer.from("a"), Buffer.from("b")].sort(Buffer.compare);
  console.log("  sorted:      ", sorted.map((b) => b.toString()).join(","));
}

console.log("\n=== 7. ⚠ Never use equals() on secrets ===");
{
  const real = randomBytes(32);
  const guess = Buffer.from(real);
  // `noUncheckedIndexedAccess` makes TS treat every index read as possibly
  // undefined — hence the explicit read rather than `guess[31] ^= 1`.
  guess[31] = (guess[31] ?? 0) ^ 1; // differs only in the LAST byte

  console.log("  equals() returns as soon as it finds a difference, so a guess");
  console.log("  that shares more leading bytes takes measurably longer. That");
  console.log("  leak lets an attacker recover a token one byte at a time.");
  console.log("");
  console.log("  real.equals(guess):        ", real.equals(guess), "  ✗ timing-variable");
  console.log("  timingSafeEqual(real,guess):", timingSafeEqual(real, guess), "  ✓ constant time");

  try {
    timingSafeEqual(real, Buffer.from("short"));
  } catch (err) {
    console.log("  length mismatch throws:    ", (err as NodeJS.ErrnoException).code);
  }

  console.log(`
  So the safe comparison is:

      import { timingSafeEqual } from "node:crypto";

      function safeEqual(a: Buffer, b: Buffer): boolean {
        return a.length === b.length && timingSafeEqual(a, b);
      }

  The length check is required (timingSafeEqual throws otherwise) and is
  normally fine — token length is not secret. If it IS secret, hash both
  sides to a fixed width first and compare the digests.

  Applies to: API keys, session tokens, HMAC signatures, webhook secrets,
  password reset tokens, CSRF tokens. Anything an attacker can retry.
`);
}
