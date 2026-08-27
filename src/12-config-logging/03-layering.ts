/**
 * 03 — Layering config, and handling secrets
 *
 * Run:  node src/12-config-logging/03-layering.ts
 * Then: node --env-file=src/12-config-logging/_example.env src/12-config-logging/03-layering.ts
 */

import { parseArgs } from "node:util";

console.log("=== 1. Precedence ===");
console.log(`
  defaults  <  config file  <  environment  <  CLI flags
     lowest                                     highest

  The rule of thumb: the more SPECIFIC to this one invocation a source is,
  the higher it wins. A flag typed by a human right now beats a file
  committed six months ago.
`);

interface Sources {
  defaults: Record<string, string>;
  file: Record<string, string>;
  env: Record<string, string>;
  flags: Record<string, string>;
}

function layer(sources: Sources): { value: Record<string, string>; origin: Record<string, string> } {
  const value: Record<string, string> = {};
  const origin: Record<string, string> = {};

  // Later spreads win — which is exactly the precedence order above.
  // Object.entries widens the value type, so name it explicitly.
  for (const [name, source] of Object.entries(sources) as Array<[string, Record<string, string>]>) {
    for (const [k, v] of Object.entries(source)) {
      value[k] = v;
      origin[k] = name; // remembering WHERE each value came from is the useful part
    }
  }
  return { value, origin };
}

{
  const { value, origin } = layer({
    defaults: { PORT: "3000", LOG_LEVEL: "info", HOST: "127.0.0.1" },
    file: { LOG_LEVEL: "debug", DATABASE_URL: "postgres://localhost/dev" },
    env: { PORT: "8080", DATABASE_URL: "postgres://prod/app" },
    flags: { LOG_LEVEL: "warn" },
  });

  console.log("  key           value                        won from");
  console.log("  ────────────  ───────────────────────────  ─────────");
  for (const k of Object.keys(value).sort()) {
    console.log(`  ${k.padEnd(12)}  ${(value[k] ?? "").padEnd(27)}  ${origin[k]}`);
  }

  console.log(`
  Tracking the ORIGIN is worth the extra map. "Why is LOG_LEVEL warn in
  staging?" is answered instantly instead of by bisecting four sources.

  Expose it on a debug endpoint (redacted, and behind auth):

      GET /debug/config → { PORT: { value: 8080, from: "env" }, … }
`);
}

console.log("=== 2. Node loads .env natively ===");
console.log(`
  node --env-file=.env app.ts                       # since Node 20.6
  node --env-file=.env --env-file=.env.local app.ts # later files WIN

  No dotenv dependency. Values land in process.env before your code runs,
  so your loader sees them like any other environment variable.

  ⚠ .env files are a DEVELOPMENT convenience. In production the environment
  comes from the orchestrator, a secret manager, or mounted files — never a
  file in the repository. Add .env to .gitignore on day one; git history is
  forever, and the only fix for a committed secret is rotating it.

  This module ships _example.env so you can try it:

      node --env-file=src/12-config-logging/_example.env \\
           src/12-config-logging/03-layering.ts
`);

console.log("  values visible from the environment right now:");
for (const key of ["DEMO_PORT", "DEMO_LOG_LEVEL", "DEMO_FEATURE"]) {
  const v = process.env[key];
  console.log(`    ${key.padEnd(16)} ${v === undefined ? "(not set — try --env-file)" : JSON.stringify(v)}`);
}

console.log("\n=== 3. CLI flags win ===");
{
  // parseArgs is built in since Node 18.3 (module 01 §4.1).
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      port: { type: "string" },
      "log-level": { type: "string" },
      verbose: { type: "boolean", default: false },
    },
    strict: false,
    allowPositionals: true,
  });

  console.log("  parsed flags:", values);
  console.log(`
  Flags are the highest-precedence source because they are the most
  specific: someone typed them for THIS run.

      node app.ts --port 9000 --log-level debug

  Keep the flag names aligned with the env var names (PORT ↔ --port) so
  there is one mental model, not two.
`);
}

console.log("=== 4. Secrets ===");
console.log(`
  ✗ committed to the repo            git history is forever
  ✗ in an error message              those reach clients (module 07 §4)
  ✗ in a log line                    redaction has holes (06-redaction.ts)
  ✗ in a URL                         proxies and access logs record URLs
  ✗ baked into a container image     anyone who can pull the image has them

  PREFER MOUNTED FILES over environment variables:

      const password = (await readFile(process.env.DB_PASSWORD_FILE, "utf8")).trim();

  Why files are better:
    • env vars are visible in /proc/<pid>/environ to anything that can read
      the process, and are captured by crash dumps and process.report
      (module 07 §8.4)
    • child processes inherit the whole environment by default (module 08)
    • a mounted secret can be ROTATED without restarting the pod
    • .trim() matters — files written by humans and by CI usually end with
      a newline, and a trailing \\n in a password is a genuinely painful bug
`);

console.log("=== 5. Make the config object safe to log ===");
{
  const SECRET_KEYS = /pass|secret|token|key|credential|dsn|url/i;

  function withRedaction<T extends Record<string, unknown>>(config: T): T {
    // Non-enumerable, so it does not show up in Object.keys or a spread.
    Object.defineProperty(config, "toJSON", {
      enumerable: false,
      value: () =>
        Object.fromEntries(
          Object.entries(config).map(([k, v]) => [k, SECRET_KEYS.test(k) ? "[REDACTED]" : v]),
        ),
    });
    return config;
  }

  const config = withRedaction({
    PORT: 8080,
    NODE_ENV: "production",
    DATABASE_URL: "postgres://user:hunter2@db.internal/app",
    API_TOKEN: "tok_live_abc123",
  });

  console.log("  JSON.stringify(config) →");
  console.log("   ", JSON.stringify(config));
  console.log("  direct access still works →", config.PORT, "|", config.DATABASE_URL.slice(0, 11) + "…");

  console.log(`
  Now an accidental logger.info({ config }) is safe BY CONSTRUCTION rather
  than by everyone remembering. Same principle as Fastify's response
  schemas (module 11 §3.1): make the safe thing the default, so the unsafe
  thing requires deliberate effort.

  ⚠ toJSON only covers JSON.stringify. console.log uses util.inspect, which
  ignores it — add a [util.inspect.custom] method too if that matters:

      import { inspect } from "node:util";
      Object.defineProperty(config, inspect.custom, { value: () => config.toJSON() });
`);
}

console.log("=== 6. A production-shaped loader ===");
console.log(`
  // config.ts — validated ONCE, at import, before anything else runs
  import { readFile } from "node:fs/promises";

  async function resolveSecret(name: string): Promise<string> {
    // A *_FILE variant wins, so the same code works with mounted secrets
    // in production and plain env vars in development.
    const file = process.env[\`\${name}_FILE\`];
    if (file) return (await readFile(file, "utf8")).trim();
    const value = process.env[name];
    if (!value) throw new ConfigError([\`\${name} or \${name}_FILE is required\`]);
    return value;
  }

  export const config = withRedaction(
    loadConfig({
      ...process.env,
      DATABASE_PASSWORD: await resolveSecret("DATABASE_PASSWORD"),
    }),
  );

  Then everything else does \`import { config } from "./config.ts"\` and gets
  a typed, validated, redaction-safe object — and the process refuses to
  start if any of it is wrong.
`);
