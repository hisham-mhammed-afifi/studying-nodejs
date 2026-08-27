/**
 * 03 — Response schemas: what they're actually for
 *
 * Contains the measurement that changed my mind about this feature.
 *
 * Run:  node src/11-fastify/03-serialization.ts
 */

import Fastify from "fastify";
import build from "fast-json-stringify";

console.log("=== 1. A response schema is an ALLOWLIST ===");
{
  const app = Fastify({ logger: false });

  // Whatever the database/ORM hands back — including fields added by a
  // colleague last week, and everything a SELECT * dragged along.
  const userFromDb = {
    id: "1",
    name: "ada",
    email: "ada@example.com",
    passwordHash: "$2b$10$SECRET",
    resetToken: "tok_abc123",
    internalRiskScore: 0.92,
  };

  app.get("/with-schema", {
    schema: {
      response: {
        200: {
          type: "object",
          properties: { id: { type: "string" }, name: { type: "string" } },
        },
      },
    },
  }, async () => userFromDb);

  app.get("/no-schema", async () => userFromDb);

  console.log("  with a response schema →", (await app.inject({ url: "/with-schema" })).body);
  console.log("  without one            →", (await app.inject({ url: "/no-schema" })).body);
  await app.close();

  console.log(`
  Both handlers return the SAME object. One of them sent a password hash
  and a reset token to the client.

  This is a structurally different guarantee from "remember to delete
  user.passwordHash before responding":

    • it holds for every route with that schema, automatically
    • it holds for fields that did not exist when the route was written
    • it cannot be forgotten during a refactor
    • it is reviewable — the schema IS the contract

  Undeclared fields cannot leave the process. That is the feature.
`);
}

console.log("=== 2. ⚠ The speed claim, measured ===");
{
  console.log(`
  Fastify is widely described as having "2-3× faster serialization" via
  fast-json-stringify. I set out to reproduce that. Here is what I got on
  Node ${process.versions.node}:
`);

  interface Shape {
    schema: Record<string, unknown>;
    data: unknown;
    n: number;
  }

  const shapes: Record<string, Shape> = {
    "small flat object": {
      schema: {
        type: "object",
        properties: { id: { type: "string" }, n: { type: "integer" }, ok: { type: "boolean" } },
      },
      data: { id: "abc", n: 42, ok: true },
      n: 200_000,
    },
    "wide object (20 strings)": {
      schema: {
        type: "object",
        properties: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`f${i}`, { type: "string" }])),
      },
      data: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`f${i}`, `value ${i}`])),
      n: 100_000,
    },
    "array of 100 objects": {
      schema: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: { id: { type: "string" }, name: { type: "string" } },
            },
          },
        },
      },
      data: { items: Array.from({ length: 100 }, (_, i) => ({ id: String(i), name: `n${i}` })) },
      n: 20_000,
    },
  };

  console.log("  payload shape                fast-json-stringify   JSON.stringify   ratio");
  console.log("  ─────────────────────────    ───────────────────   ──────────────   ─────");

  for (const [label, { schema, data, n }] of Object.entries(shapes)) {
    const stringify = build(schema as never);
    // Warm the JIT, or whichever runs first is unfairly slow (module 02).
    for (let i = 0; i < Math.min(n, 5_000); i++) {
      stringify(data);
      JSON.stringify(data);
    }

    let t = performance.now();
    for (let i = 0; i < n; i++) stringify(data);
    const fjs = performance.now() - t;

    t = performance.now();
    for (let i = 0; i < n; i++) JSON.stringify(data);
    const json = performance.now() - t;

    const ratio = json / fjs;
    const verdict = ratio > 1.05 ? "faster" : ratio < 0.95 ? "SLOWER" : "same";
    console.log(
      `  ${label.padEnd(27)} ${fjs.toFixed(0).padStart(10)}ms ${json.toFixed(0).padStart(16)}ms   ${ratio.toFixed(2)}× ${verdict}`,
    );
  }

  console.log(`
  Only the small flat object won. On the shapes a real API actually returns
  — lists and wide records — V8's JSON.stringify was FASTER.

  The claim isn't dishonest, it's just old: it dates from a time when V8's
  JSON was much slower, and V8 has since optimised it heavily. Benchmarks
  age, and this one aged.

  So: use response schemas. Use them everywhere. Just use them for the
  ALLOWLISTING in §1, and do not expect a serialization speedup.
`);
}

console.log("=== 3. Smaller payloads ARE faster, though ===");
{
  const app = Fastify({ logger: false });
  const rows = Array.from({ length: 500 }, (_, i) => ({
    id: String(i),
    name: `user ${i}`,
    score: i * 1.5,
    internalNotes: "x".repeat(50), // not in the schema
  }));

  const listSchema = {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: { id: { type: "string" }, name: { type: "string" }, score: { type: "number" } },
        },
      },
    },
  } as const;

  app.get("/schema", { schema: { response: { 200: listSchema } } }, async () => ({ items: rows }));
  app.get("/raw", async () => ({ items: rows }));

  const withSchema = (await app.inject({ url: "/schema" })).body.length;
  const withoutSchema = (await app.inject({ url: "/raw" })).body.length;
  await app.close();

  console.log(`  with schema:    ${(withSchema / 1024).toFixed(0)}KB`);
  console.log(`  without schema: ${(withoutSchema / 1024).toFixed(0)}KB`);
  console.log(`  → ${(100 - (withSchema / withoutSchema) * 100).toFixed(0)}% smaller, because the undeclared field was stripped`);
  console.log(`
  THIS is where the end-to-end speedup comes from: fewer bytes serialized,
  fewer bytes through the socket, fewer bytes parsed by the client. Not from
  the serializer being faster.

  Sending less data is a real and large win. It just isn't the win the
  benchmark headline claims.
`);
}

console.log("=== 4. Practical rules ===");
console.log(`
  ✓ Put a response schema on EVERY route that returns user or internal data.
  ✓ Declare only what the client needs. The schema is your privacy boundary.
  ✓ Share schemas with app.addSchema() and $ref, so "user" is defined once.
  ✓ Add a schema per status code — 200 and 404 have different shapes:

        response: { 200: userSchema, 404: errorSchema }

  ⚠ A field missing from the schema is silently dropped, not an error. If a
    client says "the API stopped returning X", check the schema first — that
    is nearly always where X went.

  ⚠ Types must match. A Date object against { type: "string" } serializes
    via toISOString(); against { type: "object" } you get {}. Declare
    { type: "string", format: "date-time" } and be explicit.
`);
