# 10 — Routing, Middleware & Composition

Module 09 gave you a request and a response. A framework adds two things on top, and that's genuinely most of what it is:

1. **A router** — pick a handler from the method and path.
2. **A middleware chain** — run cross-cutting work around that handler.

Build both and Express stops being magic. More usefully, when a framework does something surprising — middleware order, a 404 that should have been a 405, `next()` called twice — you'll know exactly which mechanism did it.

---

## 1. Routing

### 1.1 What a route is

```ts
interface Route {
  method: string;                  // "GET"
  pattern: string;                 // "/users/:id/posts"
  handler: Handler;
}
```

Matching `GET /users/42/posts` has to produce the handler **and** `{ id: "42" }`.

### 1.2 Segment kinds

```
/users              static      matches exactly
/users/:id          parameter   matches one segment, captures it
/files/*path        wildcard    matches the rest, captures it
```

That's enough for almost every API. Regex routes and optional segments add complexity for cases a second route usually handles better.

### 1.3 Precedence is a real decision

`GET /users/me` and `GET /users/:id` both match `/users/me`. Which wins?

**Static beats parameter beats wildcard**, always — regardless of registration order. Anything else means `/users/me` silently becomes `{ id: "me" }` depending on which file happened to load first.

```
/users/me       ← static wins
/users/:id      ← only if no static match
/files/*path    ← last resort
```

Express matches in **registration order** instead, which is why its docs are full of "put your specific routes first". Specificity ordering is less surprising; it's what Fastify, Hono and most modern routers do.

### 1.4 Three ways to match, measured

| Strategy | Lookup | Notes |
|---|---|---|
| Linear scan of regexes | **O(routes × segments)** | what Express does; fine to ~100 routes |
| One combined regex | O(1)-ish | fragile, hard to extract params |
| **Trie / radix tree** | **O(segments)** | independent of route count; what Fastify does |

Measured in `02-matchers.ts` — 500 routes, 20,000 lookups:

| | Total | Per lookup |
|---|---|---|
| linear regex scan | 210ms | **10.5µs** |
| trie | 7ms | **0.4µs** |

30×, and the gap grows with the route count. At 20 routes nobody cares. At 500 on a hot path it's 10µs of pure routing before your handler does anything.

The trie is also *simpler*, because there's nothing to escape:

```ts
// the regex version needs this, or "/v1.0/x" also matches "/v1X0/x"
seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
```

### 1.5 ⚠ Regex routes are a DoS vector

A pattern with nested quantifiers backtracks exponentially. Measured, `/^(a+)+$/` against `"aaa…!"`:

| Input length | Time |
|---|---|
| 20 chars | 28ms |
| 24 chars | 78ms |
| 26 chars | 309ms |
| 28 chars | **1261ms** |

28 characters of user input froze the event loop for 1.3 seconds — and that's *one* request (module 02 §6). If you accept user-supplied patterns, or build route regexes by concatenating unescaped strings, you have a ReDoS.

A trie can't backtrack at all. That's the strongest argument for it.

### 1.6 Decoding parameters

```ts
"/users/" + encodeURIComponent("a/b")   // "/users/a%2Fb" — ONE segment
```

Split the path on `/` **before** decoding, or `%2F` splits a segment in two and a user can forge path structure.

```ts
// ✓ split first, then decode each part
const segments = pathname.split("/").filter(Boolean).map(decodeSegment);

function decodeSegment(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    // "%E0%A4%A" is malformed → URIError. Never let that reach the handler.
    throw new HttpError(400, "BAD_PATH", "malformed percent-encoding");
  }
}
```

`decodeURIComponent` **throws** on malformed input — an unhandled `URIError` from a URL a scanner sent is a 500 that should have been a 400.

### 1.7 404 vs 405

If the path matched but the method didn't, the answer is **405 Method Not Allowed** with an `Allow` header — not 404.

```
GET  /users/42   → 200
POST /users/42   → 405, Allow: GET, DELETE
GET  /nope       → 404
```

