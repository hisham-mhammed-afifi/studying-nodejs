# 04 — Buffers & Binary Data

JavaScript had no way to represent raw bytes until `ArrayBuffer` arrived in 2011. Node needed one in 2009, so it invented `Buffer` — and kept it, because it's genuinely more ergonomic than the standard types for what servers do.

Every byte that enters or leaves your process is a `Buffer`: file contents, socket data, HTTP bodies, crypto output, compressed data. Understanding it is a prerequisite for streams (module 05).

---

## 1. `Buffer` *is* a `Uint8Array`

```ts
Buffer.alloc(4) instanceof Uint8Array;   // true
Buffer.alloc(4) instanceof Buffer;       // true
```

It's a subclass. Everything a `Uint8Array` can do, a `Buffer` can do — indexing, `map`, `forEach`, `Symbol.iterator`, spread. Node adds encoding-aware methods on top.

```ts
const buf = Buffer.from("abc");
buf[0];              // 97
buf.length;          // 3   — BYTES, not characters
[...buf];            // [97, 98, 99]
Array.from(buf);     // [97, 98, 99]
```

Because it's a `Uint8Array`, it works anywhere the web-standard APIs are expected:

```ts
await fetch(url, { method: "POST", body: buf });   // ✓
new Blob([buf]);                                    // ✓
crypto.subtle.digest("SHA-256", buf);               // ✓
```

### 1.1 The three-layer model

This is the part that causes the most confusion. There are three distinct things:

```
ArrayBuffer        the raw memory block          (no way to read it directly)
  └─ TypedArray    a typed VIEW over a region    (Uint8Array, Float64Array, …)
       └─ Buffer   a Uint8Array with extras      (encodings, read/write helpers)
```

A view has three properties describing its window into the memory:

```ts
const buf = Buffer.from("hello");
buf.buffer.byteLength;   // 8192  ← the underlying pool, NOT your data
buf.byteOffset;          // e.g. 8 — where your data starts inside it
buf.byteLength;          // 5     — how much is yours
```

**This is a real trap.** `buf.buffer` is not "your bytes as an ArrayBuffer":

```ts
// ✗ gives you the whole 8KB pool, including other buffers' data
new Uint8Array(buf.buffer);

// ✓ extracts exactly your bytes, as a copy
buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
```

Handing `buf.buffer` to something that serialises it (a worker `postMessage`, a WASM module, a network call) can leak unrelated memory contents. Always slice with the offset.

---

## 2. Creating buffers

| | Behaviour |
|---|---|
| `Buffer.alloc(n)` | zero-filled. **Safe.** Slower for large `n`. |
| `Buffer.alloc(n, fill)` | filled with a byte, string, or buffer |
| `Buffer.allocUnsafe(n)` | **not** zeroed — contains whatever was in memory |
| `Buffer.from(...)` | from a string, array, ArrayBuffer, or another buffer |

```ts
Buffer.alloc(4);                    // <Buffer 00 00 00 00>
Buffer.alloc(4, 0xab);              // <Buffer ab ab ab ab>
Buffer.alloc(8, "ab");              // <Buffer 61 62 61 62 61 62 61 62>  (repeats)
Buffer.from("hi");                  // <Buffer 68 69>          (utf8 by default)
Buffer.from("6869", "hex");         // <Buffer 68 69>
Buffer.from([104, 105]);            // <Buffer 68 69>
Buffer.from(existingBuf);           // a COPY
```

### 2.1 `allocUnsafe` is genuinely unsafe

```ts
const b = Buffer.allocUnsafe(1024);
console.log(b.toString("hex"));
// Whatever happened to be in that memory: fragments of previous requests,
// decrypted tokens, other users' data. This has been a real CVE class.
```

Use it only when you will **immediately and completely overwrite** every byte:

```ts
// ✓ fine — every byte is written before anyone reads it
const out = Buffer.allocUnsafe(len);
source.copy(out, 0, start, start + len);

// ✗ never — you're returning uninitialised memory
const out = Buffer.allocUnsafe(len);
if (someCondition) out.write(data);
return out;
```

When in doubt, `alloc`. The zeroing cost is tiny compared to a data leak.

### 2.2 The pool

`allocUnsafe` is fast partly because small buffers come from a shared 8KB pool:

