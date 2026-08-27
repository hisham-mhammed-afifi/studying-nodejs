/**
 * EXERCISE 01 — A config loader
 *
 * Build the thing you will write in every real Node service: load defaults from
 * a file that ships with the code, overlay environment variables, validate,
 * and hand back a typed frozen object.
 *
 * Check yourself:  node --test "src/01-modules/*.test.ts"
 * Solution:        ./solution.ts   (try first!)
 *
 * Rules:
 *   - No `any`. No non-null assertions (`!`).
 *   - `defaults.json` must load correctly regardless of process.cwd().
 *   - Throw `ConfigError` with a useful message on bad input — never return
 *     a half-built config.
 */

export interface AppConfig {
  readonly port: number;
  readonly host: string;
  readonly logLevel: "debug" | "info" | "warn" | "error";
  readonly dataDir: string; // must be ABSOLUTE
  readonly features: readonly string[];
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
  constructor(message: string) {
    super(message);
  }
}

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

/**
 * TASK 1 — Read and parse `./_fixtures/defaults.json`.
 *
 * Must work when the process is launched from ANY directory.
 * Wrap parse failures in a ConfigError that names the file.
 *
 * Hint: `import.meta.dirname`, or pass a URL straight to `readFile`.
 */
export async function loadDefaults(): Promise<Record<string, unknown>> {
  throw new Error("TODO: implement loadDefaults");
}

/**
 * TASK 2 — Overlay environment variables onto the defaults and validate.
 *
 * Env mapping (all optional; missing → use the default):
 *   APP_PORT       → port      (integer, 1..65535)
 *   APP_HOST       → host      (non-empty string)
 *   APP_LOG_LEVEL  → logLevel  (one of LOG_LEVELS)
 *   APP_DATA_DIR   → dataDir   (resolved to an absolute path; relative values
 *                               are resolved against `baseDir`)
 *   APP_FEATURES   → features  (comma-separated; trim each; drop empties)
 *
 * Remember: every env value is `string | undefined`. "0" and "false" are
 * truthy strings. Validate, don't coerce blindly.
 *
 * @param env     usually process.env — injected so it can be tested
 * @param baseDir the directory relative paths resolve against
 */
export function buildConfig(
  defaults: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  baseDir: string,
): AppConfig {
  throw new Error("TODO: implement buildConfig");
}

/**
 * TASK 3 — Safely resolve a user-supplied relative path inside `dataDir`.
 *
 * Return the absolute path, or throw ConfigError if the result would escape
 * `dataDir` (e.g. "../../etc/passwd", or an absolute path like "/etc/passwd").
 *
 * Hint: `path.resolve` alone is NOT enough — see 05-paths.ts.
 */
export function resolveInDataDir(config: AppConfig, userPath: string): string {
  throw new Error("TODO: implement resolveInDataDir");
}

/**
 * TASK 4 — Tie it together. Load defaults, build, freeze.
 *
 * BONUS: make this a memoised singleton — repeated calls return the identical
 * object without re-reading the file. Then ask yourself why exporting
 * `export const config = await loadConfig()` at module top level would be a
 * worse design (hint: module 01, README, "the module cache").
 */
export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<AppConfig> {
  throw new Error("TODO: implement loadConfig");
}
