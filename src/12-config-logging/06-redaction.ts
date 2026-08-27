/**
 * 06 — Redaction: a safety net, not a strategy
 *
 * Run:  node src/12-config-logging/06-redaction.ts
 */

import pino from "pino";
import { Writable } from "node:stream";

function capture(options: pino.LoggerOptions = {}) {
  const lines: Record<string, unknown>[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      lines.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
      cb();
    },
  });
  return { logger: pino({ level: "trace", ...options }, sink), lines };
}

const payload = (l: Record<string, unknown>) => {
  const { time, pid, hostname, level, msg, ...rest } = l;
  void time;
  void pid;
  void hostname;
  void level;
  void msg;
  return JSON.stringify(rest);
};

console.log("=== 1. It works, and it's fast ===");
{
  const { logger, lines } = capture({
    redact: ["password", "*.token", "req.headers.authorization"],
  });

  logger.info({ userId: "u1", password: "hunter2" }, "a");
  logger.info({ session: { token: "tok_abc" } }, "b");
  logger.info({ req: { headers: { authorization: "Bearer xyz", accept: "*/*" } } }, "c");

  for (const l of lines) console.log("   ", payload(l));

  console.log(`
  Path-based, applied at serialization time, and cheap. Configure it once
  on the logger and every call site is covered.
`);
}

console.log("=== 2. ⚠ Where it silently fails ===");
{
  const { logger, lines } = capture({ redact: ["password", "*.token"] });

  const cases: Array<[string, Record<string, unknown>]> = [
    ["top-level password (configured)", { password: "hunter2" }],
    ["nested one level (*.token)", { session: { token: "tok_1" } }],
    ["nested one level, password", { user: { password: "hunter2" } }],
    ["nested TWO levels", { a: { b: { token: "tok_2" } } }],
    ["different case", { Password: "hunter2" }],
    ["different name", { pwd: "hunter2" }],
    ["inside an array", { users: [{ password: "hunter2" }] }],
    ["inside a string", { note: "the password is hunter2" }],
    ["inside a URL", { dsn: "postgres://user:hunter2@db/app" }],
  ];

  for (const [label, obj] of cases) {
    logger.info(obj, label);
  }

  console.log("  case                              output");
  console.log("  ────────────────────────────────  ──────────────────────────────────");
  for (let i = 0; i < cases.length; i++) {
    const out = payload(lines[i]!);
    const leaked = out.includes("hunter2") || out.includes("tok_");
    console.log(`  ${cases[i]![0].padEnd(32)}  ${leaked ? "LEAKED ✗" : "redacted ✓"}  ${out.slice(0, 44)}`);
  }

  console.log(`
  Seven of nine leaked. Redaction is EXACT-PATH matching:

    "password"     matches only the top level
    "*.token"      matches exactly one level of nesting — not two, not zero
    case-sensitive "Password" is a different path entirely

  And it can never help with a secret embedded in a STRING — a message, a
  connection URL, a stack trace, an error message.
`);
}

console.log("=== 3. The strategy: don't put secrets in the payload ===");
{
  const { logger, lines } = capture({ redact: ["password", "*.password"] });

  const user = {
    id: "u42",
    email: "ada@example.com",
    password: "hunter2",
    apiKey: "sk_live_abc",
    sessionToken: "tok_xyz",
  };

  logger.info({ user }, "✗ log the whole object and hope");
  logger.info(
    { userId: user.id, emailDomain: user.email.split("@")[1], hasApiKey: Boolean(user.apiKey) },
    "✓ log what you actually need",
  );

  for (const l of lines) console.log("   ", payload(l));

  console.log(`
  The first line leaked apiKey and sessionToken, because they weren't in
  the redact list — and they weren't in the list because nobody thought of
  them when the list was written.

  That is the structural problem: a DENYLIST has to anticipate every field
  name anyone will ever add. An ALLOWLIST doesn't.

  Rules that scale:
    • log IDs, not objects            userId, not user
    • log presence, not values        hasToken: true, not the token
    • log a domain, not an address    emailDomain, not email
    • log a route, not a URL          "/users/:id", not the query string
`);
}

console.log("=== 4. Serializers are the allowlist version ===");
{
  const { logger, lines } = capture({
    serializers: {
      // Runs on the "user" KEY wherever it appears — one decision, applied
      // everywhere, instead of remembering at each call site.
      user: (u: Record<string, unknown>) => ({
        id: u["id"],
        emailDomain: String(u["email"] ?? "").split("@")[1],
      }),
    },
  });

  logger.info(
    { user: { id: "u42", email: "ada@example.com", password: "hunter2", apiKey: "sk_live" } },
    "with a serializer",
  );
  console.log("   ", payload(lines[0]!));

  console.log(`
  Nothing leaked, and nothing had to be anticipated — the serializer picks
  what goes IN rather than what stays out.

  Same idea as Fastify's response schemas (module 11 §3.1) and the config
  toJSON in 03-layering.ts §5: make the safe thing structural, so the
  unsafe thing needs deliberate effort.
`);
}

console.log("=== 5. Redaction still earns its place ===");
console.log(`
  Use all three, in this order of importance:

    1. Don't put secrets in log payloads.        the actual defence
    2. Serializers for known shapes.             an allowlist, centrally
    3. redact[] for the paths you know about.    the safety net

  A sensible starting list:

      redact: [
        "password", "*.password", "*.*.password",
        "token", "*.token", "authorization", "*.authorization",
        "req.headers.authorization", "req.headers.cookie",
        "res.headers['set-cookie']",
        "*.secret", "*.apiKey", "*.creditCard",
      ]

  ⚠ Redaction costs CPU proportional to the number of paths, on every log
  line. A hundred paths on a hot path is measurable. Keep the list short
  and rely on §3 instead.

  Also worth knowing: \`redact\` can REMOVE rather than mask —

      redact: { paths: ["password"], remove: true }

  …which is better when the key's mere presence is a signal you don't want
  in a log aggregator someone else operates.
`);

console.log("=== 6. The test that catches regressions ===");
console.log(`
  Write ONE test that asserts your known secrets never appear:

      test("logs never contain secrets", async () => {
        const lines: string[] = [];
        const logger = pino({ redact: [...] }, { write: (s) => lines.push(s) });

        await exerciseTheApp(logger);         // hit every route

        const all = lines.join("\\n");
        for (const secret of [config.DATABASE_PASSWORD, config.API_TOKEN]) {
          assert.ok(!all.includes(secret), "a secret reached the logs");
        }
      });

  It is crude and it works. Run it in CI and a new field that leaks a token
  fails the build instead of reaching a log aggregator.
`);
