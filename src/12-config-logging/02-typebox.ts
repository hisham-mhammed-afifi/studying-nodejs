/**
 * 02 — TypeBox: write the shape once, get a type AND a validator
 *
 * Run:  node src/12-config-logging/02-typebox.ts
 */

import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

console.log("=== 1. The problem: types vanish at runtime ===");
console.log(`
  interface Config { PORT: number }
  const config = process.env as unknown as Config;   // a LIE
  config.PORT * 2;                                   // "30003000"

  Node ERASES types (module 01). The annotation changes nothing at runtime,
  so a cast is a promise you made to the compiler and nobody checked.

  You need BOTH:
    • a runtime schema, to inspect the bytes that actually arrived
    • a compile-time type, so the rest of the code is checked

  Maintaining two hand-written definitions guarantees they drift. TypeBox
  derives the type FROM the schema, so there is only one to maintain.
`);

console.log("=== 2. One definition, two outputs ===");

const ConfigSchema = Type.Object({
  PORT: Type.Integer({ minimum: 1, maximum: 65535, default: 3000 }),
  HOST: Type.String({ default: "127.0.0.1" }),
  NODE_ENV: Type.Union(
    [Type.Literal("development"), Type.Literal("production"), Type.Literal("test")],
    { default: "development" },
  ),
  DATABASE_URL: Type.String({ minLength: 1 }),
  LOG_LEVEL: Type.Union(
    [Type.Literal("debug"), Type.Literal("info"), Type.Literal("warn"), Type.Literal("error")],
    { default: "info" },
  ),
  ENABLE_METRICS: Type.Boolean({ default: false }),
  REQUEST_TIMEOUT_MS: Type.Integer({ minimum: 100, default: 30_000 }),
});

type Config = Static<typeof ConfigSchema>;

console.log(`
  type Config = Static<typeof ConfigSchema>;

  …infers:

      {
        PORT: number;
        HOST: string;
        NODE_ENV: "development" | "production" | "test";   ← a LITERAL UNION
        DATABASE_URL: string;
        LOG_LEVEL: "debug" | "info" | "warn" | "error";
        ENABLE_METRICS: boolean;
        REQUEST_TIMEOUT_MS: number;
      }

  NODE_ENV narrows to exactly three strings, so a typo is a compile error.
  And the same object IS a JSON Schema, so Fastify accepts it directly as a
  route schema (module 11) — one vocabulary for config and for HTTP.
`);

console.log("=== 3. Convert → Default → Check, in that order ===");
{
  const raw = { PORT: "8080", DATABASE_URL: "postgres://localhost/app", ENABLE_METRICS: "true" };
  console.log("  raw (all strings):", raw);

  // 1. Convert: coerce strings to the declared types. Without this EVERY
  //    numeric and boolean check fails, because env values are strings.
  const converted = Value.Convert(ConfigSchema, raw);
  // 2. Default: fill in anything not supplied.
  const withDefaults = Value.Default(ConfigSchema, converted) as Config;
  // 3. Check: is it actually valid now?
  const valid = Value.Check(ConfigSchema, withDefaults);

  console.log("  after Convert + Default:", withDefaults);
  console.log("  valid:", valid);
  console.log("  typeof PORT:", typeof withDefaults.PORT, "| typeof ENABLE_METRICS:", typeof withDefaults.ENABLE_METRICS);

  console.log(`
  Order matters:

    Convert first   — "8080" → 8080, "true" → true
    Default second  — so a supplied value is never overwritten
    Check last      — on the finished object

  Check first and everything fails; Default first and Convert can clobber.
`);
}

console.log("=== 4. Every error at once ===");
{
  const bad = { PORT: "70000", NODE_ENV: "staging", LOG_LEVEL: "verbose" };
  const candidate = Value.Default(ConfigSchema, Value.Convert(ConfigSchema, bad));

  const errors = [...Value.Errors(ConfigSchema, candidate)];
  console.log(`  ${errors.length} problems:`);
  for (const e of errors) {
    console.log(`    ${(e.path || "/").padEnd(20)} ${e.message}`);
  }

  console.log(`
  Value.Errors yields EVERY failure with its JSON-pointer path, so you can
  format one actionable message (01-config.ts §3) instead of throwing on
  the first.

  ⚠ You may see more than one entry per field — a union reports a failure
  per branch it tried. Group by path before showing them to a human.
`);
}

console.log("=== 5. A loader worth copying ===");
{
  class ConfigError extends Error {
    override readonly name = "ConfigError";
    readonly issues: string[];
    constructor(issues: string[]) {
      super(`Invalid configuration:\n  - ${issues.join("\n  - ")}`);
      this.issues = issues;
    }
  }

  function loadConfig(env: NodeJS.ProcessEnv): Config {
    const candidate = Value.Default(ConfigSchema, Value.Convert(ConfigSchema, { ...env }));

    if (!Value.Check(ConfigSchema, candidate)) {
      // Group by path so a union doesn't print four lines for one field.
      const byPath = new Map<string, string[]>();
      for (const e of Value.Errors(ConfigSchema, candidate)) {
        const key = e.path.replace(/^\//, "") || "(root)";
        byPath.set(key, [...(byPath.get(key) ?? []), e.message]);
      }
      throw new ConfigError([...byPath].map(([path, msgs]) => `${path}: ${[...new Set(msgs)].join("; ")}`));
    }

    return candidate;
  }

  const good = loadConfig({ DATABASE_URL: "postgres://localhost/app", PORT: "9000" });
  console.log("  valid config →", good);
  console.log("  PORT is a number:", typeof good.PORT === "number");

  try {
    loadConfig({ PORT: "abc", NODE_ENV: "staging" });
  } catch (err) {
    console.log("\n  invalid config →");
    console.log("   " + (err as Error).message.split("\n").join("\n   "));
  }
}

console.log(`
=== 6. TypeBox vs Zod ===

  Both are excellent. The difference that matters here:

    TypeBox   IS JSON Schema. Fastify, Ajv and OpenAPI consume it directly.
              Slightly more verbose; validation runs through Ajv.
    Zod       Nicer API, richer refinements, better error messages.
              NOT JSON Schema — you need a converter to use it with Fastify
              route schemas or to emit OpenAPI.

  For a service that already uses Fastify schemas (module 11), TypeBox means
  one vocabulary everywhere. For a library or a CLI, Zod is usually nicer.

  Either way the principle is the same: ONE definition, from which both the
  runtime validator and the compile-time type are derived.
`);

console.log("=== 7. ⚠ A gotcha I hit installing this ===");
console.log(`
  node -e "require('@sinclair/typebox/package.json')"
    → ERR_PACKAGE_PATH_NOT_EXPORTED

  TypeBox's package.json has an "exports" field that does not list
  "./package.json", so that subpath is unreachable even though the file is
  right there on disk.

  That is module 01 §2.5 — "exports" is an encapsulation boundary, not a
  hint. It caught me while writing this module, which is a decent
  demonstration that the rule is real.
`);
