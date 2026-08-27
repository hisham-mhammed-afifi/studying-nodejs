/**
 * 01 — The same API, hand-rolled vs Fastify
 *
 * Run:  node src/11-fastify/01-vs-handrolled.ts
 */

import Fastify from "fastify";
import { createApp, HttpError, Router } from "../10-routing-middleware/solution.ts";

interface User {
  id: string;
  name: string;
  age: number;
  passwordHash: string; // must never leave the process
}

const users = new Map<string, User>([
  ["1", { id: "1", name: "ada", age: 36, passwordHash: "$2b$10$SECRET" }],
]);

console.log("=== 1. Hand-rolled (module 10) ===");
{
  const app = createApp();
  const router = new Router();

  router.get("/users/:id", async (ctx) => {
    const user = users.get(ctx.params["id"] as string);
    if (!user) throw new HttpError(404, "NOT_FOUND", "user not found");

    // Every field you forget to omit here goes out on the wire.
    ctx.status = 200;
    ctx.body = { id: user.id, name: user.name, age: user.age };
  });

  router.post("/users", async (ctx) => {
    // Validation by hand, per field, per route.
    const body = ctx.state["body"] as Record<string, unknown> | undefined;
    if (!body || typeof body["name"] !== "string" || body["name"].length < 2) {
      throw new HttpError(400, "VALIDATION", "name must be a string of 2+ characters");
    }
    if (typeof body["age"] !== "number" || !Number.isInteger(body["age"]) || body["age"] < 0) {
      throw new HttpError(400, "VALIDATION", "age must be a non-negative integer");
    }
    ctx.status = 201;
    ctx.body = { id: "2", name: body["name"], age: body["age"] };
  });

  app.use(router.routes());
  await app.listen();

  const found = await fetch(`http://127.0.0.1:${app.port}/users/1`);
  console.log("  GET /users/1 →", found.status, await found.text());

  const missing = await fetch(`http://127.0.0.1:${app.port}/users/99`);
  console.log("  GET /users/99 →", missing.status, await missing.text());

  await app.close();
}

console.log(`
  ~35 lines, and every one of these is YOUR responsibility:
    • listing response fields by hand, on every route
    • validating each field, by hand, on every route
    • remembering that req.query values are strings
    • starting a real server on a real port just to test it
`);

console.log("=== 2. The same thing in Fastify ===");
{
  const app = Fastify({ logger: false });

  const userResponse = {
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      age: { type: "integer" },
      // passwordHash is ABSENT — so it cannot be sent, ever.
    },
  } as const;

  const errorResponse = {
    type: "object",
    properties: { code: { type: "string" }, message: { type: "string" } },
  } as const;

  app.get("/users/:id", {
    schema: {
      params: { type: "object", properties: { id: { type: "string" } } },
      // A schema PER STATUS CODE. Declaring only 200 makes reply.send()
      // type-error on any other shape — which is the types doing their job.
      response: { 200: userResponse, 404: errorResponse },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const user = users.get(id);
    if (!user) return reply.status(404).send({ code: "NOT_FOUND", message: "user not found" });
    // Returning the WHOLE user is safe: the schema is an allowlist.
    return user;
  });

  app.post("/users", {
    schema: {
      body: {
        type: "object",
        required: ["name", "age"],
        properties: {
          name: { type: "string", minLength: 2 },
          age: { type: "integer", minimum: 0 },
        },
        additionalProperties: false,
      },
      response: { 201: userResponse },
    },
  }, async (req, reply) => {
    const body = req.body as { name: string; age: number };
    // No validation code at all — the handler only sees valid input.
    return reply.status(201).send({ id: "2", ...body, passwordHash: "never-sent" });
  });

  // inject(): the whole lifecycle, in memory, no port.
  const found = await app.inject({ url: "/users/1" });
  console.log("  GET /users/1 →", found.statusCode, found.body);

  const missing = await app.inject({ url: "/users/99" });
  console.log("  GET /users/99 →", missing.statusCode, missing.body);

  const created = await app.inject({ method: "POST", url: "/users", payload: { name: "grace", age: 45 } });
  console.log("  POST /users  →", created.statusCode, created.body);

  const invalid = await app.inject({ method: "POST", url: "/users", payload: { name: "g", age: -1 } });
  console.log("  POST invalid →", invalid.statusCode, invalid.body);

  await app.close();
}

console.log(`
  Look at the two POST results above.

  The hand-rolled version needed ~8 lines of validation per route. Fastify
  needed a schema — declarative, testable, and reusable as documentation.

  And look at the GET: the handler RETURNS THE WHOLE USER, passwordHash and
  all, but the response schema stripped it. In the hand-rolled version the
  safety came from a developer remembering to list three fields correctly,
  every time, in every route, forever.

  That difference — a structural guarantee versus a habit — is the strongest
  argument for the framework, and it has nothing to do with speed.
`);

console.log("=== 3. What each one costs you ===");
console.log(`
  HAND-ROLLED (module 10)              FASTIFY
  ─────────────────────────────────    ──────────────────────────────────
  ~200 lines you own and understand    a dependency, and its dependencies
  validation per route, by hand        declarative schemas
  response fields listed by hand       response schema = an allowlist
  tests need a real port               inject(), in memory
  middleware order is global           plugin encapsulation (04-plugins.ts)
  you choose every behaviour           conventions you have to learn

  Neither is wrong. The hand-rolled version is genuinely enough for a
  webhook receiver or a sidecar. Fastify earns its place when a team is
  adding routes over years and "remember to omit passwordHash" stops being
  a reliable plan.
`);
