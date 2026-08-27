# 11 — Fastify, and What a Framework Actually Buys You

You built a router and a middleware engine in module 10. So the honest question is: what does a real framework add that's worth a dependency?

The answer is **not** what the benchmarks advertise. This module measures the claims and reports what actually held up.

```bash
npm install fastify
```

---

## 1. The short version

| Feature | Verdict |
|---|---|
| **Schema validation** | ✅ genuinely valuable — declarative, at the boundary, with coercion |
| **Schema serialization** | ✅ valuable, but for **safety**, not speed (§3) |
| **Plugin encapsulation** | ✅ the best idea in the framework (§4) |
| **Hooks** | ✅ a clearer lifecycle than raw middleware ordering (§5) |
| **`inject()` testing** | ✅ no sockets, no ports, no flakiness (§7) |
| **Built-in pino logging** | ✅ correct by default |
| **"3× faster serialization"** | ⚠️ **did not reproduce** (§3.2) |
| **Safe error responses** | ❌ **it leaks `err.message` on 500s** (§6) |

Two of those need arguing with evidence. Both are below.

---

## 2. Schema validation

```ts
app.post("/users", {
  schema: {
    body: {
      type: "object",
      required: ["name", "age"],
      properties: {
        name: { type: "string", minLength: 2 },
        age: { type: "integer", minimum: 0 },
      },
      additionalProperties: false,
    },
  },
}, async (req) => ({ received: req.body }));
```

```
POST { name: "a", age: -1 }
→ 400 {"statusCode":400,"code":"FST_ERR_VALIDATION",
       "error":"Bad Request","message":"body/name must NOT have fewer than 2 characters"}
```

Validation runs **before your handler**, so the handler only ever sees valid input. That's the real win: no defensive checks scattered through business logic.

### 2.1 Coercion is free

```ts
app.get("/search", {
  schema: { querystring: { type: "object", properties: { page: { type: "integer" } } } },
}, async (req) => req.query);
```

```
GET /search?page=3  →  { page: 3 }   ← a NUMBER, not "3"
```

Query strings and path params are always strings (module 09 §1.1). Schema coercion removes an entire category of `Number(req.query.page)` bugs.

### 2.2 ⚠ `additionalProperties: false` *strips*, it doesn't reject

```
POST { name: "ada", age: 30, extra: 1 }
→ 200 {"received":{"name":"ada","age":30}}      ← extra silently removed
```

Not a 400. If you need rejection, you have to say so — and either way, **the stripping is the useful part**: a client can't smuggle `{ role: "admin" }` into a body you spread into a database update.

---

## 3. Schema serialization — the real story

```ts
app.get("/user", {
  schema: { response: { 200: {
    type: "object",
    properties: { id: { type: "string" }, name: { type: "string" } },
  } } },
}, async () => ({ id: "1", name: "ada", passwordHash: "SECRET", internalNote: "leak" }));
```

```
with    response schema → {"id":"1","name":"ada"}
without response schema → {"id":"1","name":"ada","passwordHash":"SECRET"}
```

### 3.1 This is a security feature

The response schema is an **allowlist**. Fields you didn't declare cannot leave the process — no matter what your ORM attached, what a `SELECT *` returned, or what a colleague added to the model last week.

That is a structurally different guarantee from "remember to `delete user.passwordHash`". It's the single best reason to use response schemas, and it has nothing to do with speed.

### 3.2 ⚠ The speed claim did not reproduce

Fastify is widely described as having "2–3× faster serialization". Measured here against `JSON.stringify`, Node 22:

| Payload shape | `fast-json-stringify` | `JSON.stringify` | Ratio |
|---|---|---|---|
| small flat object | 18ms | 34ms | **1.93× faster** |
| wide object (20 strings) | 106ms | 78ms | **0.74× — slower** |
| array of 100 objects | 173ms | 148ms | **0.86× — slower** |

Only the small flat object won. On the shapes a real API returns — lists and wide records — V8's `JSON.stringify` was **faster**.

That claim dates from an era when V8's JSON was much slower. It has since been heavily optimised. **Use response schemas for the allowlisting, and don't expect a speedup.**

