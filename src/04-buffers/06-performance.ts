/**
 * 06 — Buffer performance
 *
 * Run:  node src/04-buffers/06-performance.ts
 */

function bench(label: string, fn: () => void): number {
  fn(); // warm the JIT — without this, whichever runs first is unfairly slow
  const t0 = performance.now();
  fn();
  const ms = performance.now() - t0;
  console.log(`  ${label.padEnd(42)} ${ms.toFixed(1).padStart(8)}ms`);
  return ms;
}

const CHUNKS = 4_000;
const CHUNK_SIZE = 1_024;
const chunks = Array.from({ length: CHUNKS }, () => Buffer.alloc(CHUNK_SIZE, 0x61));
const totalBytes = CHUNKS * CHUNK_SIZE;

console.log(`=== 1. Accumulating ${CHUNKS} × ${CHUNK_SIZE}B chunks (${(totalBytes / 1024 / 1024).toFixed(1)}MB) ===\n`);

const quadratic = bench("✗ acc = Buffer.concat([acc, chunk])", () => {
  let acc = Buffer.alloc(0);
  for (const c of chunks) acc = Buffer.concat([acc, c]);
});

const linear = bench("✓ collect, then concat once", () => {
  const out: Buffer[] = [];
  for (const c of chunks) out.push(c);
  Buffer.concat(out);
});

const preSized = bench("✓ concat with known total length", () => {
  const out: Buffer[] = [];
  let total = 0;
  for (const c of chunks) {
    out.push(c);
    total += c.length;
  }
  Buffer.concat(out, total);
});

const preAllocated = bench("✓ pre-allocate + copy (fastest)", () => {
  const out = Buffer.allocUnsafe(totalBytes); // safe: every byte is overwritten
  let offset = 0;
  for (const c of chunks) {
    c.copy(out, offset);
    offset += c.length;
  }
});

console.log(`
  The first one is O(n²): each iteration allocates a NEW buffer of the full
  running size and copies everything into it. ${CHUNKS} chunks means
  ~${((CHUNKS * (CHUNKS + 1)) / 2 / 1e6).toFixed(1)}M chunk-copies instead of ${(CHUNKS / 1000).toFixed(0)}k.
  Speedup from the one-line fix: ${(quadratic / linear).toFixed(0)}×.

  The other three are all O(n) and within noise of each other (${(linear / preSized).toFixed(2)}× and
  ${(linear / preAllocated).toFixed(2)}× vs collect-then-concat). Passing the total length skips a
  counting pass and pre-allocating skips the intermediate array — real but
  marginal. Pick whichever reads best; the ${(quadratic / linear).toFixed(0)}× win was in the first fix.

  This exact anti-pattern is in a lot of "read the request body" snippets on
  the internet. It works fine at 10KB and falls over at 10MB.
`);

console.log("=== 2. Searching bytes vs searching a decoded string ===\n");
{
  const haystack = Buffer.concat([Buffer.alloc(8 * 1024 * 1024, 0x61), Buffer.from("\r\n\r\nNEEDLE")]);
  console.log(`  haystack: ${(haystack.length / 1024 / 1024).toFixed(0)}MB\n`);

  const asString = bench("✗ buf.toString().indexOf('\\r\\n\\r\\n')", () => {
    haystack.toString("latin1").indexOf("\r\n\r\n");
  });
  const asBytes = bench("✓ buf.indexOf('\\r\\n\\r\\n')", () => {
    haystack.indexOf("\r\n\r\n");
  });

  console.log(`
  ${(asString / asBytes).toFixed(0)}× faster, and — more importantly — the string version ALLOCATES
  another ${(haystack.length / 1024 / 1024).toFixed(0)}MB and blocks the event loop for the whole conversion.
  Buffer methods that take a string argument encode that argument once and
  then scan bytes. Converting the haystack is what costs.
`);
}

console.log("=== 3. alloc vs allocUnsafe ===\n");
{
  const N = 20_000;
  const safe = bench(`alloc(4096) × ${N}`, () => {
    for (let i = 0; i < N; i++) Buffer.alloc(4096);
  });
  const unsafe = bench(`allocUnsafe(4096) × ${N}`, () => {
    for (let i = 0; i < N; i++) Buffer.allocUnsafe(4096);
  });
  console.log(`
  allocUnsafe is ${(safe / unsafe).toFixed(1)}× faster here — it skips zeroing and, for sizes
  ≤ 4KB, carves from the shared pool instead of allocating.

  Is that worth it? Only in a genuinely hot path where you overwrite every
  byte immediately. ${(safe / N * 1000).toFixed(1)}µs per alloc() is nothing next to a
  network round trip. Optimise this last, if ever — and never at the cost of
  handing out uninitialised memory.
`);
}

console.log("=== 4. Encoding costs are not equal ===\n");
{
  const data = Buffer.alloc(4 * 1024 * 1024, 0x41);
  bench("toString('latin1')", () => void data.toString("latin1"));
  bench("toString('utf8')", () => void data.toString("utf8"));
  bench("toString('hex')", () => void data.toString("hex"));
  bench("toString('base64')", () => void data.toString("base64"));
  console.log(`
  hex doubles the size; base64 grows it by ~33%. Both allocate a large string
  and block the loop while they run. Encoding a 50MB file to base64 to stuff
  it in a JSON field is a ~100ms stall AND ~67MB of extra memory — do it in a
  worker, stream it, or (better) don't: send the bytes.
`);
}

console.log("=== 5. Practical checklist ===");
console.log(`
  ✓ Collect chunks in an array; Buffer.concat ONCE at the end.
  ✓ Always cap accumulated size — an unbounded body is a DoS vector:

        const MAX = 1024 * 1024;
        let total = 0;
        for await (const chunk of req) {
          if ((total += chunk.length) > MAX) { res.statusCode = 413; return; }
          chunks.push(chunk);
        }

  ✓ Search bytes with buf.indexOf, not buf.toString().indexOf.
  ✓ Slice with subarray (free); copy only when you intend to RETAIN.
  ✓ Decode text once, at a known boundary — never per chunk (see 05).
  ✗ Don't micro-optimise allocations before you've measured event-loop lag.
  ✗ Don't base64 large payloads on the main thread.
`);
