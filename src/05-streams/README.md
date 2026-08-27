# 05 — Streams & Backpressure

Streams are how Node processes data that is **bigger than memory** or **arrives over time**. Every HTTP request and response, every file read, every socket, every subprocess pipe, every gzip is a stream.

They also have a reputation for being confusing. Most of that is history: the API has four types, two modes, three ways to consume, and a decade of accumulated legacy. This module gives you the small subset that's actually correct to use in 2026, and explains the rest so you can read old code.

---

## 1. Why streams

### 1.1 Memory

```ts
// ✗ 2GB file → 2GB of RSS, and the process dies
const data = await readFile("huge.log");
await writeFile("out.log", transform(data));

// ✓ constant memory, regardless of file size
await pipeline(
  createReadStream("huge.log"),
  transformStream,
  createWriteStream("out.log"),
);
```

The buffered version also blocks the event loop for the whole `readFile`, and there's a hard ceiling you cannot buy your way out of:

```ts
buffer.constants.MAX_STRING_LENGTH;   // ~512MB — a V8 limit, not a RAM limit

await readFile(p);           // Buffer — fine
await readFile(p, "utf8");   // string — THROWS past ~512MB
buf.toString("utf8");        // same ceiling
JSON.stringify(huge);        // same ceiling
```

The streaming version processes 64KB at a time and has no such ceiling.

### 1.2 Time to first byte

```ts
// ✗ the client waits for the LAST row before seeing the FIRST
const rows = await db.query("SELECT * FROM events");
res.end(JSON.stringify(rows));

// ✓ bytes start flowing immediately
await pipeline(db.queryStream("SELECT * FROM events"), toNdjson(), res);
```

### 1.3 Composition

```ts
await pipeline(
  createReadStream("in.csv"),
  splitLines(),
  parseCsv(),
  filterRows(),
  toJson(),
  createGzip(),
  createWriteStream("out.json.gz"),
);
```

Each stage is independently testable, and the whole chain runs in bounded memory because of backpressure (§4).

---

## 2. The four types

| Type | You can | Examples |
|---|---|---|
| **Readable** | read from it | `fs.createReadStream`, `http.IncomingMessage`, `process.stdin` |
| **Writable** | write to it | `fs.createWriteStream`, `http.ServerResponse`, `process.stdout` |
| **Duplex** | both, independently | `net.Socket`, `tls.TLSSocket` |
| **Transform** | a Duplex where output derives from input | `zlib.createGzip`, `crypto.createCipheriv` |

A `Duplex`'s two sides are unrelated — a TCP socket reads what the peer sent and writes what you send. A `Transform`'s output *is* its transformed input.

```ts
import { Readable, Writable, Duplex, Transform, PassThrough } from "node:stream";
```

`PassThrough` is a `Transform` that does nothing. Useful as a tee point, a test double, or a place to attach instrumentation.

---

## 3. Reading: three APIs, one right answer

### 3.1 `for await` — use this

```ts
for await (const chunk of readable) {
  // chunk is a Buffer (or a string if setEncoding was called,
  // or any value in object mode)
}
```

It handles backpressure automatically, propagates errors as exceptions, and **destroys the stream if you `break` or `throw`**:

```ts
const r = Readable.from([1, 2, 3, 4, 5]);
for await (const v of r) if (v === 2) break;
r.destroyed;   // true — cleaned up for you
```

### 3.2 `.on("data")` — legacy, and a trap

```ts
readable.on("data", (chunk) => { /* ... */ });
```

Attaching a `data` listener switches the stream into **flowing mode** and it never stops for you:

```ts
// ✗ classic bug: the async work is not awaited, so chunks pile up
readable.on("data", async (chunk) => {
  await slowDatabaseWrite(chunk);   // returns a promise nobody waits for
});
```

The stream keeps emitting at full speed while your writes queue in memory. Unbounded memory growth, and errors inside become unhandled rejections. If you must use it, `readable.pause()` / `.resume()` manually — or just use `for await`.

### 3.3 `.read()` — paused mode, rarely needed

```ts
readable.on("readable", () => {
  let chunk;
  while ((chunk = readable.read()) !== null) { /* ... */ }
});
```

Precise control over exactly when bytes are pulled. Genuinely useful for parsers that want *n* bytes at a time (`readable.read(n)`), otherwise skip it.

### 3.4 The three modes

