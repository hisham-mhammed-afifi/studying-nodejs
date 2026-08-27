/**
 * SOLUTION 07 — reference implementation.
 */

import { AsyncLocalStorage, AsyncResource } from "node:async_hooks";
import { setTimeout as realSleep } from "node:timers/promises";
import type { AppErrorOptions, RetryOptions, Store } from "./exercise.ts";

// --- Tasks 1 & 2 -------------------------------------------------------------

export class AppError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly details: Record<string, unknown>;
  readonly isOperational: boolean = true;

  constructor(message: string, options: AppErrorOptions) {
    super(message, { cause: options.cause });
    // new.target is the constructor that was actually invoked, so every
    // subclass reports its own name with zero extra code. `this.name =
    // "AppError"` in the base would label NotFoundError as "AppError".
    this.name = new.target.name;
    this.code = options.code;
    this.statusCode = options.statusCode ?? 500;
    this.details = options.details ?? {};
    // Drop the constructor frames so the stack starts at the caller.
    // V8-only, hence the optional call.
    Error.captureStackTrace?.(this, new.target);
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      statusCode: this.statusCode,
      // message/stack are NON-enumerable on Error, so a spread or
      // JSON.stringify would drop them. They have to be listed explicitly.
      message: this.message,
      details: this.details,
      stack: this.stack,
      ...(this.cause !== undefined ? { cause: serializeError(this.cause) } : {}),
    };
  }

  toResponse(): { code: string; message: string } {
    // Deliberately narrow. `details` may hold internal ids, `stack` reveals
    // your directory layout, and `cause` can leak a database error verbatim.
    // The client gets a stable code and a human-readable message, nothing more.
    return { code: this.code, message: this.message };
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id: string, cause?: unknown) {
    super(`${resource} ${id} not found`, {
      code: "NOT_FOUND",
      statusCode: 404,
      cause,
      details: { resource, id },
    });
  }
}

export class ValidationError extends AppError {
  constructor(field: string, reason: string, cause?: unknown) {
    super(`invalid ${field}: ${reason}`, {
      code: "VALIDATION",
      statusCode: 400,
      cause,
      details: { field, reason },
    });
  }
}

export class UpstreamError extends AppError {
  constructor(service: string, cause?: unknown) {
    super(`upstream service ${service} failed`, {
      code: "UPSTREAM",
      statusCode: 502,
      cause,
      details: { service },
    });
  }
}

// --- Task 3 ------------------------------------------------------------------

export function* causeChain(err: unknown): Generator<Error> {
  let current: unknown = err;
  // The Set is not paranoia: `err.cause = err` and A→B→A both happen in real
  // code (usually from a retry wrapper re-wrapping its own error), and
  // without this the logger hangs the process while trying to log.
  const seen = new Set<unknown>();
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    yield current;
    current = current.cause;
  }
}

export function rootCause(err: unknown): Error | undefined {
  let last: Error | undefined;
  for (const e of causeChain(err)) last = e;
  return last;
}

export function findCause(err: unknown, predicate: (e: Error) => boolean): Error | undefined {
  for (const e of causeChain(err)) if (predicate(e)) return e;
  return undefined;
}

// --- Task 4 ------------------------------------------------------------------

export function serializeError(err: unknown, depth = 0): Record<string, unknown> {
  // A logger that throws while logging an error destroys the only evidence
  // you had. Everything below is wrapped, and the depth guard is hard.
  try {
    if (depth > 8) return { message: "[max depth]" };

    if (!(err instanceof Error)) {
      return { value: String(err), type: typeof err };
    }

    // Let the error describe itself if it knows how (AppError#toJSON).
    const maybeJson = (err as { toJSON?: () => Record<string, unknown> }).toJSON;
    if (typeof maybeJson === "function" && depth === 0) {
      return maybeJson.call(err);
    }

    return {
      name: err.name,
      message: err.message,
      // Own ENUMERABLE props only — this is where `code`, `statusCode` and
      // friends live. name/message/stack are non-enumerable, hence explicit.
      ...Object.fromEntries(Object.entries(err)),
      stack: err.stack,
      ...(err.cause !== undefined ? { cause: serializeError(err.cause, depth + 1) } : {}),
    };
  } catch (serializationError) {
    return { message: "[unserializable error]", reason: String(serializationError) };
  }
}

// --- Task 5 ------------------------------------------------------------------

const DEFAULT_RETRYABLE_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN", "EBUSY"]);

function defaultIsRetryable(err: unknown): boolean {
  if (err instanceof AppError) {
    // 429 and 5xx are worth retrying. A 4xx will fail identically next time.
    return err.statusCode === 429 || err.statusCode >= 500;
  }
  if (err instanceof Error && "code" in err && typeof err.code === "string") {
    return DEFAULT_RETRYABLE_CODES.has(err.code);
  }
  return false;
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    retries = 3,
    baseMs = 100,
    maxMs = 30_000,
    isRetryable = defaultIsRetryable,
    signal,
    sleep = (ms: number) => realSleep(ms),
    random = Math.random,
  } = options;

  signal?.throwIfAborted(); // don't even make the first call if cancelled

  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;

      // Rethrow non-retryable errors UNWRAPPED. Wrapping a ValidationError in
      // a RETRY_EXHAUSTED would hide its 400 from the handler above.
      if (!isRetryable(err)) throw err;
      if (attempt === retries) break;

      signal?.throwIfAborted();

      // Full jitter: random() * ceiling, not ceiling + random(). Without
      // jitter, a thousand clients that failed together retry together and
      // rebuild the stampede that caused the outage.
      const ceiling = Math.min(baseMs * 2 ** attempt, maxMs);
      await sleep(random() * ceiling);

      signal?.throwIfAborted();
    }
  }

  throw new AppError(`operation failed after ${retries + 1} attempts`, {
    code: "RETRY_EXHAUSTED",
    statusCode: 503,
    cause: lastError, // ← the actual failure is never lost
    details: { attempts: retries + 1 },
  });
}

// --- Task 6 ------------------------------------------------------------------

export class RequestContext {
  readonly #als = new AsyncLocalStorage<Store>();

  async run<T>(store: Store, fn: () => T | Promise<T>): Promise<T> {
    // run() scopes the store to this async subtree. Prefer it over
    // enterWith(), which mutates the current context with no way out and
    // can bleed a user id into unrelated work.
    return this.#als.run(store, async () => fn());
  }

  get(): Store | undefined {
    return this.#als.getStore();
  }

  require(): Store {
    const store = this.#als.getStore();
    if (!store) {
      throw new AppError("no request context available", {
        code: "NO_CONTEXT",
        statusCode: 500,
      });
    }
    return store;
  }

  async extend<T>(patch: Partial<Store>, fn: () => T | Promise<T>): Promise<T> {
    const current = this.#als.getStore();
    // Spread into a NEW object rather than mutating: the parent scope must
    // not see changes made by a child, or you get action-at-a-distance.
    const next = { ...(current ?? { requestId: "unknown" }), ...patch } as Store;
    return this.run(next, fn);
  }

  bind<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    // Captures the CURRENT context and re-enters it on every call. This is
    // the fix for the EventEmitter trap: without it a listener sees the
    // context of whoever EMITTED, not whoever registered.
    return AsyncResource.bind(fn);
  }
}
