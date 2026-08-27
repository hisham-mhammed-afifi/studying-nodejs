# 12 — Config, Validation & Structured Logging

Two unglamorous subjects that decide whether a 3am incident takes five minutes or five hours.

Module 01 §4.2 established the core fact: **every environment variable is `string | undefined`**. This module turns that into a typed, validated, fail-fast config object — and then makes sure the logs around it are actually usable.

```bash
npm install @sinclair/typebox pino
```

---

## 1. Config: fail fast, or fail at 3am

There are only two options for a missing or malformed setting:

```ts
// ✗ fail LATE — at the first request that touches it, in production
const url = process.env.DATABASE_URL;
await connect(url!);          // undefined → a confusing error, hours later

// ✓ fail FAST — at startup, before the process accepts traffic
const config = loadConfig(process.env);   // throws with every problem listed
```

Fail-fast means a bad deploy dies in the health check and rolls back. Fail-late means it serves 500s until someone notices.

### 1.1 Report *every* error at once

```
✗ Invalid configuration:
    PORT: Expected integer
    DATABASE_URL: Expected required property
    LOG_LEVEL: Expected one of debug|info|warn|error
```

Not one at a time. Someone fixing a `.env` file should need one round trip, not four.

### 1.2 Validate once, at the edge

```ts ignore
// ✗ process.env scattered through the codebase
if (process.env.FEATURE_X === "true") { … }      // in nine files

// ✓ one typed object, imported everywhere
import { config } from "./config.ts";
if (config.featureX) { … }                        // a real boolean
```

The typed object is also *documentation*: one file lists every setting, its type, its default, and whether it's required.

---

## 2. TypeBox: write the shape once

TypeScript types vanish at runtime (module 01) — Node **erases** them. So a `.env` value is `unknown` no matter what you annotate it as. You need a runtime schema *and* a compile-time type, and maintaining both by hand guarantees drift.

TypeBox generates the type **from** the schema:

```ts
import { Type, type Static } from "@sinclair/typebox";

const ConfigSchema = Type.Object({
  PORT: Type.Integer({ minimum: 1, maximum: 65535, default: 3000 }),
  NODE_ENV: Type.Union([
    Type.Literal("development"),
    Type.Literal("production"),
    Type.Literal("test"),
  ], { default: "development" }),
  DATABASE_URL: Type.String({ minLength: 1 }),
});

type Config = Static<typeof ConfigSchema>;
// → { PORT: number; NODE_ENV: "development" | "production" | "test"; DATABASE_URL: string }
```

One definition, two outputs. `NODE_ENV` even narrows to a union of literals.

### 2.1 Convert, default, then check — in that order

```ts
import { Value } from "@sinclair/typebox/value";

const converted = Value.Convert(ConfigSchema, process.env);  // "8080" → 8080
const withDefaults = Value.Default(ConfigSchema, converted); // fill in defaults
if (!Value.Check(ConfigSchema, withDefaults)) {
  const errors = [...Value.Errors(ConfigSchema, withDefaults)];
  throw new ConfigError(errors);
}
```

`Convert` is what turns `"8080"` into `8080` and `"true"` into `true`. Skip it and every numeric check fails, because everything from `process.env` is a string.

Same schemas work as Fastify route schemas (module 11) — one vocabulary for config, requests and responses.

> Zod is the popular alternative and is excellent. TypeBox's advantage here is that it *is* JSON Schema, so Fastify consumes it directly with no bridge.

---

## 3. Layering

```
defaults  <  config file  <  environment  <  CLI flags
   (lowest precedence)                        (highest)
```

```ts
const config = load({
  ...defaults,
  ...(await readConfigFile(path)),   // optional
  ...fromEnv(process.env),
  ...parseArgs(process.argv),        // module 01 §4.1
});
```

Node loads `.env` files natively since 20.6 — no `dotenv`:

```bash
node --env-file=.env --env-file=.env.local app.ts   # later files win
```

⚠ `.env` files are for **development**. In production the environment comes from the orchestrator, a secret manager, or mounted files — never a file in the repo.

---

## 4. Secrets

| Rule | Why |
|---|---|
| Never commit them | git history is forever; rotating is the only fix |
| Never log them | §6.2 — and redaction has holes |
| Never put them in an error message | module 07 §4: those reach clients |
| Prefer mounted files over env vars | env leaks via `/proc`, crash dumps, `process.report` |
| Make `toString`/`toJSON` redact | so an accidental log or template is safe |

That last one is worth doing:

```ts
Object.defineProperty(config, "toJSON", {
  value: () => ({ ...config, DATABASE_URL: "[REDACTED]" }),
  enumerable: false,
});
```

Now `logger.info({ config })` is safe by construction, not by discipline.

---

## 5. pino

```ts
import pino from "pino";

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: ["password", "*.token", "req.headers.authorization"],
});
```

Everything module 07 §7 said to do by hand, done properly and fast. It writes NDJSON, serialises `Error` with its `cause` chain, and is quick enough to leave on in production.

### 5.1 Child loggers are the correlation mechanism

```ts
const requestLogger = logger.child({ requestId, userId });
requestLogger.info({ route: "/users/:id" }, "handled");
// → {"level":30,"requestId":"r1","userId":"u9","route":"/users/:id","msg":"handled"}
```

Bind once; every subsequent line carries the fields. Combine with `AsyncLocalStorage` (module 07 §6) and nothing has to thread a logger through call signatures.