| State | Meaning |
|---|---|
| `readableFlowing === null` | nothing has asked for data yet; nothing is emitted |
| `readableFlowing === true` | flowing — data is pushed at you via `data` events |
| `readableFlowing === false` | paused — you must `read()` explicitly |

```ts
const r = Readable.from(["a", "b"]);
r.readableFlowing;        // null
r.on("data", () => {});
r.readableFlowing;        // true — attaching the listener flipped it
```

⚠ A stream in flowing mode with no consumer **discards data**. This is why attaching a `data` listener "for logging" and then also using `for await` loses chunks.

### 3.5 Consuming a whole stream

```ts
import { text, json, buffer, arrayBuffer } from "node:stream/consumers";

const body = await text(req);      // decodes UTF-8 correctly across chunks
const obj  = await json(req);
const buf  = await buffer(req);
```

These are correct and short — but they buffer everything, so **always add a size cap** for anything from the network (§7.3).

---

## 4. Backpressure

This is the reason streams exist, and the thing most tutorials skip.

### 4.1 The mechanism

`writable.write(chunk)` returns a **boolean**:

- `true` — the internal buffer is below `highWaterMark`; keep writing.
- `false` — the buffer is full. **Stop**, and wait for the `drain` event.

```ts
const ok = writable.write(chunk);
if (!ok) await once(writable, "drain");
```

`write()` never rejects the data — it always accepts the chunk. The return value is *advice*. Ignoring it doesn't lose data; it makes the buffer grow without limit.

```ts
// ✗ reads a 2GB file into memory via the write buffer
for await (const chunk of source) dest.write(chunk);

// ✓ respects the signal
for await (const chunk of source) {
  if (!dest.write(chunk)) await once(dest, "drain");
}

// ✓✓ or just let pipeline do it
await pipeline(source, dest);
```

### 4.2 `highWaterMark`

The buffer threshold, per stream:

```ts
new Readable({ read() {} }).readableHighWaterMark;              // 65536 (64KB)
new Writable({ write() {} }).writableHighWaterMark;             // 65536
new Readable({ objectMode: true, read() {} }).readableHighWaterMark;   // 16 (objects)
```

In byte mode it counts **bytes**; in object mode it counts **objects**. It's a threshold, not a hard limit — a single `write()` larger than the mark is still accepted whole.

Useful inspection properties:

```ts
writable.writableLength;      // bytes/objects currently buffered
writable.writableNeedDrain;   // true if the last write returned false
readable.readableLength;
```

### 4.3 How the chain works

```
   source          transform         destination
     │                 │                  │
   read() ◄──── pull ──┤ ◄──── pull ──────┤
     └──── push ─────► │ ──── push ─────► │
                    (64KB)             (64KB)
```

When the destination's buffer fills, it stops pulling. The transform's buffer fills, so it stops pulling. The source stops reading. Memory stays bounded at roughly `highWaterMark × number of stages` — *if every stage respects the signal*. One stage that ignores it breaks the whole chain.

### 4.4 What it looks like when it's broken

Symptoms in production: RSS climbing while throughput looks fine, then an OOM kill. Usually one of:

- `.on("data", async …)` — the handler isn't awaited.
- `for await (…) dest.write(chunk)` without checking the return value.
- A custom `Writable` whose `_write` calls `callback()` immediately, before the work is done.
- `.pipe()` into something that buffers internally without limits.

---

## 5. `pipeline` vs `pipe`

### 5.1 Always use `pipeline`

```ts
import { pipeline } from "node:stream/promises";

await pipeline(source, transform, destination);
```

`pipeline` handles backpressure, **propagates errors**, and **destroys every stream** in the chain on failure. `pipe` does none of the last two.

```ts
const s = makeSource(), d = makeFailingDest();

s.pipe(d);
d.on("error", () => {});
// → s.destroyed is FALSE. The source keeps reading, forever. File
//   descriptors, sockets, and memory leak on every failed request.

await pipeline(s, d).catch(() => {});
// → s.destroyed is TRUE. Everything cleaned up. ✓
```

`pipe` also does not forward errors: an error on the source does **not** reach the destination, so `dest.on("error")` never fires and an unhandled `error` event crashes the process (module 03, §2).

> The only remaining reason to use `.pipe()` is a long-lived chain you never want torn down on error — and that's rare enough that you should write a comment explaining why.

### 5.2 Cancellation

```ts
const ac = new AbortController();
req.on("close", () => ac.abort());          // client hung up

await pipeline(source, dest, { signal: ac.signal });
```

### 5.3 Async generators are first-class stages

