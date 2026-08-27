# 09 — `node:http` From Scratch

Part 2 starts here. Express, Fastify, Koa and Hono are all wrappers around this module — and every one of them leaks its behaviour through in ways you have to understand anyway. So build one without a framework first.

Everything from Part 1 shows up: `req` and `res` are **streams** (module 05), bodies are **Buffers** (module 04), the server is an **EventEmitter** (module 03), and one blocking handler freezes **every** connection (module 02).

---

## 1. The shape of it

```ts
import { createServer } from "node:http";

const server = createServer((req, res) => {
  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ ok: true }));
});

server.listen(3000, "127.0.0.1", () => console.log("listening"));
```

| | What it actually is |
|---|---|
| `server` | an `EventEmitter` (also a `net.Server`) |
| `req` (`IncomingMessage`) | a **Readable stream** of the request body, with headers attached |
| `res` (`ServerResponse`) | a **Writable-shaped** sink for the response body |

That's the whole mental model. `req.pipe(res)` is a valid echo server because both sides really are streams.

⚠ One inheritance detail worth knowing:

```
IncomingMessage → Readable       → Stream → EventEmitter
ServerResponse  → OutgoingMessage → Stream → EventEmitter
                  ^^^^^^^^^^^^^^^ NOT stream.Writable

res instanceof Writable;   // false
```

`res` has `write()`, `end()`, `cork()`, `'drain'`, `'finish'` and works with `pipeline()` — but it does not inherit from `stream.Writable`. Code that duck-types on `instanceof Writable` will reject a real response.

### 1.1 Request metadata

```ts
req.method;        // "GET" — always uppercase
req.url;           // "/users/42?full=1" — PATH + QUERY only, never the origin
req.httpVersion;   // "1.1"
req.headers;       // all keys LOWERCASED
req.rawHeaders;    // flat [name, value, name, value…], original case preserved
req.socket.remoteAddress;
```

Two traps:

- **`req.url` is not a URL.** It has no scheme or host. To parse it you need a base:
  ```ts
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  url.pathname;              // "/users/42"
  url.searchParams.get("full");
  ```
- **Header keys are lowercased, values are strings** — except `set-cookie`, which is always an **array**, and repeated headers, which get joined with `, `.

---

## 2. Reading the request body

The body is a stream, and it does not arrive with the headers.

```ts
// ✗ there is no req.body — that's framework middleware, not Node
const body = req.body;   // undefined
```

```ts
// ✓ but this is still wrong — see §2.1
const chunks: Buffer[] = [];
for await (const chunk of req) chunks.push(chunk);
const body = Buffer.concat(chunks).toString("utf8");
```

### 2.1 Always cap the size

Every unbounded body read is a denial-of-service vector. One client sending an endless upload exhausts your memory.

```ts
async function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw new PayloadTooLargeError();   // → 413
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}
```

`content-length` is a **hint from the client**, not a guarantee. Check it early to reject cheaply, but still count real bytes — a hostile client will lie.

### 2.1a ⚠ Don't `req.destroy()` on the way out

The obvious version calls `req.destroy()` the moment the limit is hit. I wrote that first, and the client got:

```
TypeError: fetch failed
  [cause]: SocketError: other side closed  (UND_ERR_SOCKET)
```

— not a 413. Destroying the socket kills the connection *before* the response can be written, so the caller can't distinguish "too large" from "server crashed", and a retry policy will happily send the huge body again.

