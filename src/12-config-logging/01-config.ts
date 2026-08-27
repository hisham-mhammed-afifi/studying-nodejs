/**
 * 01 — Config: fail fast, or fail at 3am
 *
 * Run:  node src/12-config-logging/01-config.ts
 */

console.log("=== 1. Everything from the environment is a STRING ===");
{
  const env: NodeJS.ProcessEnv = {
    PORT: "3000",
    DEBUG: "false",
    MAX_RETRIES: "0",
    FEATURE_X: "",
  };

  console.log("  PORT        :", JSON.stringify(env["PORT"]), typeof env["PORT"]);
  console.log("  DEBUG       :", JSON.stringify(env["DEBUG"]), "→ truthy?", Boolean(env["DEBUG"]));
  console.log("  MAX_RETRIES :", JSON.stringify(env["MAX_RETRIES"]), "→ truthy?", Boolean(env["MAX_RETRIES"]));
  console.log("  FEATURE_X   :", JSON.stringify(env["FEATURE_X"]), "→ truthy?", Boolean(env["FEATURE_X"]));
  console.log("  MISSING     :", env["MISSING"], typeof env["MISSING"]);

  console.log(`
  The two that catch everyone:

      DEBUG="false"       → the STRING "false", which is TRUTHY
      MAX_RETRIES="0"     → the STRING "0", also TRUTHY

  So \`if (process.env.DEBUG)\` runs when DEBUG is explicitly "false", and
  \`process.env.MAX_RETRIES || 3\` gives 3 when you set it to 0.

  This is module 01 §4.2, and it is why config needs parsing, not reading.
`);
}

console.log("=== 2. Fail LATE vs fail FAST ===");
{
  const env: NodeJS.ProcessEnv = { PORT: "not-a-number" }; // DATABASE_URL missing

  console.log("  ✗ fail late — read it where it's used:");
  const lateUrl = env["DATABASE_URL"];
  console.log(`     const url = process.env.DATABASE_URL   → ${lateUrl}`);
  console.log("     …the process starts, passes its health check, accepts traffic,");
  console.log("     and dies on the first request that touches the database.");

  console.log("\n  ✓ fail fast — validate everything at startup:");
  try {
    loadConfigNaive(env);
  } catch (err) {
    console.log("     " + (err as Error).message.split("\n").join("\n     "));
  }

  console.log(`
  Fail-fast means a bad deploy dies in its health check and rolls back.
  Fail-late means it serves 500s until a human notices.

  The rule: a process that cannot do its job should refuse to start.
`);
}

console.log("=== 3. Report EVERY error at once ===");
{
  const env: NodeJS.ProcessEnv = { PORT: "abc", LOG_LEVEL: "verbose" };

  console.log("  ✗ one at a time:");
  try {
    firstErrorOnly(env);
  } catch (err) {
    console.log("     " + (err as Error).message);
    console.log("     …fix it, redeploy, discover the next one. Four round trips.");
  }

  console.log("\n  ✓ all of them:");
  try {
    loadConfigNaive(env);
  } catch (err) {
    console.log("     " + (err as Error).message.split("\n").join("\n     "));
  }

  console.log(`
  Someone fixing a .env file should need ONE round trip. Collect every
  failure, then throw once.
`);
}

console.log("=== 4. Validate once, at the edge ===");
console.log(`
  ✗ process.env read directly, in nine different files:

      if (process.env.FEATURE_X === "true") { … }        // string compare
      const port = Number(process.env.PORT) || 3000;     // NaN → 3000, silently
      const retries = process.env.MAX_RETRIES ?? 3;      // a STRING "5"

    Every site re-implements the parsing, slightly differently. A typo in an
    env var name is undefined and therefore falsy, so it silently takes the
    default forever.

  ✓ one typed object:

      // config.ts
      export const config = loadConfig(process.env);

      // everywhere else
      import { config } from "./config.ts";
      if (config.featureX) { … }        // a real boolean
      server.listen(config.port);       // a real number

    And the config file becomes DOCUMENTATION: one place that lists every
    setting, its type, its default, and whether it is required. New joiners
    read one file instead of grepping for process.env.
`);

