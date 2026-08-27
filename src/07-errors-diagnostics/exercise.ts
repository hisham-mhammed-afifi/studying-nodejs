/**
 * EXERCISE 07 — Error handling & request context for a real service
 *
 * Check yourself:  node scripts/test.ts 07
 * Solution:        ./solution.ts   (try first!)
 */

const TODO = (what: string): never => {
  throw new Error(`TODO: implement ${what}`);
};

// ─────────────────────────────────────────────────────────────────────────────

export interface AppErrorOptions {
  code: string;
  statusCode?: number;
  cause?: unknown;
  /** Extra structured fields for the log line. Never sent to the client. */
  details?: Record<string, unknown>;
}

/**
 * TASK 1 — `AppError`
 *
 * The base class for every error your code throws on purpose.
 *
 * Requirements:
 *   - `name` is the ACTUAL subclass name, without each subclass repeating it.
 *     (Hint: `new.target`.)
 *   - `code` (required), `statusCode` (default 500), `details` (default {}),
 *     `isOperational` = true.
 *   - Passes `cause` through to Error.
 *   - `Error.captureStackTrace` so the stack starts at the CALLER, not inside
 *     the constructor. Must not crash on engines without it.
 *   - `toJSON()` returns a plain, log-safe object: name, code, statusCode,
 *     message, details, stack, and a recursively serialised `cause`.
 *     Remember Error properties are NON-enumerable (§1.1).
 *   - `toResponse()` returns ONLY what is safe to send a client:
 *     `{ code, message }`. No stack, no details, no cause.
 */
export class AppError extends Error {
  readonly code!: string;
  readonly statusCode!: number;
  readonly details!: Record<string, unknown>;
  readonly isOperational: boolean = true;

  constructor(_message: string, _options: AppErrorOptions) {
    super();
    TODO("AppError");
  }

  toJSON(): Record<string, unknown> {
    return TODO("AppError#toJSON");
  }

  toResponse(): { code: string; message: string } {
    return TODO("AppError#toResponse");
  }
}

/**
 * TASK 2 — Three concrete subclasses.
 *
 *   NotFoundError(resource, id, cause?)
 *     message "user 42 not found", code "NOT_FOUND", status 404,
 *     details { resource, id }
 *
 *   ValidationError(field, reason, cause?)
 *     message "invalid email: must contain @", code "VALIDATION", status 400,
 *     details { field, reason }
 *
 *   UpstreamError(service, cause?)
 *     message "upstream service payments failed", code "UPSTREAM",
 *     status 502, details { service }
 */
export class NotFoundError extends AppError {
  constructor(_resource: string, _id: string, _cause?: unknown) {
    super("", { code: "" });
    TODO("NotFoundError");
  }
}

export class ValidationError extends AppError {
  constructor(_field: string, _reason: string, _cause?: unknown) {
    super("", { code: "" });
    TODO("ValidationError");
  }
}

export class UpstreamError extends AppError {
  constructor(_service: string, _cause?: unknown) {
    super("", { code: "" });
    TODO("UpstreamError");
  }
}

/**
 * TASK 3 — Cause-chain utilities.
 *
 * `causeChain` yields the error and every `cause` beneath it, outermost
 * first. MUST NOT loop forever if the chain is cyclic (err.cause === err).
 *
 * `rootCause` returns the deepest Error, or undefined for a non-Error.
 *
 * `findCause` returns the first error in the chain matching `predicate`.
 */
export function causeChain(_err: unknown): Generator<Error> {
  return TODO("causeChain");
}

export function rootCause(_err: unknown): Error | undefined {
  return TODO("rootCause");
}

export function findCause(_err: unknown, _predicate: (e: Error) => boolean): Error | undefined {
  return TODO("findCause");
}

/**
 * TASK 4 — `serializeError`
 *
 * Turn any thrown value into a plain object safe for JSON logging.
 *
 * Requirements:
 *   - Non-Errors → `{ value: String(x) }`.
 *   - Errors → name, message, own enumerable props, stack, and a recursively
 *     serialised cause.
 *   - Uses `toJSON()` if the error has one (so AppError controls its own shape).
 *   - Depth-limited: stop at 8 levels and emit `{ message: "[max depth]" }`.
 *   - Must not throw, ever. A logger that throws while logging an error is
 *     the worst possible failure.
 */
export function serializeError(_err: unknown): Record<string, unknown> {
  return TODO("serializeError");
}

/**
 * TASK 5 — `withRetry`
 *
 * Retry `fn` with exponential backoff and full jitter.
 *
 * Requirements:
 *   - Calls `fn(attempt)` with a 0-based attempt number.
 *   - At most `retries` RETRIES, i.e. up to `retries + 1` total calls.
 *   - Only retries when `isRetryable(err)` is true; otherwise rethrows
 *     immediately, unwrapped.
 *   - Delay before retry N is `random() * baseMs * 2**N`, capped at `maxMs`.
 *     Use the injectable `sleep` and `random` so tests are deterministic.
 *   - After exhausting retries, throws an AppError with code "RETRY_EXHAUSTED"
 *     whose `cause` is the LAST error, and `details.attempts` the total count.
 *   - Honours `signal`: an already-aborted signal throws before the first
 *     call; aborting mid-flight stops further retries.
 */
export interface RetryOptions {
  retries?: number;
  baseMs?: number;
  maxMs?: number;
  isRetryable?: (err: unknown) => boolean;
  signal?: AbortSignal;
  /** Injected for tests. Default: real timers. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected for tests. Default: Math.random. */
  random?: () => number;
}

export function withRetry<T>(_fn: (attempt: number) => Promise<T>, _options?: RetryOptions): Promise<T> {
  return TODO("withRetry");
}

/**
 * TASK 6 — `RequestContext`
 *
 * An AsyncLocalStorage wrapper for per-request metadata.
 *
 * Requirements:
 *   - `run(store, fn)` runs `fn` with `store` as the ambient context and
 *     returns its result (awaited).
 *   - `get()` returns the current store, or undefined outside a run.
 *   - `require()` returns the store, or throws an AppError with code
 *     "NO_CONTEXT" outside a run.
 *   - `extend(patch, fn)` runs `fn` with `{ ...current, ...patch }`. Works
 *     even with no current context.
 *   - `bind(fn)` returns a function that always executes in the context
 *     CAPTURED AT BIND TIME — the EventEmitter fix from §6.2.
 *   - Contexts must not leak between concurrent runs.
 */
export interface Store {
  requestId: string;
  userId?: string;
  [key: string]: unknown;
}

export class RequestContext {
  run<T>(_store: Store, _fn: () => T | Promise<T>): Promise<T> {
    return TODO("RequestContext#run");
  }

  get(): Store | undefined {
    return TODO("RequestContext#get");
  }

  require(): Store {
    return TODO("RequestContext#require");
  }

  extend<T>(_patch: Partial<Store>, _fn: () => T | Promise<T>): Promise<T> {
    return TODO("RequestContext#extend");
  }

  bind<A extends unknown[], R>(_fn: (...args: A) => R): (...args: A) => R {
    return TODO("RequestContext#bind");
  }
}