```ts
Buffer.poolSize;                        // 8192
Buffer.allocUnsafe(10).byteOffset;      // 8    ← carved out of the pool
Buffer.alloc(10).byteOffset;            // 0    ← its own allocation
Buffer.allocUnsafe(8192).byteOffset;    // 0    ← too big for the pool
```

Buffers ≤ `poolSize / 2` (4KB) get pooled. This is why many small `allocUnsafe` buffers can share one `ArrayBuffer` — and another reason never to pass `buf.buffer` around.

### 2.3 `Buffer.from` and shared memory

```ts
Buffer.from("hi");           // copies (strings are immutable anyway)
Buffer.from([1, 2, 3]);      // copies
Buffer.from(otherBuffer);    // COPIES
Buffer.from(arrayBuffer);    // SHARES — no copy, mutations are visible both ways
```

That last one is the odd one out:

```ts
const ab = new ArrayBuffer(4);
const view = Buffer.from(ab);
view[0] = 1;
new Uint8Array(ab)[0];       // 1 — same memory
```

---

## 3. Encodings

```ts ignore
buf.toString(encoding?, start?, end?)
Buffer.from(str, encoding?)
Buffer.byteLength(str, encoding?)
```

| Encoding | Notes |
|---|---|
| `utf8` | **default.** Variable width, 1–4 bytes per character |
| `hex` | 2 chars per byte. Doubles size |
| `base64` | 4 chars per 3 bytes. ~33% larger |
| `base64url` | base64 with `-_` and no `=` padding — safe in URLs and JWTs |
| `latin1` / `binary` | 1 byte ↔ 1 char, lossless for bytes 0–255 |
| `ascii` | 7-bit; **strips the high bit** — lossy, avoid |
| `utf16le` / `ucs2` | 2 or 4 bytes per character; what JS strings are internally |

```ts
const b = Buffer.from("hi there?~");
b.toString("hex");        // "68692074686572653f7e"
b.toString("base64");     // "aGkgdGhlcmU/fg=="
b.toString("base64url");  // "aGkgdGhlcmU_fg"     ← / → _,  no padding
```

### 3.1 `.length` vs `Buffer.byteLength`

```ts
"héllo".length;                   // 5  — UTF-16 code units
Buffer.byteLength("héllo");       // 6  — UTF-8 bytes
Buffer.from("héllo").length;      // 6
```

Never size a buffer from a string's `.length`. For `Content-Length` headers, size limits, and column widths you want `Buffer.byteLength`.

```ts
res.setHeader("Content-Length", Buffer.byteLength(body));   // ✓
res.setHeader("Content-Length", body.length);              // ✗ wrong for non-ASCII
```

### 3.2 Decoding is lenient — silently

Node never throws on malformed input. It substitutes U+FFFD (`�`):

```ts
Buffer.from([0xff]).toString("utf8");   // "�"  — no error
```

Base64 decoding is worse — it ignores anything that isn't a base64 character:

```ts
Buffer.from("!!!not base64!!!", "base64").toString("hex");   // "9e8b5b6ac7ba"
```

No error, and you get *garbage that looks like data*. If input validity matters, verify explicitly:

```ts
function decodeBase64Strict(s: string): Buffer {
  const buf = Buffer.from(s, "base64");
  if (buf.toString("base64") !== s.replace(/=+$/, "").padEnd(s.length, "=")) {
    throw new Error("invalid base64");
  }
  return buf;
}
```

Or use `TextDecoder` with `fatal: true`, which *does* throw:

```ts
new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from([0xff]));
// ✗ TypeError: The encoded data was not valid for encoding utf-8
```

### 3.3 `write` truncates silently

```ts
const small = Buffer.alloc(3);
const written = small.write("hello");   // 3
small.toString();                        // "hel"
```

`write` returns the number of bytes written. **Check it** if truncation matters — and note it will not split a multi-byte character, so you can get fewer bytes than you'd expect.

### 3.4 `latin1` is the byte-preserving encoding

When you need a lossless string ↔ byte round trip (legacy protocols, binary in a JSON field):

```ts
Buffer.from([0xff]).toString("latin1").charCodeAt(0);   // 255  ✓ lossless
Buffer.from([0xff]).toString("utf8");                    // "�"  ✗ lossy
Buffer.from([0xff]).toString("ascii").charCodeAt(0);     // 127  ✗ high bit stripped
```