This is worth getting right: a 404 tells a client the resource doesn't exist, which is a different bug hunt entirely.

> Node 22 has no `URLPattern` (`typeof URLPattern === "undefined"`), so there's no built-in route matcher. You write one, or you take a dependency.

---

## 2. Middleware

### 2.1 The onion

Middleware wraps the handler — it runs code **before** and **after**:

```
       ┌─────────────── logger ────────────────┐
       │  ┌──────────── auth ───────────────┐  │
       │  │  ┌───────── handler ─────────┐  │  │
  req ─┼──┼──┼──────────►                │  │  │
       │  │  │                           │  │  │
  res ◄┼──┼──┼──────────                 │  │  │
       │  │  └───────────────────────────┘  │  │
       │  └─────────────────────────────────┘  │
       └───────────────────────────────────────┘
```

```ts
type Middleware = (ctx: Context, next: () => Promise<void>) => Promise<void>;

const logger: Middleware = async (ctx, next) => {
  const start = performance.now();
  await next();                                  // ← everything downstream
  log(ctx.method, ctx.path, ctx.status, performance.now() - start);
};
```

Everything before `await next()` runs on the way **in**; everything after runs on the way **out**, in reverse order. That single property is what makes timing, logging, transactions and error handling possible as middleware.

### 2.2 `compose` in ten lines

```ts
function compose(middleware: Middleware[]): (ctx: Context) => Promise<void> {
  return function run(ctx: Context): Promise<void> {
    let lastCalled = -1;

    function dispatch(i: number): Promise<void> {
      // Calling next() twice is a real bug and must be loud, not silent.
      if (i <= lastCalled) return Promise.reject(new Error("next() called multiple times"));
      lastCalled = i;

      const fn = middleware[i];
      if (!fn) return Promise.resolve();
      // Promise.resolve().then() normalises a SYNC throw into a rejection,
      // so one catch at the call site covers both.
      return Promise.resolve().then(() => fn(ctx, () => dispatch(i + 1)));
    }

    return dispatch(0);
  };
}
```

That's Koa's `koa-compose`, essentially verbatim. Ten lines, and it gives you the whole onion plus error propagation.

### 2.3 Ordering is the whole game

```ts
app.use(requestId);       // 1. so everything downstream can log it
app.use(logger);          // 2. so it times everything below, incl. errors
app.use(errorHandler);    // 3. catches everything below it
app.use(cors);            // 4. must run before auth, or preflights 401
app.use(bodyParser);      // 5. before anything that reads ctx.body
app.use(auth);            // 6. after cors, before routes
app.use(router.routes()); // 7. last
```

Every one of those positions is load-bearing. A few consequences people hit:

- **`errorHandler` catches only what's *below* it.** Put it above the router, not at the bottom of the file.
- **`cors` before `auth`**, or the browser's unauthenticated `OPTIONS` preflight gets a 401 and the real request never happens.
- **`logger` above `errorHandler`**, or failed requests never get logged.

### 2.4 Async pitfalls

```ts
// ✗ forgot await — the "after" half runs immediately, before the handler
const broken: Middleware = async (ctx, next) => {
  const t0 = performance.now();
  next();                                   // ← no await
  log(performance.now() - t0);              // logs ~0ms, always
};

// ✗ next() twice — downstream runs twice, headers sent twice
const alsoBroken: Middleware = async (ctx, next) => {
  if (ctx.path === "/a") await next();
  await next();                             // runs again for /a
};

// ✗ swallowing an error
const worst: Middleware = async (ctx, next) => {
  try { await next(); } catch { /* nothing */ }   // request hangs forever
};
```

The double-`next()` guard in §2.2 turns the second one into a loud error. The other two you catch by review and tests.

---

## 3. Common middleware

