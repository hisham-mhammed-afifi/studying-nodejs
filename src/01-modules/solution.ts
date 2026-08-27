/**
 * SOLUTION 01 — reference implementation.
 *
 * Read this AFTER attempting exercise.ts. The comments explain *why*, not what.
 */

import path from "node:path";
import { readFile } from "node:fs/promises";
import { type AppConfig, ConfigError, LOG_LEVELS } from "./exercise.ts";

// --- Task 1 ------------------------------------------------------------------

export async function loadDefaults(): Promise<Record<string, unknown>> {
  // `new URL(relative, import.meta.url)` is the tidiest project-relative
  // reference in ESM: no path.join, no dirname, and fs accepts a URL directly.
  // It is anchored to THIS FILE, so process.cwd() is irrelevant.
  const url = new URL("./_fixtures/defaults.json", import.meta.url);
  let raw: string;
  try {
    raw = await readFile(url, "utf8");
  } catch (err) {
    // Always attach the path. "ENOENT: no such file or directory" with no
    // filename is the most useless error message in Node.
    throw new ConfigError(`Cannot read defaults at ${url.pathname}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`Invalid JSON in ${url.pathname}: ${(err as Error).message}`);
  }
  // typeof null === "object", and arrays are objects. Check both.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError("defaults.json must contain a JSON object");
  }
  return parsed as Record<string, unknown>;
}

// --- Task 2 ------------------------------------------------------------------

// Small typed readers. Each one takes `string | undefined` (the only thing env
// ever gives you) plus a fallback, and either returns a valid value or throws.
// Centralising this is what stops `Number(process.env.PORT)` → NaN bugs.

function readString(envValue: string | undefined, fallback: unknown, key: string): string {
  const candidate = envValue ?? fallback;
  if (typeof candidate !== "string" || candidate.trim() === "") {
    throw new ConfigError(`${key} must be a non-empty string, got ${JSON.stringify(candidate)}`);
  }
  return candidate;
}

function readPort(envValue: string | undefined, fallback: unknown, key: string): number {
  const candidate = envValue ?? fallback;
  // Number("") === 0 and Number(" ") === 0 — classic coercion traps, so go
  // through String() and reject anything that isn't a clean integer.
  const n = typeof candidate === "number" ? candidate : Number(String(candidate).trim());
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new ConfigError(`${key} must be an integer 1-65535, got ${JSON.stringify(candidate)}`);
  }
  return n;
}

function readLogLevel(envValue: string | undefined, fallback: unknown, key: string): AppConfig["logLevel"] {
  const candidate = envValue ?? fallback;
  // `.includes` on a readonly tuple needs a widening cast; this is the
  // idiomatic way to turn a `string` into a union without `as`.
  const found = LOG_LEVELS.find((level) => level === candidate);
  if (found === undefined) {
    throw new ConfigError(`${key} must be one of ${LOG_LEVELS.join("|")}, got ${JSON.stringify(candidate)}`);
  }
  return found;
}

function readFeatures(envValue: string | undefined, fallback: unknown, key: string): readonly string[] {
  if (envValue !== undefined) {
    return envValue
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "");
  }
  if (!Array.isArray(fallback) || !fallback.every((f) => typeof f === "string")) {
    throw new ConfigError(`${key} must be an array of strings`);
  }
  return fallback as readonly string[];
}

export function buildConfig(
  defaults: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  baseDir: string,
): AppConfig {
  const rawDataDir = readString(env["APP_DATA_DIR"], defaults["dataDir"], "dataDir");

  return Object.freeze({
    port: readPort(env["APP_PORT"], defaults["port"], "port"),
    host: readString(env["APP_HOST"], defaults["host"], "host"),
    logLevel: readLogLevel(env["APP_LOG_LEVEL"], defaults["logLevel"], "logLevel"),
    // resolve() is right-to-left and short-circuits on an absolute segment, so
    // this correctly honours an absolute APP_DATA_DIR and anchors a relative
    // one to baseDir. Never to process.cwd() — that would move at runtime.
    dataDir: path.resolve(baseDir, rawDataDir),
    features: Object.freeze(readFeatures(env["APP_FEATURES"], defaults["features"], "features")),
  });
}

// --- Task 3 ------------------------------------------------------------------

export function resolveInDataDir(config: AppConfig, userPath: string): string {
  const resolved = path.resolve(config.dataDir, userPath);
  // The containment check must happen on the RESOLVED path. Checking the raw
  // string for ".." is defeated by encodings, symlink-free absolute paths, and
  // on Windows by backslashes. path.relative() normalises all of that.
  const rel = path.relative(config.dataDir, resolved);
  const escapes = rel === "" || rel.startsWith("..") || path.isAbsolute(rel);
  if (escapes) {
    throw new ConfigError(`Path ${JSON.stringify(userPath)} escapes dataDir`);
  }
  return resolved;
  // Production note: this still does not defend against SYMLINKS pointing out
  // of dataDir. For untrusted input, follow up with fs.realpath() and re-check.
}

// --- Task 4 ------------------------------------------------------------------

let cached: AppConfig | undefined;

export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<AppConfig> {
  // Memoised, but lazily — the file is read on first CALL, not on import.
  // That is the whole point: `export const config = await loadConfig()` would
  // run during module evaluation, before main() had a chance to load .env,
  // and would fire in every test file that transitively imports this one.
  // A function you call explicitly is testable and orderable; a top-level
  // side effect is neither.
  cached ??= buildConfig(await loadDefaults(), env, import.meta.dirname);
  return cached;
}

/** Test seam: forget the memoised value. */
export function resetConfigCache(): void {
  cached = undefined;
}
