/**
 * 05 — The request lifecycle, measured
 *
 * Run:  node src/11-fastify/05-hooks.ts
 */

import Fastify from "fastify";

console.log("=== 1. The order, observed ===");
{
  const app = Fastify({ logger: false });
  const seen: string[] = [];

  app.addHook("onRequest", async () => void seen.push("onRequest"));
  app.addHook("preParsing", async (_req, _reply, payload) => {
    seen.push("preParsing");
    return payload; // must return the (possibly transformed) stream
  });
  app.addHook("preValidation", async () => void seen.push("preValidation"));
  app.addHook("preHandler", async () => void seen.push("preHandler"));
  app.addHook("preSerialization", async (_req, _reply, payload) => {
    seen.push("preSerialization");
    return payload; // must return the (possibly transformed) object
  });
  app.addHook("onSend", async (_req, _reply, payload) => {
    seen.push("onSend");
    return payload; // must return the (possibly transformed) string/Buffer
  });
  app.addHook("onResponse", async () => void seen.push("onResponse"));

  app.post("/x", {
    schema: { body: { type: "object", properties: { n: { type: "integer" } } } },
  }, async () => {
    seen.push("HANDLER");
    return { ok: true };
  });

  await app.inject({ method: "POST", url: "/x", payload: { n: 1 } });
  for (const s of seen) console.log("   ", s);
  await app.close();
}

console.log(`
  Each stage exists because something useful can only happen there:

  onRequest         nothing has been read yet — not even the body.
                    → auth, rate limiting, request id.
                    Rejecting here means you NEVER read the 10MB upload.

  preParsing        the raw body stream, before parsing.
                    → decompression, decryption, raw-body capture for
                      signature verification.

  preValidation     the parsed body, before the schema runs.
                    → normalise input you want validation to accept
                      (trim strings, rename legacy field names).

  preHandler        validated input, handler not yet run.
                    → load the user, open a transaction, authorize the
                      specific resource ("can THIS user edit THAT post").

  HANDLER           your business logic.

  preSerialization  the payload OBJECT, before it becomes JSON.
                    → wrap in an envelope, add pagination metadata.

  onSend            the serialized STRING/Buffer.
                    → headers, compression, response signing.

  onResponse        it is already sent; you cannot change it.
                    → metrics, access logs.
`);

console.log("=== 2. onRequest runs before the body is read ===");
{
  const app = Fastify({ logger: false, bodyLimit: 10 * 1024 * 1024 });
  let bodyBytesRead = 0;

  app.addHook("onRequest", async (req, reply) => {
    if (!req.headers["authorization"]) {
      // Rejecting HERE means the multi-megabyte body is never read.
      return reply.status(401).send({ code: "UNAUTHORIZED" });
    }
  });

  app.addHook("preParsing", async (_req, _reply, payload) => {
    payload.on("data", (c: Buffer) => (bodyBytesRead += c.length));
    return payload;
  });

  app.post("/upload", async () => ({ ok: true }));
  await app.ready();

  const big = "x".repeat(2 * 1024 * 1024);

  bodyBytesRead = 0;
  const rejected = await app.inject({ method: "POST", url: "/upload", payload: big });
  console.log(`  no auth  → ${rejected.statusCode}, body bytes read: ${bodyBytesRead}`);

  bodyBytesRead = 0;
  const accepted = await app.inject({
    method: "POST",
    url: "/upload",
    payload: big,
    headers: { authorization: "Bearer x", "content-type": "text/plain" },
  });
  console.log(`  with auth → ${accepted.statusCode}, body bytes read: ${(bodyBytesRead / 1024 / 1024).toFixed(0)}MB`);
  await app.close();

  console.log(`
  That is a real defence, not a micro-optimisation. An unauthenticated
  client cannot make you buffer megabytes — the connection is answered and
  closed before the body matters (module 09 §2.1).

  Put auth in onRequest. Put anything that NEEDS the body in preHandler.
`);
}