```ts
// Request ID + async context (module 07 §6)
const withContext: Middleware = async (ctx, next) => {
  const requestId = ctx.req.headers["x-request-id"] ?? randomUUID();
  ctx.res.setHeader("x-request-id", requestId);
  await context.run({ requestId }, () => next());
};

// Error boundary (module 07 §4)
const errorHandler: Middleware = async (ctx, next) => {
  try {
    await next();
  } catch (err) {
    if (ctx.res.headersSent) { ctx.res.destroy(); return; }   // module 09 §3.1
    const status = err instanceof HttpError ? err.statusCode : 500;
    logger.error({ err }, "request failed");
    sendJson(ctx.res, status, status === 500
      ? { code: "INTERNAL" }                    // never leak internals
      : { code: err.code, message: err.message });
  }
};

// Timing
const timing: Middleware = async (ctx, next) => {
  const t0 = performance.now();
  try {
    await next();
  } finally {
    // `finally`, so failed requests are timed too
    metrics.histogram("http.duration", performance.now() - t0, { route: ctx.route ?? "unmatched" });
  }
};
```

Note `ctx.route` rather than `ctx.path` in that last one: labelling metrics with the raw path gives you a **cardinality explosion** — one time series per user id. Use the route *pattern*, `/users/:id`.

---

## 4. Context, or not

Koa/Hono pass a `ctx`; Express passes `(req, res, next)` and asks you to bolt properties onto `req`. A `ctx` is worth the extra concept:

```ts
interface Context {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  params: Record<string, string>;
  route?: string;              // the matched PATTERN, for metrics
  state: Record<string, unknown>;   // middleware scratch space
}
```

Mutating `req` (`req.user = …`) works but is untypeable and collides with Node's own properties. A `state` bag is explicit and easy to type.

---

## 5. Performance notes

Measured in `04-compose.ts`, 10 layers over 20,000 requests:

| | Per request |
|---|---|
| composed once at startup | **1.8µs** |
| recomposed every request | **1.9µs** |

Two conclusions, the second of which surprised me:

- **Middleware depth is cheap.** Ten layers cost under 2µs total — a closure and a promise each. Don't fear layers.
- **"Compose once" is not a performance fix.** It was only ~5% faster. It's good hygiene (stable chain identity), but if someone blames middleware depth for slowness, measure first.

For scale, the linear regex router cost **10.5µs per lookup** — roughly 6× the entire ten-layer chain. **Routing dominates middleware depth**, by a lot.

Also worth doing:

- **Match once.** Compute route, params and pattern once; put them on `ctx`.
- **Don't parse bodies you won't use.** A global body parser reads and buffers on every request, including GETs.
- **Label metrics with the route pattern**, not the path (see §3).

---

## 6. Files in this module

| File | What it demonstrates |
|---|---|
| `01-routing.ts` | static/param/wildcard matching, precedence, params, 404 vs 405 |
| `02-matchers.ts` | linear regex vs trie, measured at 500 routes; the ReDoS timings |
| `03-middleware.ts` | the onion, in/out ordering, why position matters |
| `04-compose.ts` | building `compose()`, error propagation, the double-`next()` guard |
| `05-common.ts` | request id + `AsyncLocalStorage`, errors, CORS, timing, auth |
| `06-pitfalls.ts` | missing `await`, double `next()`, swallowed errors, cardinality |
| `exercise.ts` | build a trie `Router`, `compose()`, and an `Application` |

```bash
node src/10-routing-middleware/index.ts
node scripts/test.ts 10
node scripts/test.ts --solutions 10
```

---

## 7. Check yourself

1. `/users/me` and `/users/:id` are both registered. Which wins, and should registration order matter?
2. A request for `/users/a%2Fb` — how many path segments is that, and when do you decode?
3. `decodeURIComponent` on a URL from a scanner throws. What status should the client get?
4. `POST /users/42` where only `GET` is registered — 404 or 405?
5. Your timing middleware always logs ~0ms. What's missing?
6. `errorHandler` is registered last and never fires. Why?
7. CORS preflights get 401 in the browser but curl works. What's the ordering bug?
8. Why label request metrics with `/users/:id` rather than `/users/42`?