(End-to-end through `inject()` the difference was 1.16×, and most of *that* was the smaller payload — 21KB vs 51KB — because fields were stripped. Sending less data is a real win; it just isn't a serializer win.)

---

## 4. Plugin encapsulation

This is the idea worth stealing even if you never use Fastify.

```ts
app.decorate("rootThing", "root");

await app.register(async (child) => {
  child.decorate("childOnly", "child");
  child.get("/inside", async () => ({
    root: child.rootThing,     // "root"   ← inherited
    child: child.childOnly,    // "child"  ← own
  }));
});

app.get("/outside", async () => ({
  root: app.rootThing,         // "root"
  child: app.childOnly,        // undefined  ← NOT visible
}));
```

```
inside plugin:  {"root":"root","child":"child"}
outside plugin: {"root":"root","child":null}
```

A plugin gets its own scope that **inherits from its parent but cannot leak upward**. Decorators, hooks and schemas registered inside stay inside.

Compare Express/Koa, where `app.use()` is global and every middleware applies to everything below it forever. Encapsulation is what makes this work:

```ts
await app.register(async (api) => {
  api.addHook("onRequest", requireAuth);   // applies ONLY within this scope
  api.get("/me", handler);
}, { prefix: "/api" });

app.get("/health", handler);   // unaffected — no auth
```

In module 10's model you'd need conditional middleware or a separate chain. Here it's a lexical scope, and the compiler-ish guarantee is that you *cannot* accidentally apply it too widely.

---

## 5. Hooks: a named lifecycle

Measured order for one request:

```
onRequest → preParsing → preValidation → preHandler
          → preSerialization → onSend → onResponse
```

| Hook | Use it for |
|---|---|
| `onRequest` | auth, rate limiting, request id — **before** the body is read |
| `preParsing` | transform the raw body stream |
| `preValidation` | mutate the parsed body before schema checks |
| `preHandler` | load the user, open a transaction |
| `preSerialization` | reshape the payload object |
| `onSend` | modify the serialized string/Buffer, add headers |
| `onResponse` | metrics, logging — the response is already sent |

Named stages beat "wherever I put my `app.use()`". Module 10 §2.3 spent a whole section on why `cors` must precede `auth`; here both are `onRequest` hooks and the ordering question is smaller and local.

Note `onRequest` runs **before body parsing** — so rejecting an unauthenticated request there means you never read its 10MB upload.

---

## 6. ⚠ The default error handler leaks internals

```ts
app.get("/boom", async () => {
  throw new Error("connect ECONNREFUSED db.internal:5432 password=hunter2");
});
```

```
500 {"statusCode":500,"error":"Internal Server Error",
     "message":"connect ECONNREFUSED db.internal:5432 password=hunter2"}
```

**With `NODE_ENV=production` too** — I checked, expecting it to be hidden. It isn't.

Everything in modules 07, 09 and 10 says never send an internal message to a client. Fastify's default does exactly that, and it's easy to assume a mature framework handles it. Always install your own:

```ts
app.setErrorHandler((err, req, reply) => {
  req.log.error({ err }, "request failed");

  if (err.validation) {
    return reply.status(400).send({ code: "VALIDATION", message: err.message });
  }
  const status = err.statusCode ?? 500;
  reply.status(status).send(
    status >= 500
      ? { code: "INTERNAL" }                                  // ← nothing else
      : { code: err.code ?? "ERROR", message: err.message },
  );
});
```

Errors *with* a `statusCode` are treated as intentional and their message is sent — that part is fine and matches the operational/programmer split from module 07 §4.

---

## 7. Testing with `inject()`

```ts
const res = await app.inject({ method: "POST", url: "/users", payload: { name: "ada", age: 30 } });
res.statusCode;   // 201
res.json();       // parsed body
```

No port, no socket, no `listen()`, no cleanup, no flaky "address already in use". It drives the real lifecycle — hooks, validation, serialization, error handling — entirely in memory.

This is the single biggest ergonomic win over the hand-rolled server, where every test in module 09 and 10 needed a real listening port.

---

## 8. When *not* to reach for it

- **A one-route webhook receiver.** Module 09's ~40 lines is the whole thing.
- **You need full control of the socket** — upgrades, custom framing, a proxy.
- **Serverless with tight cold starts.** Fastify's startup is small but not zero; measure.
- **You already have module 10's router and it's fine.** Frameworks are for teams and growth, not for proving a point.

Reach for it when you want schemas at the boundary, encapsulated plugins, and `inject()` testing — which is most real services.

---

## 9. Files in this module

| File | What it demonstrates |
|---|---|
| `01-vs-handrolled.ts` | the same API both ways, side by side |
| `02-validation.ts` | body/query/params schemas, coercion, the stripping behaviour |
| `03-serialization.ts` | field stripping as security; the speed claim, measured |
| `04-plugins.ts` | encapsulation, decorators, scoped hooks, `fastify-plugin` |
| `05-hooks.ts` | the lifecycle order, measured; what belongs where |
| `06-errors-testing.ts` | the leak, a safe handler, `inject()` |
| `exercise.ts` | build a small API: schemas, a plugin, hooks, safe errors |

```bash
node src/11-fastify/index.ts
node scripts/test.ts 11
node scripts/test.ts --solutions 11
```

---

## 10. Check yourself

1. A response schema omits `passwordHash`. Your ORM returns it anyway. What does the client get?
2. Is `fast-json-stringify` faster than `JSON.stringify`? On what?
3. `additionalProperties: false` and a client sends an extra field — 400, or something else?
4. A decorator registered inside a plugin — can the parent app see it?
5. Which hook runs before the request body is read, and why does that matter for auth?
6. What does Fastify's default error handler send for an unhandled `Error` in production?
7. Why is `inject()` better than starting a server on port 0 for tests?
8. `GET /search?page=3` with an `integer` schema — what type is `req.query.page`?
