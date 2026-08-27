/**
 * 03 — The onion: what middleware actually is
 *
 * Run:  node src/10-routing-middleware/03-middleware.ts
 */

import { setTimeout as sleep } from "node:timers/promises";
import { compose, makeContext, type Middleware } from "./_types.ts";

console.log("=== 1. Everything wraps everything below it ===");
{
  const outer: Middleware = async (ctx, next) => {
    ctx.trace.push("outer  →");
    await next();
    ctx.trace.push("outer  ←");
  };
  const middle: Middleware = async (ctx, next) => {
    ctx.trace.push("middle →");
    await next();
    ctx.trace.push("middle ←");
  };
  const handler: Middleware = async (ctx) => {
    ctx.trace.push("HANDLER");
    ctx.status = 200;
  };

  const ctx = makeContext();
  await compose([outer, middle, handler])(ctx);
  for (const line of ctx.trace) console.log("   ", line);

  console.log(`
         ┌─────────────── outer ─────────────────┐
         │  ┌──────────── middle ─────────────┐  │
         │  │  ┌───────── handler ─────────┐  │  │
    req ─┼──┼──┼──────────►                │  │  │
    res ◄┼──┼──┼──────────                 │  │  │
         │  │  └───────────────────────────┘  │  │
         │  └─────────────────────────────────┘  │
         └───────────────────────────────────────┘

  Code BEFORE await next() runs on the way in, in order.
  Code AFTER await next() runs on the way out, in REVERSE order.

  That one property is what makes timing, logging, transactions,
  compression and error boundaries expressible as middleware at all.
`);
}

console.log("=== 2. The 'after' half is where the useful work is ===");
{
  const timing: Middleware = async (ctx, next) => {
    const t0 = performance.now();
    try {
      await next();
    } finally {
      // `finally`, not just after await — otherwise a FAILED request is
      // never timed, and those are the ones you most want to see.
      ctx.state["durationMs"] = performance.now() - t0;
    }
  };

  const handler: Middleware = async (ctx) => {
    await sleep(25);
    ctx.status = 200;
  };

  const ok = makeContext();
  await compose([timing, handler])(ok);
  console.log(`  success → ${(ok.state["durationMs"] as number).toFixed(0)}ms`);

  const failing = makeContext();
  await compose([timing, async () => {
    await sleep(15);
    throw new Error("handler blew up");
  }])(failing).catch(() => {});
  console.log(`  failure → ${(failing.state["durationMs"] as number).toFixed(0)}ms  ← still timed, thanks to finally`);
}

console.log("\n=== 3. Ordering is the whole game ===");
{
  const label = (name: string): Middleware => async (ctx, next) => {
    ctx.trace.push(`${name}→`);
    await next();
    ctx.trace.push(`←${name}`);
  };

  const errorBoundary: Middleware = async (ctx, next) => {
    try {
      await next();
    } catch (err) {
      ctx.trace.push(`CAUGHT(${(err as Error).message})`);
      ctx.status = 500;
    }
  };

  const boom: Middleware = async (ctx) => {
    ctx.trace.push("boom!");
    throw new Error("kaboom");
  };

  const above = makeContext();
  await compose([label("logger"), errorBoundary, label("auth"), boom])(above);
  console.log("  errorBoundary ABOVE the failure:");
  console.log("   ", above.trace.join(" "), `→ ${above.status}`);

  const below = makeContext();
  await compose([label("logger"), label("auth"), boom, errorBoundary])(below).catch((err) => {
    below.trace.push(`ESCAPED(${(err as Error).message})`);
  });
  console.log("  errorBoundary BELOW the failure:");
  console.log("   ", below.trace.join(" "), `→ ${below.status}`);

  console.log(`
  An error boundary only catches what is BELOW it. Registered after the
  router — which is where "put the error handler at the end" instinct puts
  it — it never runs, and the rejection escapes to your unhandled-rejection
  handler and kills the process (module 07 §4.1).
`);
}

console.log("=== 4. The order that actually works ===");
console.log(`
  app.use(requestId);        // 1. everything below can log it
  app.use(logger);           // 2. times everything below, INCLUDING errors
  app.use(errorHandler);     // 3. catches everything below it
  app.use(cors);             // 4. before auth, or preflights get 401
  app.use(bodyParser);       // 5. before anything reading ctx.body
  app.use(auth);             // 6. after cors, before routes
  app.use(router.routes());  // 7. last

  Each position is load-bearing:

    • errorHandler above the router, or it catches nothing (§3).
    • logger above errorHandler, or handled errors are never logged —
      the boundary swallows them before the logger's "after" half runs.
    • cors before auth, or the browser's UNAUTHENTICATED OPTIONS preflight
      gets a 401 and the real request is never sent. The classic symptom:
      curl works, the browser doesn't.
    • bodyParser before auth if auth reads the body (e.g. a signature),
      after it if you don't want to parse bodies for unauthenticated
      requests. Both are defensible; pick deliberately.
`);

console.log("=== 5. Short-circuiting ===");
{
  const authGuard: Middleware = async (ctx, next) => {
    if (!ctx.state["user"]) {
      ctx.status = 401;
      ctx.body = { error: "unauthorized" };
      return; // ← never calls next(): everything downstream is skipped
    }
    await next();
  };

  const handler: Middleware = async (ctx) => {
    ctx.trace.push("handler ran");
    ctx.status = 200;
  };

  const anon = makeContext();
  await compose([authGuard, handler])(anon);
  console.log(`  anonymous → ${anon.status}, handler ran: ${anon.trace.length > 0}`);

  const authed = makeContext();
  authed.state["user"] = { id: "u1" };
  await compose([authGuard, handler])(authed);
  console.log(`  authed    → ${authed.status}, handler ran: ${authed.trace.length > 0}`);

  console.log(`
  Simply NOT calling next() ends the chain. No special "stop" API, no
  exception — the onion just doesn't go any deeper, and the "after" halves
  of everything above still run on the way out.
`);
}

console.log("=== 6. Middleware are just functions ===");
{
  // …so they compose, wrap and take options like any other function.
  const only =
    (method: string, mw: Middleware): Middleware =>
    async (ctx, next) =>
      ctx.method === method ? mw(ctx, next) : next();

  const audit: Middleware = async (ctx, next) => {
    ctx.trace.push("AUDITED");
    await next();
  };

  for (const method of ["GET", "DELETE"]) {
    const ctx = makeContext(method);
    await compose([only("DELETE", audit), async (c) => void (c.status = 200)])(ctx);
    console.log(`  ${method.padEnd(6)} → trace: [${ctx.trace.join(", ")}]`);
  }

  console.log(`
  A conditional wrapper, a router, a sub-application — all of them are just
  a Middleware that decides whether and when to call next(). That is why
  "app.use(router.routes())" works: a router IS middleware.
`);
}
