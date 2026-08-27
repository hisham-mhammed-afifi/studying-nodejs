/**
 * 05 — Text across chunk boundaries
 *
 * THE most important file in this module. This is the bug that corrupts
 * non-English text in production systems, and the reason streams (module 05)
 * need stateful decoders.
 *
 * Run:  node src/04-buffers/05-text-boundaries.ts
 */

import { StringDecoder } from "node:string_decoder";
import { Readable } from "node:stream";

console.log("=== 1. UTF-8 is variable width ===");
{
  const samples: Array<[string, string]> = [
    ["a", "ASCII"],
    ["é", "Latin-1 supplement"],
    ["日", "CJK"],
    ["😀", "emoji (astral plane)"],
  ];
  console.log("  char  bytes  .length  hex");
  for (const [ch, label] of samples) {
    const b = Buffer.from(ch);
    console.log(`  ${ch}     ${b.length}      ${ch.length}       ${b.toString("hex").padEnd(10)} ${label}`);
  }
  console.log(`
  Note the emoji: 4 BYTES, but .length is 2 because JS strings are UTF-16 and
  it needs a surrogate pair. Three different "lengths" for one character:
      Buffer.byteLength("😀") = 4     bytes on the wire
      "😀".length             = 2     UTF-16 code units
      [..."😀"].length        = 1     actual characters
  Use [...str] or Intl.Segmenter when you mean "characters".
`);
}

console.log("=== 2. The bug ===");
{
  const full = Buffer.from("héllo 😀 wörld");
  console.log("  full text is", full.length, "bytes");

  // Simulate two chunks arriving from a socket. The split lands mid-emoji.
  const a = full.subarray(0, 8);
  const b = full.subarray(8);

  const naive = a.toString() + b.toString();
  console.log("  naive .toString() per chunk:", JSON.stringify(naive));
  console.log("  → four replacement characters where the emoji was.");
  console.log(`
  "héllo " is 7 bytes (é takes 2), so the emoji occupies bytes 7-10.
  Splitting at 8 leaves ONE emoji byte in chunk A and THREE in chunk B.
  Neither fragment is valid UTF-8, so each decodes to U+FFFD.

  You will never see this in testing with English text. It appears the day a
  user posts in Arabic, Japanese, or with an emoji, at a payload size that
  happens to straddle a chunk boundary — i.e. intermittently, in production.
`);
}

console.log("=== 3. Fix A — StringDecoder ===");
{
  const full = Buffer.from("héllo 😀 wörld");
  const [a, b] = [full.subarray(0, 8), full.subarray(8)];

  const decoder = new StringDecoder("utf8");
  const out = decoder.write(a) + decoder.write(b) + decoder.end();
  console.log("  result:", JSON.stringify(out), "✓");

  // Watch it hold back the incomplete bytes:
  const d2 = new StringDecoder("utf8");
  console.log("  write(chunk A) returned:", JSON.stringify(d2.write(a)), "← the partial emoji byte is BUFFERED");
  console.log("  write(chunk B) returned:", JSON.stringify(d2.write(b)), "← emitted once complete");
  console.log(`
  Always call .end() at the stream's end. If the data really was truncated
  mid-character, end() flushes the leftovers as U+FFFD — which is correct:
  you want a visible replacement character, not silently dropped bytes.
`);
}

console.log("=== 4. Fix B — TextDecoder with { stream: true } ===");
{
  const full = Buffer.from("héllo 😀 wörld");
  const [a, b] = [full.subarray(0, 8), full.subarray(8)];

  const td = new TextDecoder("utf-8");
  const out = td.decode(a, { stream: true }) + td.decode(b, { stream: true }) + td.decode();
  console.log("  result:", JSON.stringify(out), "✓");
  console.log(`
  The web-standard equivalent. The final bare decode() signals end-of-stream.
  Prefer it in code shared with browsers; prefer StringDecoder in Node-only
  code (it's marginally faster and integrates with stream.setEncoding).
`);
}

console.log("=== 5. Fix C — let the stream do it ===");
{
  const full = Buffer.from("héllo 😀 wörld");
  const stream = Readable.from([full.subarray(0, 8), full.subarray(8)]);
  stream.setEncoding("utf8"); // now chunks arrive as correctly-split STRINGS

  let out = "";
  for await (const chunk of stream) out += chunk;
  console.log("  result:", JSON.stringify(out), "✓");
  console.log(`
  setEncoding() installs a StringDecoder internally. Convenient — but you lose
  the bytes, so you can no longer measure real sizes, enforce byte limits, or
  handle binary. Right for a text protocol; wrong for anything else.
`);
}

console.log("=== 6. The same problem with DELIMITERS ===");
{
  // A delimiter can straddle a boundary too — and the last line of a chunk
  // is almost never complete.
  const chunks = [Buffer.from("line one\nline t"), Buffer.from("wo\nline three\nlast")];

  console.log("  ✗ naive split per chunk:");
  for (const c of chunks) {
    for (const line of c.toString().split("\n")) console.log("     ", JSON.stringify(line));
  }
  console.log("     → 'line t' and 'wo' were split; nothing signals which are partial.");

  console.log("\n  ✓ carrying a remainder:");
  const decoder = new StringDecoder("utf8");
  let remainder = "";
  const lines: string[] = [];
  for (const c of chunks) {
    const text = remainder + decoder.write(c);
    const parts = text.split("\n");
    remainder = parts.pop() ?? ""; // the last piece is incomplete by definition
    lines.push(...parts);
  }
  remainder += decoder.end();
  if (remainder) lines.push(remainder); // don't lose a final unterminated line
  for (const l of lines) console.log("     ", JSON.stringify(l));

  console.log(`
  Two independent hazards, and you need both fixes:
    1. a CHARACTER split across chunks  → StringDecoder / TextDecoder
    2. a DELIMITER split across chunks  → carry a remainder

  Node ships readline for exactly this:

      import { createInterface } from "node:readline";
      for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) { }

  Use it. But know why it exists — you'll hand-roll the same logic for any
  protocol readline doesn't cover (length-prefixed frames, NDJSON with size
  limits, multipart bodies).
`);
}

console.log("=== 7. The rule ===");
console.log(`
  ┌────────────────────────────────────────────────────────────────────┐
  │  NEVER call .toString() on a single chunk.                         │
  │                                                                    │
  │  Either:                                                           │
  │    • accumulate the bytes and decode ONCE at the end, or           │
  │    • use a stateful decoder (StringDecoder / TextDecoder stream).  │
  └────────────────────────────────────────────────────────────────────┘

  And if you accumulate, always cap it:

      const MAX = 1024 * 1024;
      let total = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        if ((total += chunk.length) > MAX) throw new PayloadTooLarge();
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks, total).toString("utf8");   // decode once ✓
`);
