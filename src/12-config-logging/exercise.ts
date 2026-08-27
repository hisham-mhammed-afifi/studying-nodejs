/**
 * EXERCISE 12 — Config and logging you'd actually ship
 *
 * Check yourself:  node scripts/test.ts 12
 * Solution:        ./solution.ts   (try first!)
 */

import type { Writable } from "node:stream";
import type { Logger } from "pino";

const TODO = (what: string): never => {
  throw new Error(`TODO: implement ${what}`);
};

export class ConfigError extends Error {
  override readonly name = "ConfigError";
  /** One entry per problem, formatted "FIELD: reason". */
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super(`Invalid configuration:\n  - ${issues.join("\n  - ")}`);
    this.issues = issues;
  }
}

export interface AppConfig {
  PORT: number;
  HOST: string;
  NODE_ENV: "development" | "production" | "test";
  LOG_LEVEL: "debug" | "info" | "warn" | "error";
  DATABASE_URL: string;
  API_TOKEN: string;
  ENABLE_METRICS: boolean;
  REQUEST_TIMEOUT_MS: number;
}

/**
 * TASK 1 — `loadConfig`
 *
 * Turn a raw environment into a validated, typed `AppConfig`.
 *
 * Defaults:  PORT 3000 · HOST "127.0.0.1" · NODE_ENV "development"
 *            LOG_LEVEL "info" · ENABLE_METRICS false
 *            REQUEST_TIMEOUT_MS 30000
 * Required:  DATABASE_URL (non-empty), API_TOKEN (non-empty)
 *
 * Requirements:
 *   - COERCE: every value arrives as a string. PORT/REQUEST_TIMEOUT_MS must
 *     come back as `number`, ENABLE_METRICS as `boolean` (§1).
 *   - ENABLE_METRICS accepts "true"/"false"/"1"/"0"/"yes"/"no"/"on"/"off",
 *     case-insensitively. Anything else is an error — note that the STRING
 *     "false" is truthy, so `Boolean(v)` is not a parser.
 *   - PORT: integer 1..65535. REQUEST_TIMEOUT_MS: integer >= 100.
 *   - NODE_ENV and LOG_LEVEL must be one of their listed values.
 *   - Report EVERY problem at once, via ConfigError (§1.1). One issue per
 *     field, prefixed with the field name and ": ".
 *   - The returned object is FROZEN.
 *   - It also carries a non-enumerable `toJSON` that redacts any key
 *     matching /pass|secret|token|key|credential|url/i to "[REDACTED]" —
 *     so `JSON.stringify(config)` is safe by construction (§4).
 *     `toJSON` must not appear in Object.keys(config).
 */
export function loadConfig(_env: NodeJS.ProcessEnv): Readonly<AppConfig> {
  return TODO("loadConfig");
}

export interface LoggerOptions {
  level?: string;
  /** Where to write. Defaults to stdout. */
  destination?: Writable;
  /** Extra fields bound to every line. */
  base?: Record<string, unknown>;
}

/**
 * TASK 2 — `createLogger`
 *
 * A pino logger configured the way §5–6 argue for.
 *
 * Requirements:
 *   - Level from options, else "info".
 *   - Writes to `destination` when given.
 *   - `base` fields appear on every line.
 *   - Uses `pino.stdSerializers.errWithCause` for the `err` key, so a
 *     rewrapped error keeps a STRUCTURED cause chain rather than being
 *     flattened into the message (§5).
 *   - Redacts at least: password, *.password, token, *.token,
 *     authorization, *.authorization, apiKey, *.apiKey,
 *     req.headers.authorization, req.headers.cookie.
 *   - Adds a `user` SERIALIZER that reduces any logged user object to
 *     `{ id, emailDomain }` — an allowlist, so a new secret field on the
 *     user model cannot leak (§6.4). A user without an email yields
 *     `{ id, emailDomain: undefined }`.
 */
export function createLogger(_options?: LoggerOptions): Logger {
  return TODO("createLogger");
}

/**
 * TASK 3 — `withRequestContext` / `getRequestLogger`
 *
 * Request-scoped logging with no parameter passing (§5-request-logging).
 *
 * Requirements:
 *   - `withRequestContext(logger, fields, fn)` runs `fn` with a CHILD
 *     logger bound to `fields`, retrievable anywhere inside — across
 *     awaits, timers and Promise.all.
 *   - `getRequestLogger()` returns that child, or `undefined` outside a
 *     context.
 *   - Concurrent contexts must not leak into each other.
 *   - Nesting extends: an inner context's logger carries BOTH sets of
 *     fields.
 *   - Returns whatever `fn` resolves to.
 */
export function withRequestContext<T>(
  _logger: Logger,
  _fields: Record<string, unknown>,
  _fn: () => T | Promise<T>,
): Promise<T> {
  return TODO("withRequestContext");
}

export function getRequestLogger(): Logger | undefined {
  return TODO("getRequestLogger");
}
