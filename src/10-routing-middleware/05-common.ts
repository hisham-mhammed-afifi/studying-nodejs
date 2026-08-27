/**
 * 05 — The middleware every service ends up writing
 *
 * Run:  node src/10-routing-middleware/05-common.ts
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { compose, makeContext, type Context, type Middleware } from "./_types.ts";

class HttpError extends Error {
  // NOT `constructor(readonly statusCode: number, ...)`. Parameter
  // properties need codegen, and Node only ERASES types — module 05 §6.1.
  readonly statusCode: number;
  readonly code: string;
  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

const requestContext = new AsyncLocalStorage<{ requestId: string }>();

/** A logger that picks up the request id with no parameter passing. */
function log(level: string, msg: string, fields: Record<string, unknown> = {}): void {
  console.log(
    "   " +
      JSON.stringify({
        level,
        msg,
        requestId: requestContext.getStore()?.requestId ?? null,
        ...fields,
      }),
  );
}

// ─────────────────────────────────────────────────────────────────────────────

console.log("=== 1. Request ID + async context ===");
{
  const withRequestId: Middleware = async (ctx, next) => {
    const requestId = (ctx.state["incomingRequestId"] as string | undefined) ?? randomUUID();
    ctx.state["requestId"] = requestId;
    // Everything downstream — at any depth, through any await — can read
    // this without it being threaded through a single signature (module 07 §6).
    await requestContext.run({ requestId }, () => next());
  };

  const deepInTheStack: Middleware = async (ctx) => {
    await sleep(5);
    log("info", "loaded user", { userId: "u42" });
    ctx.status = 200;
  };

  await compose([withRequestId, deepInTheStack])(makeContext("GET", "/users/42"));

  console.log(`
  Echo it back in the response too:

      ctx.res.setHeader("x-request-id", requestId);

  …and honour an INCOMING x-request-id when a proxy or client supplies one,
  so a trace survives across service boundaries. Validate it first — it's
  attacker-controlled and ends up in your logs and headers.
`);
}

console.log("=== 2. Error boundary ===");
{
  const errorHandler: Middleware = async (ctx, next) => {
    try {
      await next();
    } catch (err) {
      if (err instanceof HttpError) {
        // Expected, operational (module 07 §4): the client gets the detail.
        ctx.status = err.statusCode;
        ctx.body = { code: err.code, message: err.message };
        log("warn", "request failed", { status: err.statusCode, code: err.code });
      } else {
        // Unexpected: log everything, tell the client nothing.
        ctx.status = 500;
        ctx.body = { code: "INTERNAL" };
        log("error", "unhandled error", { err: (err as Error).message });
      }
    }
  };

  const notFound: Middleware = async () => {
    throw new HttpError(404, "NOT_FOUND", "user 42 not found");
  };
  const leaky: Middleware = async () => {
    throw new Error("connect ECONNREFUSED db.internal:5432 (password=hunter2)");
  };

  for (const [label, mw] of [
    ["expected", notFound],
    ["unexpected", leaky],
  ] as const) {
    const ctx = makeContext();
    await compose([errorHandler, mw])(ctx);
    console.log(`  ${label.padEnd(11)} → ${ctx.status} ${JSON.stringify(ctx.body)}`);
  }

  console.log(`
  Note what the client sees for the second one: { "code": "INTERNAL" }. The
  connection string, the hostname and the password stay in YOUR logs.

  Leaking err.message is how internal hostnames, SQL fragments and
  credentials end up in bug reports and screenshots.
`);
}

console.log("=== 3. Timing, with the right label ===");
{
  const metrics: Array<{ route: string; ms: number; status: number }> = [];

  const timing: Middleware = async (ctx, next) => {
    const t0 = performance.now();
    try {
      await next();
    } finally {
      metrics.push({
        // ⚠ ctx.route (the PATTERN), never ctx.path (the concrete URL).
        route: ctx.route ?? "unmatched",
        ms: performance.now() - t0,
        status: ctx.status,
      });
    }
  };

  const fakeRouter: Middleware = async (ctx, next) => {
    ctx.route = "/users/:id";
    ctx.params = { id: ctx.path.split("/")[2] ?? "" };
    await next();
  };

  for (const id of ["1", "2", "3"]) {
    const ctx = makeContext("GET", `/users/${id}`);
    await compose([timing, fakeRouter, async (c) => {
      await sleep(3);
      c.status = 200;
    }])(ctx);
  }

  console.log("  recorded:", metrics.map((m) => `${m.route} ${m.status} ${m.ms.toFixed(0)}ms`));
  console.log(`
  Three requests, ONE time series. If you had labelled by ctx.path you would
  now have /users/1, /users/2, /users/3 — a separate series per user id.

  That is a CARDINALITY EXPLOSION. It is the fastest way to take down a
  Prometheus or Datadog bill, and it makes the metric useless: you cannot
  ask "how slow is the user endpoint" if every request is its own label.

  Rule: label with the ROUTE PATTERN. Never with anything user-controlled —
  no ids, no query strings, no user agents.
`);
}