Anywhere a Transform would go, you can put an async generator. This is usually far more readable:

```ts
await pipeline(
  createReadStream("in.txt"),
  async function* (source) {
    source.setEncoding("utf8");
    for await (const chunk of source) yield chunk.toUpperCase();
  },
  createWriteStream("out.txt"),
);
```

Backpressure still works — the generator is only pulled when the next stage is ready.

### 5.4 `finished` and `compose`

```ts
import { finished } from "node:stream/promises";
await finished(stream);      // resolves when it ends, rejects on error

import { compose } from "node:stream";
const pipelineStage = compose(splitLines(), parseJson());   // one reusable Duplex
```

---

## 6. Writing your own

### 6.1 Readable

```ts
class Counter extends Readable {
  #n = 0;
  constructor(private max: number) {
    super({ objectMode: true });
  }
  // Called when the consumer wants more. Push until push() returns false.
  override _read(): void {
    if (this.#n >= this.max) {
      this.push(null);          // null = EOF
      return;
    }
    this.push({ n: this.#n++ }); // push() returns false when the buffer is full
  }
}
```

Rules: `push(null)` ends it. Never call `_read` yourself. Don't push after `null`. If your source is async, it's almost always easier to use `Readable.from(asyncGenerator())`.

```ts
// Usually better than subclassing:
const stream = Readable.from(async function* () {
  for await (const row of db.cursor()) yield row;
}());
```

### 6.2 Writable

```ts
class BatchWriter extends Writable {
  #batch: unknown[] = [];

  constructor() {
    super({ objectMode: true, highWaterMark: 64 });
  }

  override _write(chunk: unknown, _enc: BufferEncoding, cb: (e?: Error | null) => void): void {
    this.#batch.push(chunk);
    if (this.#batch.length < 100) return cb();          // fast path
    const batch = this.#batch.splice(0);
    db.insertMany(batch).then(() => cb(), cb);          // ← cb AFTER the work
  }

  // Called once, before 'finish'. Flush whatever is left.
  override _final(cb: (e?: Error | null) => void): void {
    if (this.#batch.length === 0) return cb();
    db.insertMany(this.#batch.splice(0)).then(() => cb(), cb);
  }
}
```

**The single most important rule:** call `callback()` only when the write has *actually completed*. Calling it early tells the stream you're ready for more, which destroys backpressure.

Also implement `_writev(chunks, cb)` if batching is cheaper than one-at-a-time — the stream will hand you everything buffered at once.

### 6.3 Transform

```ts
class Redact extends Transform {
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    cb(null, Buffer.from(chunk.toString().replace(/\d{16}/g, "[REDACTED]")));
  }
  // Optional. Called at end-of-input — emit any buffered tail here.
  override _flush(cb: TransformCallback): void {
    cb();
  }
}
```

⚠ That example has the module-04 bug: `chunk.toString()` corrupts multi-byte characters split across chunks, and a card number split across chunks won't match. `_flush` exists precisely so you can carry a remainder — which is what the exercise has you build.

You can also pass the methods as options instead of subclassing:

```ts
new Transform({
  objectMode: true,
  transform(chunk, enc, cb) { cb(null, transform(chunk)); },
  flush(cb) { cb(); },
});
```

### 6.4 Object mode

```ts
new Transform({ objectMode: true });          // both sides
new Transform({ readableObjectMode: true });  // Buffers in, objects out
```

In object mode chunks are arbitrary values, `highWaterMark` counts items (default 16), and no encoding happens. Parsers typically want `writableObjectMode: false, readableObjectMode: true`.

⚠ **`null` is the EOF sentinel, so you can never push `null` as a value.** This is nastier than it sounds, because it fails *silently*:

```ts
// An NDJSON parser. "null" is legal JSON!
transform(line, _enc, cb) { cb(null, JSON.parse(line)); }
```

```
{"a":1}
null          ← the stream ENDS here
{"b":2}       ← silently discarded, no error, no warning
```

You get a truncated result and a clean exit code. Guard explicitly: treat `null` as invalid, or wrap every value (`{ value }`), or use `undefined` for "emit nothing".

---

## 7. Errors, cleanup, limits

### 7.1 Every stream needs an error handler

Streams are EventEmitters, so an unhandled `error` event **crashes the process** (module 03, §2). `pipeline` gives you one handler for the whole chain — another reason to prefer it.

```ts
await pipeline(a, b, c).catch((err) => { /* one place */ });
```

### 7.2 `destroy` vs `end`