### 5.1a ⚠ Two error-logging traps

```ts
logger.error({ err }, "failed");     // ✓ the key MUST be "err"
logger.error({ error: err }, "…");   // ✗ → {} — the serializer is keyed on "err"
```

And the **default** `err` serializer *flattens* the cause into the message rather than nesting it:

```
default        → {"type":"Error","message":"checkout failed: gateway timeout"}
errWithCause   → {"type":"Error","message":"checkout failed",
                  "cause":{"type":"Error","message":"gateway timeout","code":"ETIMEDOUT"}}
```

Module 07 §2 says to rewrap errors with `cause` everywhere — so if you do, configure the serializer that keeps it queryable:

```ts
pino({ serializers: { err: pino.stdSerializers.errWithCause } });
```

### 5.2 Levels are numbers

```
trace 10 · debug 20 · info 30 · warn 40 · error 50 · fatal 60
```

The comparison is numeric and the check happens **before** the object is built, so a suppressed `logger.debug({ expensive() }, "…")` still evaluates `expensive()`. Guard genuinely costly payloads:

```ts
if (logger.isLevelEnabled("debug")) logger.debug({ dump: serialize(huge) }, "state");
```

---

## 6. Redaction, and its limits

```ts
pino({ redact: ["password", "*.token", "req.headers.authorization"] });
```

```
{"userId":"u1","password":"[Redacted]","nested":{"token":"[Redacted]"},"msg":"hello"}
```

Path-based and fast. But it is **exact-path matching**. Measured in `06-redaction.ts` with `redact: ["password", "*.token"]`:

| Case | Result |
|---|---|
| `{ password }` | redacted ✓ |
| `{ session: { token } }` | redacted ✓ |
| `{ user: { password } }` | **LEAKED** |
| `{ a: { b: { token } } }` | **LEAKED** |
| `{ Password }` (case) | **LEAKED** |
| `{ pwd }` (different name) | **LEAKED** |
| `{ users: [{ password }] }` | **LEAKED** |
| `{ note: "the password is hunter2" }` | **LEAKED** |
| `{ dsn: "postgres://u:hunter2@db" }` | **LEAKED** |

**Seven of nine leaked.** `*.token` matches exactly one level of nesting — not two, not zero — and nothing helps with a secret embedded in a string.

So redaction is a **safety net, not a strategy**, and a denylist has to anticipate every field name anyone will ever add. The strategy is an allowlist: log `userId`, not `user`; `hasToken: true`, not the token. A pino **serializer** on a key does this centrally:

```ts ignore
serializers: {
  user: (u) => ({ id: u.id, emailDomain: u.email?.split("@")[1] }),
}
```

Same principle as Fastify's response schemas (module 11 §3.1): pick what goes *in*, rather than trying to name everything that must stay out.

### 6.1 What to log

| Do | Don't |
|---|---|
| ids — user, request, order, trace | whole objects "just in case" |
| the route **pattern** (`/users/:id`) | the concrete path (cardinality — module 10 §3) |
| durations, counts, status codes | passwords, tokens, cookies, card numbers |
| a stable `msg` + variable fields | interpolated message strings |
| errors with their `cause` chain | `String(err)` — you lose the stack |

### 6.2 Volume

Logs cost money and attention. At 1,000 req/s, one `info` line per request is 86M lines a day.

- `info` for business events, not every internal step.
- Sample high-volume success paths; never sample errors.
- Rely on `warn`/`error` being *rare enough to read*.

---

## 7. Wiring it together

```ts ignore
// config.ts — validated once, at import, before anything else runs
export const config = loadConfig(process.env);

// logger.ts
export const logger = pino({ level: config.LOG_LEVEL, redact: [...] });

// server.ts
app.addHook("onRequest", async (req) => {
  req.log = logger.child({ requestId: req.id });        // Fastify does this for you
});
```

Fastify already gives you per-request child loggers with a request id (module 11). `req.log.info(...)` is correlated automatically — one of the better reasons to use it.

---

## 8. Files in this module

| File | What it demonstrates |
|---|---|
| `01-config.ts` | fail-fast vs fail-late, all-errors-at-once, the string-typed env |
| `02-typebox.ts` | one schema → runtime validation + a TS type; Convert/Default/Check |
| `03-layering.ts` | precedence, `--env-file`, CLI flags, secrets handling |
| `04-pino.ts` | levels, child loggers, serializers, transports, the level-check cost |
| `05-request-logging.ts` | request ids, `AsyncLocalStorage`, Fastify's `req.log` |
| `06-redaction.ts` | where path-based redaction fails, and what to do instead |
| `exercise.ts` | build `loadConfig` and `createLogger`, then wire them up |

```bash
node src/12-config-logging/index.ts
node scripts/test.ts 12
node scripts/test.ts --solutions 12
```

---

## 9. Check yourself

1. `process.env.PORT` is `"3000"`. What is `typeof config.PORT` after validation, and what made it so?
2. Why report every config error at once rather than throwing on the first?
3. TypeScript says `config.PORT: number`. What does that guarantee at runtime?
4. `redact: ["password"]` is configured. Is `logger.info({ user: { password } })` safe?
5. Your `debug` level is off. Does `logger.debug({ data: expensive() })` call `expensive()`?
6. Where should a secret live in production, and why not an env var?
7. What's wrong with `logger.info(\`user ${id} failed\`)`?
8. At 1,000 req/s, how many log lines a day is one `info` per request?
