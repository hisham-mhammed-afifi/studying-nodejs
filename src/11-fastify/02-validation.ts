/**
 * 02 — Schema validation at the boundary
 *
 * Run:  node src/11-fastify/02-validation.ts
 */

import Fastify from "fastify";

const app = Fastify({ logger: false });

app.post("/users", {
  schema: {
    body: {
      type: "object",
      required: ["name", "age"],
      properties: {
        name: { type: "string", minLength: 2, maxLength: 50 },
        age: { type: "integer", minimum: 0, maximum: 150 },
        email: { type: "string", format: "email" },
        role: { type: "string", enum: ["user", "admin"], default: "user" },
      },
      additionalProperties: false,
    },
  },
}, async (req) => ({ received: req.body }));

app.get("/search", {
  schema: {
    querystring: {
      type: "object",
      properties: {
        q: { type: "string" },
        page: { type: "integer", minimum: 1, default: 1 },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
        active: { type: "boolean" },
      },
    },
  },
}, async (req) => {
  const q = req.query as Record<string, unknown>;
  return { values: q, types: Object.fromEntries(Object.entries(q).map(([k, v]) => [k, typeof v])) };
});

app.get("/users/:id/posts/:postId", {
  schema: {
    params: {
      type: "object",
      properties: { id: { type: "integer" }, postId: { type: "string" } },
    },
  },
}, async (req) => {
  const p = req.params as Record<string, unknown>;
  return { values: p, types: Object.fromEntries(Object.entries(p).map(([k, v]) => [k, typeof v])) };
});

const post = async (payload: unknown) =>
  await app.inject({ method: "POST", url: "/users", payload: payload as never });

console.log("=== 1. The handler only ever sees valid input ===");
{
  const ok = await post({ name: "ada", age: 36, email: "ada@example.com" });
  console.log("  valid    →", ok.statusCode, ok.body);
  console.log(`
  Note "role":"user" appeared without being sent — schema DEFAULTS are
  applied. So the handler never has to write \`body.role ?? "user"\`.
`);
}

console.log("=== 2. What it rejects, and how ===");
{
  const cases: Array<[string, unknown]> = [
    ["missing required field", { name: "ada" }],
    ["too short", { name: "a", age: 30 }],
    ["wrong type", { name: "ada", age: "thirty" }],
    ["out of range", { name: "ada", age: -1 }],
    ["bad enum", { name: "ada", age: 30, role: "superuser" }],
    ["bad format", { name: "ada", age: 30, email: "not-an-email" }],
  ];

  for (const [label, payload] of cases) {
    const res = await post(payload);
    const body = res.json() as { message: string };
    console.log(`  ${label.padEnd(24)} → ${res.statusCode} ${body.message}`);
  }

  console.log(`
  Every one of those would have been a hand-written if-statement in module
  10 — per field, per route, forever. And the error messages are consistent,
  which matters more than it sounds: clients can parse them.

  ⚠ The default messages describe the SCHEMA, not your domain
  ("body/name must NOT have fewer than 2 characters"). For a public API,
  map them to your own error shape in setErrorHandler — err.validation holds
  the structured details (see 06-errors-testing.ts).
`);
}

console.log("=== 3. ⚠ additionalProperties: false STRIPS, it does not reject ===");
{
  const res = await post({ name: "ada", age: 30, role: "user", isAdmin: true, id: "forged" });
  console.log("  sent extra fields →", res.statusCode, res.body);
  console.log(`
  Not a 400 — a 200 with the extra fields silently removed.

  That surprises people, but the stripping is the valuable half. Consider:

      await db.users.update(id, req.body);        // ← spreading the body

  Without additionalProperties:false a client can smuggle { isAdmin: true,
  id: "..." } straight into that update. This is MASS ASSIGNMENT, and it is
  a real vulnerability class.

  If you genuinely want a 400 instead, Ajv can be configured for it — but in
  practice stripping is the safer default, because it fails closed.
`);
}

console.log("=== 4. Coercion: strings become the right type ===");
{
  const res = await app.inject({ url: "/search?q=node&page=3&active=true" });
  console.log("  GET /search?q=node&page=3&active=true");
  console.log("   ", res.body);

  const params = await app.inject({ url: "/users/42/posts/abc" });
  console.log("  GET /users/42/posts/abc");
  console.log("   ", params.body);

  console.log(`
  page is a NUMBER and active is a BOOLEAN, though both arrived as strings.
  So does the path param id.

  Everything in a URL is a string (module 09 §1.1), and this removes a whole
  category of bugs:

      Number(req.query.page)          // NaN when absent
      req.query.active === "true"     // and "1"? and "yes"?
      parseInt(req.params.id, 10)     // silently 42 for "42abc"

  Defaults are applied too — page and limit came back set even though the
  URL only supplied page.
`);
}

console.log("=== 5. Sharing schemas ===");
{
  const shared = Fastify({ logger: false });

  shared.addSchema({
    $id: "user",
    type: "object",
    properties: { id: { type: "string" }, name: { type: "string" } },
  });

  shared.get("/one", { schema: { response: { 200: { $ref: "user#" } } } }, async () => ({
    id: "1",
    name: "ada",
    secret: "nope",
  }));

  shared.get("/many", {
    schema: { response: { 200: { type: "array", items: { $ref: "user#" } } } },
  }, async () => [{ id: "1", name: "ada", secret: "nope" }]);

  console.log("  /one  →", (await shared.inject({ url: "/one" })).body);
  console.log("  /many →", (await shared.inject({ url: "/many" })).body);
  await shared.close();

  console.log(`
  One definition, referenced by $ref, used for a single object and a list.
  Change "user" once and every route follows — including the privacy
  boundary from 03-serialization.ts §1.

  These same schemas generate OpenAPI docs (@fastify/swagger) with no extra
  work, which is the other reason to write them.
`);
}

console.log("=== 6. Schemas vs TypeScript ===");
console.log(`
  They solve DIFFERENT problems and you need both:

    TypeScript   compile time. Gone at runtime (module 01: Node ERASES
                 types). A JSON body from the network is 'unknown' no
                 matter what you annotate it as.
    JSON Schema  runtime. Actually inspects the bytes that arrived.

  \`req.body as CreateUser\` is a LIE you tell the compiler — a cast, not a
  check. The schema is what makes it true.

  To avoid writing both by hand, generate one from the other:

    • typebox        — write TS-ish types, get JSON Schema out
    • zod + a bridge — write Zod, convert to JSON Schema
    • json-schema-to-ts — infer TS types FROM your JSON Schema

  Any of them beats maintaining two parallel definitions that drift.
`);

await app.close();