console.log("=== 5. Parsers worth having ===");
{
  const parsers = {
    int(value: string | undefined, name: string): number {
      if (value === undefined || value.trim() === "") throw new Error(`${name} is required`);
      const n = Number(value);
      // Number("") is 0 and Number(" ") is 0 — check explicitly.
      if (!Number.isInteger(n)) throw new Error(`${name} must be an integer, got ${JSON.stringify(value)}`);
      return n;
    },
    bool(value: string | undefined, name: string): boolean {
      const v = value?.trim().toLowerCase();
      if (v === undefined || v === "") throw new Error(`${name} is required`);
      if (["1", "true", "yes", "on"].includes(v)) return true;
      if (["0", "false", "no", "off"].includes(v)) return false;
      throw new Error(`${name} must be a boolean, got ${JSON.stringify(value)}`);
    },
    oneOf<T extends string>(value: string | undefined, name: string, allowed: readonly T[]): T {
      const found = allowed.find((a) => a === value);
      if (!found) throw new Error(`${name} must be one of ${allowed.join("|")}, got ${JSON.stringify(value)}`);
      return found;
    },
  };

  console.log("  int('8080')      →", parsers.int("8080", "PORT"));
  console.log("  bool('false')    →", parsers.bool("false", "DEBUG"), "← correctly FALSE");
  console.log("  bool('0')        →", parsers.bool("0", "DEBUG"));
  console.log("  oneOf('info')    →", parsers.oneOf("info", "LOG_LEVEL", ["debug", "info", "warn"] as const));

  for (const [label, fn] of [
    ["int('80.5')", () => parsers.int("80.5", "PORT")],
    ["int('')", () => parsers.int("", "PORT")],
    ["bool('maybe')", () => parsers.bool("maybe", "DEBUG")],
  ] as const) {
    try {
      fn();
    } catch (err) {
      console.log(`  ${label.padEnd(16)} → throws: ${(err as Error).message}`);
    }
  }

  console.log(`
  These are ~20 lines and they cover most services. 02-typebox.ts shows the
  version that also gives you a TypeScript type for free — which matters
  once the config has more than a handful of fields.
`);
}

// ─────────────────────────────────────────────────────────────────────────────

/** Collects every problem, then throws once. */
function loadConfigNaive(env: NodeJS.ProcessEnv): { port: number; databaseUrl: string; logLevel: string } {
  const errors: string[] = [];

  const rawPort = env["PORT"] ?? "3000";
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    errors.push(`PORT: expected an integer 1-65535, got ${JSON.stringify(rawPort)}`);
  }

  const databaseUrl = env["DATABASE_URL"];
  if (!databaseUrl) errors.push("DATABASE_URL: required, but not set");

  const logLevel = env["LOG_LEVEL"] ?? "info";
  const levels = ["debug", "info", "warn", "error"];
  if (!levels.includes(logLevel)) {
    errors.push(`LOG_LEVEL: expected one of ${levels.join("|")}, got ${JSON.stringify(logLevel)}`);
  }

  if (errors.length > 0) {
    throw new Error(`Invalid configuration:\n  - ${errors.join("\n  - ")}`);
  }
  return { port, databaseUrl: databaseUrl as string, logLevel };
}

/** The tempting version: stops at the first problem. */
function firstErrorOnly(env: NodeJS.ProcessEnv): void {
  const port = Number(env["PORT"]);
  if (!Number.isInteger(port)) throw new Error(`PORT must be an integer, got ${JSON.stringify(env["PORT"])}`);
  if (!env["DATABASE_URL"]) throw new Error("DATABASE_URL is required");
}