```ts
writable.end();              // graceful: flush what's buffered, then 'finish'
writable.destroy();          // immediate: discard buffers, emit 'close'
writable.destroy(err);       // immediate + emit 'error'
```

`destroy()` is what you want on an abort. `end()` is what you want on success.

### 7.3 Always cap what you accept

```ts
async function readBodyCapped(req: Readable, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      req.destroy();                              // stop the sender
      throw new Error("payload too large");       // → 413
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}
```

Every `await text(req)` without a cap is a memory-exhaustion vector. So is any line-based parser without a maximum line length — a 10GB "line" with no newline buffers the whole thing.

---

## 8. Web Streams interop

Node ships the WHATWG streams too, and they show up whenever you touch `fetch`.

```ts
const res = await fetch(url);
res.body;                    // a web ReadableStream, NOT a Node Readable
```

Convert in either direction:

```ts
Readable.fromWeb(res.body);            // web → Node
Readable.toWeb(nodeReadable);          // Node → web
Writable.toWeb(nodeWritable);
Duplex.toWeb(nodeDuplex);
```

| | Node streams | Web streams |
|---|---|---|
| Consume | `for await`, `pipeline` | `for await`, `pipeTo`, `getReader()` |
| Backpressure | `write()` returns false + `drain` | promise-based, built into the reader |
| Transform | `Transform` class | `TransformStream` |
| Object mode | yes | no (byte-oriented; use any value with a custom queuing strategy) |
| Ecosystem | all of Node core | `fetch`, browsers, Deno, Bun, workers |

**Rule:** Node streams inside Node code; convert at the boundary where `fetch` or a browser-shared library is involved. Node streams are faster in Node and integrate with everything in core.

Handy web-standard transforms available globally:

```ts
new TextDecoderStream();
new CompressionStream("gzip");
new DecompressionStream("gzip");
```

---

## 9. Recipes

```ts
// Read a file line by line — the boring correct way
import { createInterface } from "node:readline";
for await (const line of createInterface({
  input: createReadStream("app.log"),
  crlfDelay: Infinity,          // treat \r\n as one break
})) { }

// Gzip a file
await pipeline(createReadStream("a.txt"), createGzip(), createWriteStream("a.txt.gz"));

// Hash a file without loading it
const hash = createHash("sha256");
await pipeline(createReadStream("big.bin"), hash);
hash.digest("hex");

// Stream a fetch response to disk
const res = await fetch(url);
if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
await pipeline(Readable.fromWeb(res.body), createWriteStream("out.bin"));

// Tee: write to two destinations
const source = createReadStream("in.txt");
const a = new PassThrough(), b = new PassThrough();
source.pipe(a);
source.pipe(b);
await Promise.all([pipeline(a, dest1), pipeline(b, dest2)]);

// Throttle / measure throughput
const meter = new Transform({
  transform(chunk, _enc, cb) { bytes += chunk.length; cb(null, chunk); },
});
```

---

## 10. Files in this module

| File | What it demonstrates |
|---|---|
| `01-why-streams.ts` | buffered vs streamed memory, measured with RSS |
| `02-reading.ts` | `for await`, flowing/paused, the `data`-listener trap, consumers |
| `03-backpressure.ts` | `write()` returning false, `drain`, measured buffer growth |
| `04-pipeline.ts` | `pipe` leaking on error vs `pipeline` cleaning up; `AbortSignal` |
| `05-transforms.ts` | custom Readable/Writable/Transform, object mode, async generators |
| `06-web-streams.ts` | `fromWeb`/`toWeb`, `fetch` bodies, `TransformStream` |
| `exercise.ts` | a line splitter, an NDJSON parser, a capped collector, a batch writer |

```bash
node src/05-streams/index.ts        # all six demos
node scripts/test.ts 05             # test your exercise
node scripts/test.ts --solutions 05
```

---

## 11. Check yourself

1. What does `writable.write(chunk)` returning `false` mean, and what happens if you ignore it?
2. Why is `readable.on("data", async (c) => await save(c))` broken?
3. A destination stream errors. What is the state of the source under `pipe`, and under `pipeline`?
4. Your custom `_write` calls `callback()` before the database insert resolves. What breaks?
5. What is `highWaterMark` counting in object mode, and what's its default?
6. Why can't you push `null` as a value in object mode?
7. `fetch` gives you `res.body`. Can you pass it straight to `pipeline`?
8. A line-splitting Transform has two independent correctness hazards. What are they? (Hint: module 04, §6.)