---

## 4. Numbers and endianness

Buffers store numbers in a byte order you must choose:

```ts
const b = Buffer.alloc(4);

b.writeUInt32BE(0x12345678, 0);
b.toString("hex");            // "12345678"   ← big-endian: most significant first

b.writeUInt32LE(0x12345678, 0);
b.toString("hex");            // "78563412"   ← little-endian: reversed
```

The full family:

```ts ignore
b.readUInt8(offset);       b.writeUInt8(v, offset);
b.readInt16BE / LE         b.writeInt16BE / LE
b.readUInt32BE / LE        b.writeUInt32BE / LE
b.readBigInt64BE / LE      b.writeBigInt64BE / LE     // returns/takes BigInt
b.readFloatBE / LE         b.writeFloatBE / LE        // 4 bytes
b.readDoubleBE / LE        b.writeDoubleBE / LE       // 8 bytes
```

### 4.1 Which one do you use?

| Context | Byte order |
|---|---|
| Network protocols, TCP/IP, DNS, TLS | **Big-endian** ("network byte order") |
| x86, ARM, most file formats, WASM | **Little-endian** |
| Your machine right now | `os.endianness()` — almost certainly `"LE"` |

**Always be explicit.** Code that relies on the host order breaks the day it runs somewhere else.

### 4.2 Ranges are enforced

```ts
Buffer.alloc(1).writeUInt8(256, 0);     // ✗ ERR_OUT_OF_RANGE
Buffer.alloc(2).readUInt32BE(0);        // ✗ ERR_BUFFER_OUT_OF_BOUNDS
```

Both throw, which is good — it turns a silent corruption into a stack trace. Wrap parsing of untrusted input in `try`/`catch`, or bounds-check first.

### 4.3 Beyond 2^53 — use BigInt

```ts
const b = Buffer.alloc(8);
b.writeBigUInt64BE(2n ** 63n, 0);
b.toString("hex");                 // "8000000000000000"
b.readBigUInt64BE(0);              // 9223372036854775808n
```

A JS `number` cannot represent all 64-bit integers exactly. For database IDs, timestamps in nanoseconds, or file offsets, use the BigInt variants.

---

## 5. Views, slicing, and shared memory

### 5.1 `subarray` shares; `Uint8Array.slice` copies

```ts
const b = Buffer.from("hello world");

const view = b.subarray(0, 5);
view[0] = 72;
b.toString();                          // "Hello world"  ← the ORIGINAL changed

const copy = Uint8Array.prototype.slice.call(b, 0, 5);
copy[0] = 90;
b.toString();                          // "Hello world"  ← unchanged
```

⚠ **`buf.slice()` is NOT `Array.prototype.slice`.** On a Buffer it's a deprecated alias for `subarray` — it *shares* memory. This surprises everyone who learned `slice` from arrays.

```ts
b.slice(0, 5);       // ✗ shares (deprecated — don't use on Buffers)
b.subarray(0, 5);    // ✓ shares, and says so
Buffer.from(b.subarray(0, 5));   // ✓ an explicit copy
```

Sharing is usually what you want — it's free, and it's how streams avoid copying megabytes. But it means:

- Keeping a small `subarray` of a large buffer **retains the whole allocation**. Copy if you're holding it long-term.
- Passing a subarray to code that mutates in place will corrupt the parent.

### 5.2 Copying explicitly

```ts ignore
source.copy(target, targetStart?, sourceStart?, sourceEnd?);   // returns bytes copied
target.set(source, targetOffset);                              // TypedArray standard
Buffer.from(source);                                           // whole-buffer copy
Buffer.concat([a, b], totalLength?);                           // always allocates
```

`Buffer.concat`'s second argument truncates or zero-pads:

```ts
Buffer.concat([Buffer.from("ab"), Buffer.from("cd")]);       // "abcd"
Buffer.concat([Buffer.from("ab"), Buffer.from("cd")], 3);    // "abc"
```

Passing the total length when you know it lets Node skip a pass to compute it — worth it in hot loops.

### 5.3 Searching and comparing

