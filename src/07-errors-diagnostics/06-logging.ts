/**
 * 06 — Structured logging
 *
 * Run:  node src/07-errors-diagnostics/06-logging.ts
 */

import { AsyncLocalStorage } from "node:async_hooks";

console.log("=== 1. String logs vs structured logs ===");
{
  const userId = "42";
  const err = new Error("payment declined");

  console.log("  ✗ " + `User ${userId} failed checkout: ${err.message}`);
  console.log(`  ✓ ${JSON.stringify({ level: "error", msg: "checkout failed", userId, err: err.message })}`);

  console.log(`
  The string version cannot be:
    • grouped     — every line is unique, so "how often does this happen?"
                    needs a regex, and the regex breaks when someone edits
                    the message
    • filtered    — "show me everything for user 42" is a substring search
                    that also matches user 421
    • aggregated  — no numeric fields, so no dashboards

  Rule: the MESSAGE is a constant. Everything variable goes in a FIELD.
`);
}

console.log("=== 2. A minimal structured logger ===");
{
  type Level = "debug" | "info" | "warn" | "error" | "fatal";
  const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40, fatal: 50 };

  const context = new AsyncLocalStorage<Record<string, unknown>>();

  const REDACT = new Set(["password", "token", "authorization", "cookie", "secret", "apiKey", "cardNumber"]);

  function redact(value: unknown, depth = 0): unknown {
    if (depth > 6 || value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACT.has(k) ? "[REDACTED]" : redact(v, depth + 1);
    }
    return out;
  }

  function serializeError(err: unknown, depth = 0): Record<string, unknown> {
    if (depth > 8) return { message: "[cause chain too deep]" };
    if (!(err instanceof Error)) return { value: String(err) };
    return {
      name: err.name,
      message: err.message,
      ...Object.fromEntries(Object.entries(err)),
      stack: err.stack?.split("\n").slice(0, 3).join(" | "),
      ...(err.cause !== undefined ? { cause: serializeError(err.cause, depth + 1) } : {}),
    };
  }

  const minLevel = LEVELS[(process.env["LOG_LEVEL"] as Level) ?? "info"];

  function log(level: Level, fields: Record<string, unknown>, msg: string) {
    if (LEVELS[level] < minLevel) return; // cheap early exit on a hot path
    const { err, ...rest } = fields;
    const line = {
      time: new Date().toISOString(),
      level,
      msg,
      ...context.getStore(), // requestId etc., with no plumbing
      ...(redact(rest) as Record<string, unknown>),
      ...(err !== undefined ? { err: serializeError(err) } : {}),
    };
    console.log("  " + JSON.stringify(line));
  }

  const logger = {
    debug: (f: Record<string, unknown>, m: string) => log("debug", f, m),
    info: (f: Record<string, unknown>, m: string) => log("info", f, m),
    warn: (f: Record<string, unknown>, m: string) => log("warn", f, m),
    error: (f: Record<string, unknown>, m: string) => log("error", f, m),
  };

  await context.run({ requestId: "req-7f3a", userId: "42" }, async () => {
    logger.info({ route: "POST /checkout" }, "request started");

    logger.info(
      { user: { id: "42", email: "a@b.c", password: "hunter2", token: "eyJhbG..." } },
      "loaded user",
    );

    const err = new Error("checkout failed", {
      cause: Object.assign(new Error("gateway timeout"), { code: "ETIMEDOUT" }),
    });
    logger.error({ err, orderId: "ord-991", amountCents: 4999 }, "checkout failed");

    logger.debug({ sql: "SELECT 1" }, "this is below LOG_LEVEL and is not printed");
  });

  console.log(`
  Note what happened:
    • requestId and userId appeared on EVERY line, from AsyncLocalStorage —
      no parameter passing (module 07 §6)
    • password and token were redacted at the serialiser, not at the call
      site — you cannot forget to do it
    • the error was expanded WITH its cause chain, instead of {}
    • the debug line was skipped before any object was built
`);
}

console.log("=== 3. Rules that matter ===");
console.log(`
  1. One JSON object per line (NDJSON). Aggregators parse it; humans use jq:

         node app.ts | jq 'select(.level=="error") | {msg, requestId, err}'

  2. Constant message, variable fields. "checkout failed" + orderId, never
     "checkout failed for order ord-991".

  3. Serialise errors properly, including cause (§1 of 01-errors.ts).

  4. Redact centrally. A redaction list at the serialiser cannot be
     forgotten; a redaction at each call site will be.

  5. Correlation id on every line. Propagate an incoming x-request-id
     header if present, generate one if not, and echo it in the response so
     a user can quote it in a bug report.

  6. Log at the right level:
       debug  developer detail, off in production
       info   business events — request served, order placed
       warn   degraded but working — cache miss, fallback used, retry
       error  a request failed; a human may need to look
       fatal  the process is going down

  7. Write to stdout, not to files. Let the platform handle rotation,
     shipping, and retention. A process that manages its own log files
     will eventually fill a disk (module 06: ENOSPC).

  8. Never log: passwords, tokens, cookies, full card numbers, personal
     data you have no reason to keep.
`);

console.log("=== 4. Use pino ===");
console.log(`
  Everything above in ~10 lines, faster, and battle-tested:

      import pino from "pino";

      const logger = pino({
        level: process.env.LOG_LEVEL ?? "info",
        redact: ["req.headers.authorization", "*.password", "*.token"],
        formatters: { level: (label) => ({ level: label }) },
      });

      const child = logger.child({ requestId });
      child.error({ err, orderId }, "checkout failed");

  pino serialises Error (with cause), redacts by path, writes NDJSON, and
  is fast enough to leave on in production. \`pino-pretty\` makes it readable
  in development:

      node app.ts | npx pino-pretty

  The point of writing it by hand once is knowing what it's doing for you —
  and why {"err":{}} happens to everyone who doesn't.
`);
