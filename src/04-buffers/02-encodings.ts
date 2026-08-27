/**
 * 02 — Encodings
 *
 * Run:  node src/04-buffers/02-encodings.ts
 */

console.log("=== 1. The same bytes, seven ways ===");
{
  const buf = Buffer.from("hi there?~");
  const encodings = ["utf8", "hex", "base64", "base64url", "latin1", "ascii", "utf16le"] as const;
  for (const enc of encodings) {
    console.log(`  ${enc.padEnd(10)} ${JSON.stringify(buf.toString(enc))}`);
  }
  console.log(`
  Note base64 vs base64url on the last two characters:
      base64:    ...U/fg==     uses + and /, padded with =
      base64url: ...U_fg       uses - and _, NO padding
  base64url is what JWTs, URLs, and filenames need. Using plain base64 there
  is the reason tokens break when they happen to contain a '/' or '+'.
`);
}

console.log("=== 2. .length vs Buffer.byteLength ===");
{
  const samples = ["hello", "héllo", "日本語", "😀"];
  console.log("  string        .length   byteLength(utf8)");
  for (const s of samples) {
    console.log(`  ${JSON.stringify(s).padEnd(12)}  ${String(s.length).padStart(4)}   ${String(Buffer.byteLength(s)).padStart(10)}`);
  }
  console.log(`
  .length counts UTF-16 code units. byteLength counts UTF-8 bytes.
  They agree only for pure ASCII — which is exactly why this bug survives
  code review and then breaks for one region's users.

      res.setHeader("Content-Length", body.length);              ✗
      res.setHeader("Content-Length", Buffer.byteLength(body));  ✓

  Same for size limits, database column widths, and truncation logic.
`);
}

console.log("=== 3. Decoding is LENIENT — it never throws ===");
{
  console.log("  invalid utf8 byte 0xFF →", JSON.stringify(Buffer.from([0xff]).toString("utf8")));
  console.log("  ...that's U+FFFD, the replacement character. No error was raised.");

  const garbage = Buffer.from("!!!not base64 at all!!!", "base64");
  console.log("  base64 of garbage      →", garbage.toString("hex"), `(${garbage.length} bytes)`);
  console.log(`
  Base64 decoding silently DISCARDS every character that isn't in the base64
  alphabet, then decodes whatever is left. You get plausible-looking bytes
  from complete nonsense — no error, no signal, just wrong data downstream.
`);
}

console.log("=== 4. Strict decoding, when validity matters ===");
{
  // TextDecoder CAN throw. Buffer.toString never does.
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from([0xff]));
  } catch (err) {
    console.log("  TextDecoder fatal:true →", (err as Error).constructor.name + ":", (err as Error).message);
  }

  // Round-trip check for base64.
  function isValidBase64(s: string): boolean {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s)) return false;
    return Buffer.from(s, "base64").toString("base64") === s;
  }
  for (const s of ["aGVsbG8=", "!!!nope!!!", "aGVsbG8", "aGVsbG8=="]) {
    console.log(`  isValidBase64(${JSON.stringify(s).padEnd(14)}) → ${isValidBase64(s)}`);
  }
  console.log(`
  Validate at the trust boundary. A malformed token that decodes to garbage
  is far harder to debug than one that is rejected at the door.
`);
}

console.log("=== 5. write() truncates, and returns how much it wrote ===");
{
  const small = Buffer.alloc(3);
  const written = small.write("hello");
  console.log(`  alloc(3).write("hello") → wrote ${written} bytes:`, JSON.stringify(small.toString()));

  // It will not split a multi-byte character, so you can get FEWER bytes
  // than the buffer has room for:
  const four = Buffer.alloc(4);
  const w2 = four.write("aé😀");
  console.log(`  alloc(4).write("aé😀")  → wrote ${w2} bytes:`, JSON.stringify(four.toString("utf8", 0, w2)));
  console.log("  (the emoji needs 4 bytes; only 1 was left, so it was skipped entirely)");
}

console.log("\n=== 6. latin1: the lossless byte↔char encoding ===");
{
  const b = Buffer.from([0x00, 0x7f, 0x80, 0xfe, 0xff]);
  console.log("  bytes:      ", b.toString("hex"));
  console.log("  via latin1: ", [...b.toString("latin1")].map((c) => c.charCodeAt(0)).join(","), "✓ lossless");
  console.log("  via ascii:  ", [...b.toString("ascii")].map((c) => c.charCodeAt(0)).join(","), "✗ high bit stripped");
  console.log("  via utf8:   ", [...b.toString("utf8")].map((c) => c.charCodeAt(0)).join(","), "✗ replacement chars");
  console.log(`
  Use latin1 when you need bytes to survive a string round trip — legacy
  protocols, binary smuggled through a JSON field, or interop with libraries
  that hand you "binary strings". Never use 'ascii'; it is lossy by design.
`);
}

console.log("=== 7. Practical recipes ===");
console.log(`
  // Random URL-safe token
  import { randomBytes } from "node:crypto";
  const token = randomBytes(32).toString("base64url");     // 43 chars, 256 bits

  // Basic auth header
  const header = "Basic " + Buffer.from(\`\${user}:\${pass}\`).toString("base64");

  // Data URL
  const dataUrl = \`data:image/png;base64,\${imgBuf.toString("base64")}\`;

  // Hex digest (crypto already returns hex if you ask)
  createHash("sha256").update(buf).digest("hex");

  // Decode a JWT payload (base64url, no padding)
  const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString());
`);