```ts
Buffer.from("hello world").indexOf("world");        // 6
Buffer.from("head\r\n\r\nbody").indexOf("\r\n\r\n"); // 4    ← how HTTP parsers find the header end
buf.includes("x");
buf.lastIndexOf(0x0a);

Buffer.from("ab").equals(Buffer.from("ab"));        // true
Buffer.compare(Buffer.from("a"), Buffer.from("b")); // -1    — for sorting
[b3, b1, b2].sort(Buffer.compare);
```

### 5.4 ⚠ Never use `equals` on secrets

`equals` and `===` return as soon as they find a difference, so the time they take leaks how many leading bytes matched. An attacker can recover a token byte by byte:

```ts
import { timingSafeEqual } from "node:crypto";

// ✗ timing attack
if (providedToken.equals(realToken)) { }

// ✓ constant time
if (provided.length === real.length && timingSafeEqual(provided, real)) { }
```

`timingSafeEqual` **throws** if the lengths differ (`ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH`), so check length first. Length itself is usually not secret — but if it is, hash both sides to a fixed length and compare those.

---

## 6. Text across chunk boundaries

**This is the section that matters most**, and it's the bridge to streams.

A UTF-8 character can be 1–4 bytes. When data arrives in chunks — from a socket, a file stream, a subprocess — a character can be **split across two chunks**. Decoding each chunk independently corrupts it:

```ts
const full = Buffer.from("héllo 😀 wörld");   // 18 bytes
const a = full.subarray(0, 8);                 // ends mid-emoji
const b = full.subarray(8);

a.toString() + b.toString();
// "héllo ���� wörld"   ✗ four replacement characters
```

The emoji is 4 bytes starting at offset 7. Splitting at 8 leaves one byte in chunk `a` and three in chunk `b`; neither decodes.

### 6.1 Fix A — `StringDecoder`

Buffers incomplete sequences until the rest arrives:

```ts
import { StringDecoder } from "node:string_decoder";

const decoder = new StringDecoder("utf8");
decoder.write(a) + decoder.write(b) + decoder.end();
// "héllo 😀 wörld"   ✓
```