console.log("=== 4. CORS, and why it must precede auth ===");
{
  const cors: Middleware = async (ctx, next) => {
    ctx.state["corsHeaders"] = { "access-control-allow-origin": "*" };
    if (ctx.method === "OPTIONS") {
      // A preflight is answered HERE and goes no further. It carries no
      // credentials — that's the whole point — so it must not reach auth.
      ctx.status = 204;
      return;
    }
    await next();
  };

  const auth: Middleware = async (ctx, next) => {
    if (!ctx.state["token"]) {
      ctx.status = 401;
      ctx.body = { code: "UNAUTHORIZED" };
      return;
    }
    await next();
  };

  const handler: Middleware = async (ctx) => void (ctx.status = 200);

  const preflightCorsFirst = makeContext("OPTIONS", "/api/things");
  await compose([cors, auth, handler])(preflightCorsFirst);
  console.log(`  cors → auth, OPTIONS preflight  → ${preflightCorsFirst.status} ✓`);

  const preflightAuthFirst = makeContext("OPTIONS", "/api/things");
  await compose([auth, cors, handler])(preflightAuthFirst);
  console.log(`  auth → cors, OPTIONS preflight  → ${preflightAuthFirst.status} ✗`);

  console.log(`
  The 401 on a preflight is the classic "works in curl, fails in the
  browser" bug: curl sends the real request directly, the browser sends an
  unauthenticated OPTIONS first, gets a 401, and never sends the real one.

  The console error blames CORS, so people spend hours on CORS config when
  the actual bug is one line of middleware ordering.
`);
}

console.log("=== 5. Rate limiting ===");
{
  const buckets = new Map<string, { count: number; resetAt: number }>();

  const rateLimit =
    (limit: number, windowMs: number): Middleware =>
    async (ctx, next) => {
      const key = (ctx.state["clientIp"] as string) ?? "unknown";
      const now = Date.now();
      const bucket = buckets.get(key);

      if (!bucket || now >= bucket.resetAt) {
        buckets.set(key, { count: 1, resetAt: now + windowMs });
      } else if (bucket.count >= limit) {
        ctx.status = 429;
        ctx.body = { code: "RATE_LIMITED" };
        ctx.state["retryAfter"] = Math.ceil((bucket.resetAt - now) / 1000);
        return;
      } else {
        bucket.count += 1;
      }
      await next();
    };

  const chain = compose([rateLimit(3, 1_000), async (c: Context) => void (c.status = 200)]);
  const statuses: number[] = [];
  for (let i = 0; i < 5; i++) {
    const ctx = makeContext();
    ctx.state["clientIp"] = "10.0.0.1";
    await chain(ctx);
    statuses.push(ctx.status);
  }
  console.log("  5 requests, limit 3/second →", statuses.join(", "));

  console.log(`
  Three things this toy gets wrong, and a real one must not:

    • The Map grows forever — one entry per IP, never evicted. Use an LRU,
      or Redis if you have more than one process.
    • Per-PROCESS state. Behind a load balancer with 4 instances your
      "3 per second" is really 12 (module 08 §5: cluster workers share
      nothing).
    • Always send Retry-After on a 429, and ideally RateLimit-Limit /
      RateLimit-Remaining / RateLimit-Reset, so clients can back off
      properly instead of hammering.

  And key by something meaningful: an API key or user id where you have
  one, IP only as a fallback — an office behind one NAT is a single IP.
`);
}

console.log("=== 6. The order, once more ===");
console.log(`
  app.use(withRequestId);    // everything below can log it
  app.use(timing);           // times everything below, including errors
  app.use(errorHandler);     // catches everything below
  app.use(cors);             // BEFORE auth — preflights carry no credentials
  app.use(rateLimit);        // before expensive work, after cheap identification
  app.use(bodyParser);       // before anything that reads the body
  app.use(auth);
  app.use(router.routes());  // last

  Each of those is one of the demos above. None of the positions is
  arbitrary, and every one of them has caused a production incident
  somewhere.
`);
