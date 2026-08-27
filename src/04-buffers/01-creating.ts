/**
 * 01 — Creating buffers
 *
 * Run:  node src/04-buffers/01-creating.ts
 */

console.log("=== 1. Buffer IS a Uint8Array ===");
{
  const buf = Buffer.from("abc");
  console.log("  instanceof Uint8Array:", buf instanceof Uint8Array);
  console.log("  instanceof Buffer:    ", buf instanceof Buffer);
  console.log("  indexing:", buf[0], "| spread:", [...buf]);
  console.log("  length is BYTES:", buf.length);
  // Everything a Uint8Array can do works: map, filter, iteration, .set(), etc.
  console.log("  map:", [...buf.map((b) => b - 32)].join(","), "→", Buffer.from(buf.map((b) => b - 32)).toString());
}

console.log("\n=== 2. alloc vs allocUnsafe ===");
{
  const safe = Buffer.alloc(8);
  console.log("  alloc(8):      ", safe.toString("hex"), "← guaranteed zeros");

  const unsafe = Buffer.allocUnsafe(8);
  console.log("  allocUnsafe(8):", unsafe.toString("hex"), "← whatever was in memory");
  console.log(`
  In a fresh process this often LOOKS like zeros or harmless noise. In a
  long-running server it is fragments of previous requests: session tokens,
  decrypted payloads, other users' data. This is a real CVE class.

  Rule: allocUnsafe ONLY when you overwrite every byte before anyone reads it.
        When in doubt, alloc. Zeroing is cheap; a data leak is not.
`);

  // alloc can pre-fill with a byte, a string, or a buffer (which repeats):
  console.log("  alloc(4, 0xab): ", Buffer.alloc(4, 0xab).toString("hex"));
  console.log("  alloc(8, 'ab'): ", Buffer.alloc(8, "ab").toString(), "← the fill repeats");
}

console.log("\n=== 3. The 8KB pool ===");
{
  console.log("  Buffer.poolSize:", Buffer.poolSize);
  console.log("  allocUnsafe(10).byteOffset:  ", Buffer.allocUnsafe(10).byteOffset, "← carved out of the shared pool");
  console.log("  alloc(10).byteOffset:        ", Buffer.alloc(10).byteOffset, "← its own allocation");
  console.log("  allocUnsafe(8192).byteOffset:", Buffer.allocUnsafe(8192).byteOffset, "← too big to pool");
  console.log(`
  Buffers up to poolSize/2 (4KB) are carved out of a shared 8KB ArrayBuffer.
  That's why allocUnsafe is fast — no new allocation, just a bump pointer.
  It's also why several unrelated small buffers can live in ONE ArrayBuffer.
`);
}

console.log("=== 4. The .buffer trap ===");
{
  const buf = Buffer.from("hello");
  console.log("  buf.length:          ", buf.length);
  console.log("  buf.byteOffset:      ", buf.byteOffset);
  console.log("  buf.buffer.byteLength:", buf.buffer.byteLength, "← the WHOLE POOL, not your data");

  // ✗ This hands out 8KB of memory containing other buffers' contents.
  const wrong = new Uint8Array(buf.buffer);
  console.log("  new Uint8Array(buf.buffer).length:", wrong.length, "✗");

  // ✓ Slice with the offset to get exactly your bytes.
  const right = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  console.log("  properly extracted ArrayBuffer:   ", right.byteLength, "✓");
  console.log(`
  Anywhere you hand a raw ArrayBuffer to something that serialises it —
  worker.postMessage, a WASM module, a network write — passing buf.buffer
  can leak unrelated memory. Always slice with byteOffset/byteLength.
`);
}

console.log("=== 5. Buffer.from: what copies and what shares ===");
{
  const original = Buffer.from("abc");

  const fromBuffer = Buffer.from(original);
  fromBuffer[0] = 0x7a;
  console.log("  from(buffer) COPIES:  original still", JSON.stringify(original.toString()));

  const ab = new ArrayBuffer(4);
  const fromAb = Buffer.from(ab);
  fromAb[0] = 1;
  console.log("  from(arrayBuffer) SHARES:", new Uint8Array(ab)[0] === 1);

  // The three-argument form gives you a view over part of an ArrayBuffer:
  const partial = Buffer.from(ab, 1, 2);
  console.log("  from(ab, 1, 2) → length", partial.length, "at offset", partial.byteOffset);

  console.log(`
  copies:  from(string), from(array), from(buffer)
  shares:  from(arrayBuffer), from(arrayBuffer, offset, length)

  The asymmetry is deliberate: an ArrayBuffer is already raw memory someone
  else owns, so Node assumes you want a view, not a duplicate.
`);
}

console.log("=== 6. Which constructor for which job ===");
console.log(`
  Buffer.alloc(n)            default choice. Zeroed, safe, obvious.
  Buffer.alloc(n, fill)      when you want a known pattern.
  Buffer.allocUnsafe(n)      ONLY with immediate full overwrite.
  Buffer.from(str, enc)      parsing text/hex/base64 input.
  Buffer.from(arr)           small literal byte sequences: magic numbers, headers.
  Buffer.concat(chunks)      joining collected stream chunks — once, at the end.

  Never:  new Buffer(...)    deprecated since Node 6. It changes behaviour based
                             on argument TYPE, which caused the 2018 "Buffer
                             constructor" security advisories.
`);