Always call `.end()` — it flushes any trailing partial sequence (as U+FFFD if it's genuinely truncated).

### 6.2 Fix B — `TextDecoder` with `{ stream: true }`

The web-standard equivalent:

```ts
const td = new TextDecoder("utf-8");
td.decode(a, { stream: true }) + td.decode(b, { stream: true }) + td.decode();
// "héllo 😀 wörld"   ✓
```

The final bare `decode()` signals end-of-stream and flushes.

### 6.3 Fix C — set an encoding on the stream

Node does it for you:

```ts
stream.setEncoding("utf8");           // now emits strings, correctly split
for await (const chunk of stream) { } // chunk is a string, not a Buffer
```

Convenient — but you lose access to the bytes, so you can't measure real sizes or handle binary. For a text protocol it's the right call; for anything else, buffer the bytes and decode at a known boundary.

### 6.4 The rule

> **Never call `.toString()` on a chunk.** Either accumulate the bytes and decode once at the end, or use a stateful decoder. This single mistake corrupts non-English text in more production systems than any other.

The same logic applies to **line splitting**, JSON framing, and any delimiter-based protocol: a delimiter can straddle a chunk boundary too.

```ts
// ✗ loses the last partial line, and mis-splits across chunks
for await (const chunk of stream) {
  for (const line of chunk.toString().split("\n")) handle(line);
}

// ✓ keep a remainder
let remainder = "";
const decoder = new StringDecoder("utf8");
for await (const chunk of stream) {
  const text = remainder + decoder.write(chunk);
  const lines = text.split("\n");
  remainder = lines.pop() ?? "";      // last element is incomplete
  for (const line of lines) handle(line);
}
if (remainder) handle(remainder);
```

(Node also ships `readline` for exactly this — but knowing why it exists is the point.)

---

## 7. Performance

### 7.1 Concatenating in a loop is O(n²)

```ts
// ✗ allocates and copies everything, every iteration
let acc = Buffer.alloc(0);
for await (const chunk of stream) acc = Buffer.concat([acc, chunk]);

// ✓ collect, concat once
const chunks: Buffer[] = [];
for await (const chunk of stream) chunks.push(chunk);
const acc = Buffer.concat(chunks);
```

The same applies to strings. If you know the total size, pass it: `Buffer.concat(chunks, total)`.

### 7.2 Always cap what you accumulate

Any code that buffers a whole request or response into memory is a denial-of-service vector:

```ts
const MAX = 1024 * 1024;   // 1 MB
let total = 0;
const chunks: Buffer[] = [];

for await (const chunk of req) {
  total += chunk.length;
  if (total > MAX) throw new Error("payload too large");   // 413
  chunks.push(chunk);
}
```

### 7.3 Don't convert if you don't have to

```ts
// ✗ two conversions and two allocations to count bytes
JSON.parse(buf.toString()).items.length;

// ✗ decoding 50MB to find a delimiter
buf.toString().indexOf("\r\n\r\n");

// ✓ search the bytes directly
buf.indexOf("\r\n\r\n");
```

Buffer methods that take a string argument encode it once and search bytes. Converting the *haystack* to a string is what costs.

### 7.4 Reuse buffers in hot paths

```ts
// A fixed-size scratch buffer, written completely each time
const scratch = Buffer.allocUnsafe(64);
function encodeHeader(id: number, len: number): Buffer {
  scratch.writeUInt32BE(id, 0);
  scratch.writeUInt32BE(len, 4);
  return scratch.subarray(0, 8);   // ⚠ caller must not retain this
}
```

This is a real optimisation and a real footgun — the returned view is invalidated by the next call. Only do it when the consumer copies immediately, and document it loudly.

---

## 8. Conversions cheat sheet

```ts
// string ⇄ Buffer
Buffer.from(str, "utf8");                  str = buf.toString("utf8");

// Buffer ⇄ hex / base64
buf.toString("hex");                       Buffer.from(hex, "hex");
buf.toString("base64url");                 Buffer.from(b64, "base64url");

// Buffer ⇄ ArrayBuffer  (mind the offset!)
buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
Buffer.from(arrayBuffer);                  // shares memory

// Buffer ⇄ Uint8Array
new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);   // shares
Buffer.from(uint8array);                                       // copies
Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);          // shares

// Buffer ⇄ JSON  (verbose — prefer base64 for real payloads)
JSON.stringify(Buffer.from("hi"));         // {"type":"Buffer","data":[104,105]}
Buffer.from(JSON.parse(s).data);

// Web streams / fetch
new Blob([buf]);
Buffer.from(await blob.arrayBuffer());
Buffer.from(await response.arrayBuffer());
```

---

## 9. Files in this module

| File | What it demonstrates |
|---|---|
| `01-creating.ts` | `alloc` vs `allocUnsafe`, the pool, `from` variants, the `.buffer` trap |
| `02-encodings.ts` | every encoding, lenient decoding, `byteLength`, `write` truncation |
| `03-numbers.ts` | endianness, the read/write family, ranges, BigInt |
| `04-views.ts` | `subarray` vs `slice`, retention, copy/compare/search, `timingSafeEqual` |
| `05-text-boundaries.ts` | split characters, `StringDecoder`, `TextDecoder`, line splitting |
| `06-performance.ts` | O(n²) concat, size caps, avoiding conversions, benchmarks |
| `exercise.ts` | hexdump, a binary frame codec, an incremental decoder, safe compare |

```bash
node src/04-buffers/index.ts              # all six demos
node scripts/test.ts 04                   # test your exercise
node scripts/test.ts --solutions 04
```

---

## 10. Check yourself

1. Why is `Buffer.allocUnsafe(1024)` a security risk, and when is it fine?
2. `buf.buffer.byteLength` is 8192 but `buf.length` is 5. What happened, and what do you do about it?
3. `"héllo".length` is 5 but the buffer is 6 bytes. Which one belongs in a `Content-Length` header?
4. `Buffer.from("!!!garbage!!!", "base64")` — what do you get?
5. You `subarray(0, 10)` a 50MB buffer and keep the result in a cache. How much memory is retained?
6. Two chunks arrive; you call `.toString()` on each and concatenate. What breaks, and for which users?
7. Why does `providedToken.equals(realToken)` leak information?
8. A colleague writes `acc = Buffer.concat([acc, chunk])` in a stream loop. What's the complexity, and what else is wrong with it?
