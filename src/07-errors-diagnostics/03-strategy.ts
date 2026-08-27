/**
 * 03 — Operational vs programmer errors, and crash strategy
 *
 * Run:  node src/07-errors-diagnostics/03-strategy.ts
 */

import { spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

class AppError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly isOperational = true;
  constructor(message: string, opts: { code: string; statusCode?: number; cause?: unknown }) {
    super(message, { cause: opts.cause });
    this.name = new.target.name;
    this.code = opts.code;
    this.statusCode = opts.statusCode ?? 500;
  }
}

console.log("=== 1. The distinction ===");
console.log(`
                    OPERATIONAL                    PROGRAMMER
  what              the world misbehaved           your code is wrong
  examples          ECONNREFUSED, 404, timeout,    undefined is not a function,
                    invalid input, disk full       failed invariant, bad cast
  predictable?      yes — you can enumerate them   no
  response          handle it: retry, fall back,   CRASH. log, flush, exit 1,
                    return 4xx/5xx                 let the supervisor restart

  The failure mode to avoid is a blanket

      catch (err) { logger.error(err); }

  which swallows genuine bugs. A process running on broken invariants
  produces WRONG DATA, which is far worse than a restart.
`);

console.log("=== 2. Triage in a request handler ===");
{
  function handle(err: unknown): { status: number; body: unknown } {
    if (err instanceof AppError && err.isOperational) {
      return { status: err.statusCode, body: { code: err.code, message: err.message } };
    }
    // Not ours, or not operational → a bug. Log it fully and return an
    // opaque 500. Never leak an internal message or stack to a client.
    //
    // Note the String(err) fallback: someone WILL throw a string, and
    // `(err as Error).message` would print "undefined" for it.
    console.log("    [would log fatal + alert]:", err instanceof Error ? err.message : String(err));
    return { status: 500, body: { code: "INTERNAL" } };
  }

  console.log("  operational:", JSON.stringify(handle(new AppError("user 42 not found", { code: "NOT_FOUND", statusCode: 404 }))));
  console.log("  programmer: ", JSON.stringify(handle(new TypeError("x.foo is not a function"))));
  console.log("  non-Error:  ", JSON.stringify(handle("some string someone threw")));
}

console.log("\n=== 3. Retry only what is retryable ===");
{
  const RETRYABLE = new Set(["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN", "EBUSY"]);

  function isRetryable(err: unknown): boolean {
    if (err instanceof Error && "code" in err && typeof err.code === "string") {
      if (RETRYABLE.has(err.code)) return true;
    }
    // HTTP: 429 and 5xx are retryable; 4xx is not — retrying a 400 just
    // sends the same bad request again.
    if (err instanceof AppError) return err.statusCode === 429 || err.statusCode >= 500;
    return false;
  }

  async function withRetry<T>(
    fn: (attempt: number) => Promise<T>,
    opts: { retries?: number; baseMs?: number } = {},
  ): Promise<T> {
    const { retries = 3, baseMs = 10 } = opts;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await fn(attempt);
      } catch (err) {
        lastErr = err;
        if (attempt === retries || !isRetryable(err)) break;
        // Exponential backoff with FULL JITTER. Without jitter, a thousand
        // clients that failed together retry together — you rebuild the
        // thundering herd that caused the outage.
        const ceiling = baseMs * 2 ** attempt;
        const delay = Math.random() * ceiling;
        console.log(`    attempt ${attempt + 1} failed (${(err as Error).message}), retrying in ${delay.toFixed(0)}ms`);
        await sleep(delay);
      }
    }
    throw new Error(`failed after ${retries + 1} attempts`, { cause: lastErr });
  }

  // Succeeds on the third try.
  let calls = 0;
  const result = await withRetry(async () => {
    calls++;
    if (calls < 3) throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
    return "ok";
  });
  console.log(`  transient failure → ${result} after ${calls} attempts ✓`);

  // Never retried: a 400 is not going to succeed on the second attempt.
  calls = 0;
  try {
    await withRetry(async () => {
      calls++;
      throw new AppError("invalid email", { code: "VALIDATION", statusCode: 400 });
    });
  } catch (err) {
    console.log(`  validation error → gave up after ${calls} attempt (not retryable) ✓`);
    console.log("    cause preserved:", ((err as Error).cause as Error).message);
  }

  console.log(`
  Three rules for retries:
    1. Only retry idempotent operations. Retrying a POST that already
       charged a card charges it twice.
    2. Only retry retryable errors. A 400 will always be a 400.
    3. Always jitter the backoff, and always cap the total attempts.
`);
}

console.log("=== 4. Unhandled rejections terminate the process ===");
{
  const code = `
    Promise.reject(new Error("nobody caught me"));
    setTimeout(() => console.log("UNREACHABLE"), 50);
  `;
  const r = spawnSync(process.execPath, ["-e", code], { encoding: "utf8" });
  console.log("  child exit code:", r.status, "← non-zero, since Node 15");
  console.log("  stderr mentions:", r.stderr.includes("nobody caught me") ? "the error ✓" : "(not found)");
  console.log(`
  This is the RIGHT default. Do not turn it off with
  --unhandled-rejections=warn: an unhandled rejection means a code path you
  believed was covered is not, and continuing runs on an unknown state.
`);
}

console.log("=== 5. The last line of defence ===");
console.log(`
  process.on("uncaughtException", (err, origin) => {
    logger.fatal({ err, origin }, "uncaught exception");
    // Try to drain in-flight work — but never wait forever.
    server.close(() => process.exit(1));
    setTimeout(() => process.exit(1), 10_000).unref();
  });

  process.on("unhandledRejection", (reason) => {
    logger.fatal({ reason }, "unhandled rejection");
    process.exit(1);
  });

  LOG AND DIE. Do not "recover". After an uncaught exception some function
  was interrupted halfway: a lock is held, a transaction is open, a counter
  is half-incremented. You do not know which one.

  Note the unref() on the watchdog (module 02 §3.4) — otherwise the timer
  itself keeps the process alive for the full 10s even when close() was fast.
`);

console.log("=== 6. Graceful degradation ===");
{
  // For operational errors, "handle it" often means a fallback, not a retry.
  async function getUserPreferences(id: string): Promise<{ theme: string; source: string }> {
    try {
      throw Object.assign(new Error("cache unreachable"), { code: "ECONNREFUSED" });
    } catch (err) {
      // The cache is a nice-to-have. Log at WARN, not ERROR, and carry on —
      // an alert that fires for a degraded-but-working path trains people
      // to ignore alerts.
      console.log("    [warn] preference cache unavailable:", (err as Error).message);
      return { theme: "light", source: "default", ...(id ? {} : {}) };
    }
  }
  console.log("  fallback result:", await getUserPreferences("42"));

  console.log(`
  Decide per dependency, in advance:

    CRITICAL    (primary database)   → fail the request
    DEGRADABLE  (cache, search)      → fall back, log a warning, serve on
    OPTIONAL    (analytics, metrics) → swallow entirely, never block a user

  Writing that table down before the incident is most of the work.
`);
}

console.log("=== 7. Summary ===");
console.log(`
  ✓ Mark your own errors isOperational and give them a stable code.
  ✓ Catch operational errors; let programmer errors reach the top.
  ✓ Retry only idempotent operations, only on retryable errors, with jitter.
  ✓ On uncaughtException / unhandledRejection: log, flush, exit non-zero.
  ✓ Classify every dependency as critical / degradable / optional.
  ✗ Never catch(err) {} — the empty catch is how bugs become mysteries.
  ✗ Never return an internal message or stack to a client.
`);