The correct sequence is: stop reading, write a real 413 with `connection: close` (the connection can't be reused — unread request bytes are still arriving), then destroy the socket once the response has flushed.

```ts
res.setHeader("connection", "close");
sendJson(res, 413, { error: "payload too large" });
res.on("finish", () => req.socket.destroy());
```

### 2.2 Decode once, at the end

```ts
// ✗ corrupts any multi-byte character split across chunks (module 04 §6)
for await (const chunk of req) body += chunk.toString();

// ✓ concatenate bytes, decode once
const body = Buffer.concat(chunks, total).toString("utf8");
```

### 2.3 Content types

```ts
const [type, ...params] = (req.headers["content-type"] ?? "").split(";");
const mime = type!.trim().toLowerCase();
```

| Content-Type | How to parse |
|---|---|
| `application/json` | `JSON.parse(body)` — in a `try`, → 400 on failure |
| `application/x-www-form-urlencoded` | `new URLSearchParams(body)` |
| `text/plain` | the string, respecting `charset` |
| `multipart/form-data` | genuinely hard — use `busboy`; don't hand-roll it |
| anything else | keep the Buffer |

An empty body is not the same as an empty object. `POST` with no body and `content-length: 0` should usually be a 400 for a JSON endpoint, not `{}`.

---

## 3. Writing the response

```ts
res.statusCode = 201;
res.setHeader("content-type", "application/json; charset=utf-8");
res.setHeader("location", `/users/${id}`);
res.end(JSON.stringify(user));

// or, all at once:
res.writeHead(201, { "content-type": "application/json" });
res.end(body);
```

### 3.1 Headers must come before the body

```ts
res.write("first");
res.setHeader("x-late", "1");   // ✗ ERR_HTTP_HEADERS_SENT
```

Once any byte of the body is written, the headers are already on the wire. Check `res.headersSent` before setting anything in error handlers — that's the usual place this bites.

### 3.2 Content-Length vs chunked

Node decides for you:

```ts
res.end("hello");
// → content-length: 5      (one call, so the size is known)

res.write("a"); res.write("b"); res.end("c");
// → transfer-encoding: chunked   (size unknown when headers were sent)
```

Set `content-length` yourself when you know it — it lets clients show progress and reuse the connection more cheaply. Use `Buffer.byteLength(body)`, **never** `body.length` (module 04 §3.1):

```ts
res.setHeader("content-length", Buffer.byteLength(body));   // ✓ bytes
res.setHeader("content-length", body.length);               // ✗ wrong for non-ASCII
```

### 3.3 Streaming a response

```ts
// ✗ loads the whole file into memory, delays the first byte
res.end(await readFile(path));

// ✓ constant memory, immediate first byte, backpressure handled
await pipeline(createReadStream(path), res);
```

`pipeline` also destroys the file stream if the client disconnects — `.pipe()` would leak the fd (module 05 §5.1).

### 3.4 `end()` exactly once

```ts
res.end("one");
res.end("two");   // → emits 'error' with ERR_STREAM_WRITE_AFTER_END
```

An unhandled `error` event on `res` **crashes the process** (module 03 §2). This happens for real when a handler returns a response *and* an error handler sends one too. Guard with `res.writableEnded`.

---

## 4. Keep-alive

HTTP/1.1 reuses one TCP connection for many requests. Measured, 10 sequential requests:

| | TCP connections |
|---|---|
| `Agent({ keepAlive: false })` | **10** |
| `Agent({ keepAlive: true })` | **1** |

Each new connection costs a TCP handshake (and a TLS handshake over HTTPS) — often more than the request itself. Node's `http.globalAgent` has `keepAlive: true` by default since v19, and `fetch` uses a keep-alive pool too.

```ts
server.keepAliveTimeout = 5_000;   // how long an idle socket is held open
```

---

## 5. The timeout family

Four different timeouts, and confusing them causes real outages.

```ts
server.headersTimeout   = 60_000;    // 60s  — to receive the complete headers
server.requestTimeout   = 300_000;   // 5min — for the entire request
server.keepAliveTimeout = 5_000;     // 5s   — idle socket before close
server.timeout          = 0;         // off  — socket inactivity
http.maxHeaderSize      = 16_384;    // 16KB — total header bytes
```

| Timeout | Protects against |
|---|---|
| `headersTimeout` | Slowloris — a client dribbling headers forever |
| `requestTimeout` | a slow or endless body |
| `keepAliveTimeout` | idle sockets accumulating |
| `maxHeaderSize` | header-bomb memory exhaustion |

### 5.0a ⚠ Timeouts fire on a 30-second sweep

Node doesn't arm a timer per connection. It **sweeps** every connection on `connectionsCheckingInterval` — **30,000ms by default** — and closes whatever has expired. So a timeout is only enforced to that granularity.

Setting `headersTimeout = 300` produced a socket that lived **30004ms**. Lower the interval if you need tight enforcement:

```ts
createServer({ connectionsCheckingInterval: 1_000 }, handler);
```

For production values (60s+) the default sweep is fine, and cheaper.

### 5.0b ⚠ Nothing times out a slow *handler*

`requestTimeout` covers **receiving** the request. Once the request has fully arrived it's satisfied, and your handler can take forever. Measured, with a handler that never responds:

| Config | Result |
|---|---|
| `requestTimeout = 400` | **still hanging at 2000ms** |
| `+ server.setTimeout(400)` | client error at **409ms** |

Only `server.setTimeout()` — socket inactivity, **off by default** — cuts it. And even that just destroys the socket; it does **not** cancel your work. The query keeps running.

A slow handler needs both a cancellation signal and a socket backstop:

```ts
const ac = new AbortController();
res.on("close", () => { if (!res.writableFinished) ac.abort(); });
const signal = AbortSignal.any([ac.signal, AbortSignal.timeout(3_000)]);
const rows = await db.query(sql, { signal });

server.setTimeout(30_000);   // backstop for anything ignoring the signal
```

### 5.1 The classic 502 behind a load balancer

If your **`keepAliveTimeout` is shorter than the load balancer's idle timeout**, this race happens:

1. The LB decides to reuse an idle connection and sends a request.
2. Node's `keepAliveTimeout` fires at the same moment and closes the socket.
3. The LB sees the connection die mid-request → **502**, intermittently, under low traffic.

The fix is to make Node's timeout **longer** than the proxy's:

```ts
server.keepAliveTimeout = 65_000;   // AWS ALB idle default is 60s
server.headersTimeout   = 66_000;   // must exceed keepAliveTimeout
```

`headersTimeout` must be larger than `keepAliveTimeout` or it can cut off a legitimately reused connection.

---

## 6. Errors

```ts
server.on("clientError", (err, socket) => {
  // A malformed request: bad method, bad framing, garbage bytes.
  // `req` never existed, so you must write the raw response yourself.
  if (!socket.writableEnded) {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  }
});

server.on("error", (err) => { /* EADDRINUSE, EACCES — fatal */ });
```

Observed error codes:

| Situation | `err.code` |
|---|---|
| `NOT-HTTP-AT-ALL\r\n\r\n` | `HPE_INVALID_METHOD` |
| client vanishes mid-upload | `HPE_INVALID_EOF_STATE` |
| header bigger than `maxHeaderSize` | `HPE_HEADER_OVERFLOW` |

### 6.1 Detecting a disconnected client

```ts
res.on("close", () => {
  if (!res.writableFinished) {
    // The client hung up before we finished. Cancel the work.
    ac.abort();
  }
});
```

On the request side, `req.complete` is `false` and `req.destroyed` is `true` after an abort. (The old `'aborted'` event is deprecated — use `'close'` plus these flags.)

Wire it to an `AbortController` and pass the signal to `fetch`, `pipeline`, and `fs` (modules 05–07). Otherwise a user who navigates away leaves your query running into a dead socket.

---

## 7. Graceful shutdown — and the trap

`server.close()` stops accepting new connections and waits for existing ones. **But an idle keep-alive socket counts as an existing connection**, so it waits out the full `keepAliveTimeout`.

Measured — one 200ms request in flight, then the socket goes idle:

| Approach | `close()` completed | Client outcome |
|---|---|---|
| `close()` alone | **6186ms** | completed |
| `close()` + one `closeIdleConnections()` at 50ms | **6175ms** | completed |
| `close()` + `closeAllConnections()` at 50ms | **51ms** | **failed (ECONNRESET)** |
| `close()` + **repeated** `closeIdleConnections()` | **187ms** | **completed** ✓ |

The second row is the surprise: `closeIdleConnections()` only closes sockets that are idle **at that instant**. Called while the request is still running, it does nothing — and then the socket goes idle and holds the server for another 5 seconds.

The correct pattern sweeps repeatedly:

```ts
async function shutdown(server: Server, graceMs = 10_000): Promise<void> {
  const closed = once(server, "close");

  server.close();                                            // stop accepting
  const sweeper = setInterval(() => server.closeIdleConnections(), 100);
  const deadline = setTimeout(() => server.closeAllConnections(), graceMs);

  try {
    await closed;
  } finally {
    clearInterval(sweeper);
    clearTimeout(deadline);
  }
}

process.on("SIGTERM", () => shutdown(server).then(() => process.exit(0)));
```

Repeated sweeps close each socket as soon as it goes idle; the deadline forces the issue for genuinely stuck ones. That's 187ms instead of 6 seconds, without dropping a request.

Add a health check that fails as soon as shutdown starts, so the load balancer stops routing before you close.

---

## 8. The HTTP client

```ts
// fetch — the default choice in 2026
const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
if (!res.ok) throw new Error(`HTTP ${res.status}`);
const data = await res.json();
```

⚠ **`fetch` does not reject on 4xx/5xx.** Only network failures and aborts reject. Check `res.ok` yourself — forgetting this is the single most common `fetch` bug.

For streaming, convert at the boundary (module 05 §8):

```ts
await pipeline(Readable.fromWeb(res.body!), createWriteStream(out));
```

`http.request` is still worth knowing for fine control over agents, sockets, and raw framing:

```ts
const agent = new http.Agent({ keepAlive: true, maxSockets: 50 });
```

---

## 9. Security basics

| Risk | Defence |
|---|---|
| Header injection | never put unvalidated input in a header — Node rejects `\r\n` but not everything |
| Host header attacks | validate `req.headers.host` against an allowlist |
| Unbounded bodies | cap them (§2.1) |
| Slowloris | `headersTimeout`, `requestTimeout` |
| Leaking internals | never send a stack or an internal message to a client (module 07 §4) |
| Path traversal | `safeResolve` before serving files (module 06 §6) |

```ts
res.setHeader("x-content-type-options", "nosniff");
res.setHeader("x-frame-options", "DENY");
res.setHeader("strict-transport-security", "max-age=31536000");
```

---

## 10. Files in this module

| File | What it demonstrates |
|---|---|
| `01-anatomy.ts` | `req`/`res` as streams, headers, `req.url` parsing, the lifecycle |
| `02-request-body.ts` | reading bodies safely, size caps, content types, chunk boundaries |
| `03-responses.ts` | status/headers, `content-length` vs chunked, streaming, `end()` twice |
| `04-timeouts-keepalive.ts` | the four timeouts, keep-alive reuse measured, the 502 race |
| `05-errors-shutdown.ts` | `clientError`, aborts, and the graceful-shutdown measurements |
| `06-client.ts` | `fetch` vs `http.request`, agents, keep-alive pooling, `res.ok` |
| `exercise.ts` | build `readBody`, `parseJsonBody`, `sendJson`, and a graceful server |

```bash
node src/09-http/index.ts
node scripts/test.ts 09
node scripts/test.ts --solutions 09
```

---

## 11. Check yourself

1. Why is `new URL(req.url)` a `TypeError`?
2. Where does `req.body` come from, and what is it in plain Node?
3. `content-length` says 100 but the client sends 10MB. What stops you?
4. Your handler sets a header inside a `catch`. Sometimes it throws `ERR_HTTP_HEADERS_SENT`. Why?
5. `res.end()` runs twice. What happens, and why is it worse than it sounds?
6. Intermittent 502s behind an ALB, only at low traffic. What's the first setting you check?
7. `server.close()` takes 5 seconds even though no requests are running. Why?
8. `await fetch(url)` on a URL that returns 500 — does it throw?
