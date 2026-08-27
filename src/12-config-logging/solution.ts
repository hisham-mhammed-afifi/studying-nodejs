/**
 * SOLUTION 12 — reference implementation.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import pino, { type Logger } from "pino";
import { type AppConfig, ConfigError, type LoggerOptions } from "./exercise.ts";

// --- Task 1 ------------------------------------------------------------------

const NODE_ENVS = ["development", "production", "test"] as const;
const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

const TRUTHY = new Set(["1", "true", "yes", "on"]);
const FALSY = new Set(["0", "false", "no", "off"]);

/** Anything whose NAME suggests a secret is redacted by toJSON. */
const SECRET_KEY = /pass|secret|token|key|credential|url/i;

/**
 * A collector so every field is checked even after one fails — the whole
 * point of §1.1. Throwing on the first problem means four deploys to fix
 * four typos.
 */
class Issues {
  readonly list: string[] = [];
  add(field: string, reason: string): void {
    this.list.push(`${field}: ${reason}`);
  }
}

function readString(env: NodeJS.ProcessEnv, key: string, issues: Issues, fallback?: string): string {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") {
    if (fallback !== undefined) return fallback;
    issues.add(key, "required, but not set");
    return "";
  }
  return raw;
}

function readInt(
  env: NodeJS.ProcessEnv,
  key: string,
  issues: Issues,
  { min, max, fallback }: { min: number; max: number; fallback: number },
): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;

  // Number("") and Number(" ") are both 0 — go through the trimmed string
  // and demand a clean integer (module 01 §4.2).
  const n = Number(raw.trim());
  if (!Number.isInteger(n)) {
    issues.add(key, `expected an integer, got ${JSON.stringify(raw)}`);
    return fallback;
  }
  if (n < min || n > max) {
    issues.add(key, `expected ${min}-${max}, got ${n}`);
    return fallback;
  }
  return n;
}

function readBool(env: NodeJS.ProcessEnv, key: string, issues: Issues, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;

  const v = raw.trim().toLowerCase();
  if (TRUTHY.has(v)) return true;
  if (FALSY.has(v)) return false;

  // Boolean("false") is TRUE, which is why this needs a real parser.
  issues.add(key, `expected a boolean (true/false/1/0/yes/no/on/off), got ${JSON.stringify(raw)}`);
  return fallback;
}

function readEnum<T extends string>(
  env: NodeJS.ProcessEnv,
  key: string,
  issues: Issues,
  allowed: readonly T[],
  fallback: T,
): T {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;

  const found = allowed.find((a) => a === raw);
  if (found === undefined) {
    issues.add(key, `expected one of ${allowed.join("|")}, got ${JSON.stringify(raw)}`);
    return fallback;
  }
  return found;
}

export function loadConfig(env: NodeJS.ProcessEnv): Readonly<AppConfig> {
  const issues = new Issues();

  const config: AppConfig = {
    PORT: readInt(env, "PORT", issues, { min: 1, max: 65535, fallback: 3000 }),
    HOST: readString(env, "HOST", issues, "127.0.0.1"),
    NODE_ENV: readEnum(env, "NODE_ENV", issues, NODE_ENVS, "development"),
    LOG_LEVEL: readEnum(env, "LOG_LEVEL", issues, LOG_LEVELS, "info"),
    DATABASE_URL: readString(env, "DATABASE_URL", issues),
    API_TOKEN: readString(env, "API_TOKEN", issues),
    ENABLE_METRICS: readBool(env, "ENABLE_METRICS", issues, false),
    REQUEST_TIMEOUT_MS: readInt(env, "REQUEST_TIMEOUT_MS", issues, {
      min: 100,
      max: Number.MAX_SAFE_INTEGER,
      fallback: 30_000,
    }),
  };

  // Every field was examined before we throw, so the message lists them all.
  if (issues.list.length > 0) throw new ConfigError(issues.list);

  // Redaction by construction: an accidental logger.info({ config }) or a
  // JSON.stringify in an error message is safe without anyone remembering.
  // enumerable:false keeps it out of Object.keys and the spread operator.
  Object.defineProperty(config, "toJSON", {
    enumerable: false,
    configurable: true,
    value: () =>
      Object.fromEntries(
        Object.entries(config).map(([k, v]) => [k, SECRET_KEY.test(k) ? "[REDACTED]" : v]),
      ),
  });

  // Freeze AFTER defining toJSON — freezing first would make defineProperty
  // throw in strict mode.
  return Object.freeze(config);
}

// --- Task 2 ------------------------------------------------------------------

export function createLogger(options: LoggerOptions = {}): Logger {
  const { level = "info", destination, base } = options;

  const config: pino.LoggerOptions = {
    level,
    ...(base ? { base } : {}),

    serializers: {
      // The DEFAULT err serializer flattens cause into the message string,
      // so you cannot query on the inner error. errWithCause keeps it
      // structured (04-pino.ts §5) — which matters because module 07 §2
      // says to rewrap with cause everywhere.
      err: pino.stdSerializers.errWithCause,

      // An ALLOWLIST for a known shape. A denylist has to anticipate every
      // field anyone will ever add to the user model; this cannot (§6.4).
      user: (u: Record<string, unknown>) => {
        const email = u["email"];
        return {
          id: u["id"],
          emailDomain: typeof email === "string" ? email.split("@")[1] : undefined,
        };
      },
    },

    // The safety net, not the strategy. Exact-path matching, so each depth
    // needs its own entry (§6.2).
    redact: [
      "password",
      "*.password",
      "token",
      "*.token",
      "authorization",
      "*.authorization",
      "apiKey",
      "*.apiKey",
      "req.headers.authorization",
      "req.headers.cookie",
    ],
  };

  return destination ? pino(config, destination) : pino(config);
}

// --- Task 3 ------------------------------------------------------------------

const requestStore = new AsyncLocalStorage<{ log: Logger }>();

export async function withRequestContext<T>(
  logger: Logger,
  fields: Record<string, unknown>,
  fn: () => T | Promise<T>,
): Promise<T> {
  // Nesting EXTENDS rather than replaces: a child of the current logger
  // already carries the outer fields, so the inner context has both.
  const parent = requestStore.getStore()?.log ?? logger;
  const child = parent.child(fields);

  // run() scopes it to this async subtree — it survives awaits, timers and
  // Promise.all, and two concurrent requests each see their own
  // (module 07 §6.1).
  return requestStore.run({ log: child }, async () => fn());
}

export function getRequestLogger(): Logger | undefined {
  return requestStore.getStore()?.log;
}

export { ConfigError };