console.log("=== 3. Transform hooks must RETURN the payload ===");
{
  const app = Fastify({ logger: false });

  app.addHook("preSerialization", async (_req, _reply, payload) => {
    // Wrap every response in an envelope.
    return { data: payload, meta: { version: "v1" } };
  });

  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("x-powered-by-hook", "yes");
    return payload; // ← forget this and the body becomes undefined
  });

  app.get("/x", async () => ({ id: "1" }));
  const res = await app.inject({ url: "/x" });
  console.log("  body:  ", res.body);
  console.log("  header:", res.headers["x-powered-by-hook"]);
  await app.close();

  console.log(`
  preParsing, preSerialization and onSend are TRANSFORM hooks: whatever you
  return replaces the payload. Returning nothing means returning undefined,
  and the response body silently disappears.

  The other hooks (onRequest, preValidation, preHandler, onResponse) are
  OBSERVERS — their return value is ignored, except that returning a reply
  short-circuits the request.
`);
}

console.log("=== 4. Short-circuiting ===");
{
  const app = Fastify({ logger: false });
  const reached: string[] = [];

  app.addHook("onRequest", async (req, reply) => {
    if (req.headers["x-block"]) {
      // Sending from a hook ends the request. Nothing downstream runs.
      return reply.status(403).send({ code: "BLOCKED" });
    }
  });
  app.addHook("preHandler", async () => void reached.push("preHandler"));
  app.get("/x", async () => {
    reached.push("handler");
    return { ok: true };
  });

  reached.length = 0;
  const blocked = await app.inject({ url: "/x", headers: { "x-block": "1" } });
  console.log(`  blocked → ${blocked.statusCode}, reached: [${reached.join(", ")}]`);

  reached.length = 0;
  const allowed = await app.inject({ url: "/x" });
  console.log(`  allowed → ${allowed.statusCode}, reached: [${reached.join(", ")}]`);
  await app.close();

  console.log(`
  ⚠ You must RETURN reply.send(...) — or await it. Calling it without
  returning lets the hook resolve, and Fastify continues to the next stage
  while a response is already going out. That is the framework equivalent
  of the double-send bug from module 09 §3.4.
`);
}

console.log("=== 5. onResponse: metrics that always fire ===");
{
  const app = Fastify({ logger: false });
  const metrics: Array<{ route: string; status: number; ms: number }> = [];

  app.addHook("onResponse", async (req, reply) => {
    metrics.push({
      // routeOptions.url is the PATTERN ("/users/:id"), not the concrete
      // path — the cardinality lesson from module 10 §3, built in.
      route: req.routeOptions?.url ?? "unmatched",
      status: reply.statusCode,
      ms: reply.elapsedTime,
    });
  });

  app.get("/users/:id", async () => ({ ok: true }));
  app.get("/fail", async () => {
    throw new Error("boom");
  });

  for (const url of ["/users/1", "/users/2", "/fail", "/nope"]) {
    await app.inject({ url });
  }
  await app.close();

  for (const m of metrics) {
    console.log(`  ${m.route.padEnd(14)} ${String(m.status).padEnd(4)} ${m.ms.toFixed(1)}ms`);
  }
  console.log(`
  onResponse fires for successes, errors AND 404s — so your request count
  is actually a request count. reply.elapsedTime is provided; you don't
  hand-roll the timing from module 10 §3.

  And note /users/1 and /users/2 both recorded as "/users/:id": one time
  series, not one per id.
`);
}

console.log("=== 6. Choosing a stage ===");
console.log(`
  "Where does this belong?" — answer these in order:

    Does it need the BODY?          no  → onRequest
    Does it need VALIDATED input?   no  → preParsing / preValidation
    Does it need the handler's
      RESULT?                       no  → preHandler
    Does it change the OBJECT?          → preSerialization
    Does it change the BYTES or
      the headers?                      → onSend
    Is it just observation?             → onResponse

  Cheapest checks first: auth and rate limiting in onRequest reject bad
  traffic before you spend anything on it.
`);
