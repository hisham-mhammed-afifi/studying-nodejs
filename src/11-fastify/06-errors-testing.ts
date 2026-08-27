/**
 * 06 — Errors (including the leak) and testing with inject()
 *
 * Run:  node src/11-fastify/06-errors-testing.ts
 */

import Fastify from "fastify";

/** Fastify's error shape: an Error with optional statusCode/code/validation. */
type FastifyError = Error & {
  statusCode?: number;
  code?: string;
  validation?: Array<{ instancePath?: string; message?: string }>;
};

console.log("=== 1. ⚠ The default error handler LEAKS err.message ===");
{
  const app = Fastify({ logger: false });
  app.get("/boom", async () => {
    throw new Error("connect ECONNREFUSED db.internal:5432 password=hunter2");
  });
  await app.ready();

  console.log(`  NODE_ENV = ${JSON.stringify(process.env["NODE_ENV"])}`);
  console.log("  500 body →", (await app.inject({ url: "/boom" })).body);
  await app.close();

  console.log(`
  I assumed a mature framework would hide this, and doubly so with
  NODE_ENV=production. I checked both. It does not.

  That connection string, the internal hostname, the password — all sent to
  whoever triggered the error. Everything in modules 07 §4, 09 §6 and 10 §3
  says never do that.

  Fastify's reasoning is defensible: it cannot know which of your errors are
  safe to expose. But the DEFAULT is the dangerous one, so you must always
  install your own handler.
`);
}

console.log("=== 2. A safe error handler ===");
{
  class AppError extends Error {
    readonly statusCode: number;
    readonly code: string;
    constructor(statusCode: number, code: string, message: string) {
      super(message);
      this.name = "AppError";
      this.statusCode = statusCode;
      this.code = code;
    }
  }

  const logged: string[] = [];
  const app = Fastify({ logger: false });

  app.setErrorHandler((err: FastifyError, req, reply) => {
    // Log EVERYTHING — this is the only place the detail survives.
    logged.push(`${req.method} ${req.url}: ${err.message}`);

    // Schema failures are the client's fault and safe to describe.
    if (err.validation) {
      return reply.status(400).send({
        code: "VALIDATION",
        message: "request validation failed",
        details: err.validation.map((v: { instancePath?: string; message?: string }) => ({
          path: v.instancePath,
          issue: v.message,
        })),
      });
    }

    const status = err.statusCode ?? 500;

    // The operational vs programmer split from module 07 §4: intentional
    // errors carry their message; anything else gets an opaque 500.
    if (status >= 500) {
      return reply.status(500).send({ code: "INTERNAL", message: "internal server error" });
    }
    return reply.status(status).send({ code: err.code ?? "ERROR", message: err.message });
  });

  app.get("/leak", async () => {
    throw new Error("postgres://user:hunter2@db.internal");
  });
  app.get("/notfound", async () => {
    throw new AppError(404, "NOT_FOUND", "user 42 not found");
  });
  app.post("/users", {
    schema: {
      body: { type: "object", required: ["name"], properties: { name: { type: "string", minLength: 2 } } },
    },
  }, async () => ({ ok: true }));

  await app.ready();

  const leak = await app.inject({ url: "/leak" });
  console.log("  unexpected error →", leak.statusCode, leak.body);
  console.log("     leaked to client:", leak.body.includes("hunter2") ? "YES ✗" : "no ✓");

  const nf = await app.inject({ url: "/notfound" });
  console.log("  intentional error →", nf.statusCode, nf.body);

  const bad = await app.inject({ method: "POST", url: "/users", payload: { name: "x" } });
  console.log("  validation error  →", bad.statusCode, bad.body);

  console.log("\n  what was LOGGED (never sent):");
  for (const l of logged) console.log("    ", l);
  await app.close();

  console.log(`
  Three different failures, three appropriate responses, and the secret
  stayed in the logs. That is ~20 lines and it belongs in every Fastify app
  you write.

  Note err.validation: Fastify hands you the STRUCTURED Ajv failures, so you
  can return your own error shape instead of leaking schema-speak like
  "body/name must NOT have fewer than 2 characters" to a public API.
`);
}

console.log("=== 3. Custom 404 ===");
{
  const defaults = Fastify({ logger: false });
  console.log("  default →", (await defaults.inject({ url: "/nope" })).body);
  await defaults.close();

  // ⚠ Two separate instances, deliberately. setNotFoundHandler — like
  // setErrorHandler, addHook and decorate — must be called BEFORE the
  // instance boots. inject() boots it, so calling it afterwards throws
  // FST_ERR_INSTANCE_ALREADY_LISTENING. (I hit this writing the demo.)
  const custom = Fastify({ logger: false });
  custom.setNotFoundHandler((req, reply) => {
    reply.status(404).send({ code: "NOT_FOUND", message: `no route for ${req.method} ${req.url}` });
  });
  await custom.ready();
  console.log("  custom  →", (await custom.inject({ url: "/nope" })).body);
  await custom.close();

  console.log(`
  setNotFoundHandler is ENCAPSULATED like everything else (04-plugins.ts),
  so a plugin can have its own 404 shape — useful when /api returns JSON and
  the root serves HTML.

  ⚠ All of the set*/addHook/decorate calls must happen before the instance
  boots. That is why a buildApp() FACTORY is the right shape: everything is
  registered in one place, then the caller boots it.
`);
}

console.log("=== 4. inject(): the real reason to like this framework ===");
{
  const app = Fastify({ logger: false });
  app.post("/echo", {
    schema: {
      body: { type: "object", required: ["n"], properties: { n: { type: "integer" } } },
      response: { 200: { type: "object", properties: { doubled: { type: "integer" } } } },
    },
  }, async (req) => {
    const { n } = req.body as { n: number };
    return { doubled: n * 2, secret: "stripped" };
  });

  await app.ready();

  const ok = await app.inject({ method: "POST", url: "/echo", payload: { n: 21 } });
  console.log("  status:", ok.statusCode);
  console.log("  json():", ok.json());
  console.log("  headers:", ok.headers["content-type"]);

  const bad = await app.inject({ method: "POST", url: "/echo", payload: { n: "x" } });
  console.log("  invalid:", bad.statusCode);

  const withQuery = await app.inject({
    method: "POST",
    url: "/echo",
    query: { trace: "1" },
    headers: { "x-request-id": "abc" },
    payload: { n: 1 },
  });
  console.log("  with query+headers:", withQuery.statusCode);

  await app.close();

  console.log(`
  No port. No listen(). No cleanup. No "address already in use". No waiting
  for a socket. And it runs the ENTIRE lifecycle — hooks, validation,
  serialization, error handling — so it is not a mock.

  Compare every test in modules 09 and 10: each one started a real server on
  an ephemeral port and had to close it in afterEach, and any leak made the
  whole run hang.

  A complete test:

      test("rejects an invalid body", async (t) => {
        const app = buildApp();                  // your factory
        t.after(() => app.close());              // node:test cleanup
        const res = await app.inject({ method: "POST", url: "/users",
                                       payload: { name: "x" } });
        assert.equal(res.statusCode, 400);
        assert.equal(res.json().code, "VALIDATION");
      });

  Build your app in a factory function that takes options and returns the
  instance WITHOUT listening. Then production calls listen() and tests call
  inject(). That one habit makes an app testable.
`);
}

console.log("=== 5. Checklist for a real Fastify app ===");
console.log(`
  ✓ setErrorHandler — ALWAYS. The default leaks (§1).
  ✓ setNotFoundHandler, so 404s match your error shape.
  ✓ A response schema on every route that returns data (03 §1).
  ✓ Body/query/params schemas on every route that accepts input.
  ✓ additionalProperties: false on bodies (02 §3) — mass-assignment defence.
  ✓ auth in onRequest, not preHandler (05 §2).
  ✓ fastify-plugin for infrastructure, plain plugins for features (04 §3).
  ✓ onClose hooks so app.close() unwinds your resources.
  ✓ A buildApp() factory that does NOT listen, so tests can inject().
  ✓ logger: true in production — it's pino, and it's already correct.
`);
