/**
 * 06 — The bugs this design makes easy to write
 *
 * Run:  node src/10-routing-middleware/06-pitfalls.ts
 */

import { setTimeout as sleep } from "node:timers/promises";
import { compose, makeContext, type Context, type Middleware } from "./_types.ts";

console.log("=== 1. Forgetting await next() ===");
{
  const broken: Middleware = async (ctx, next) => {
    const t0 = performance.now();
    next(); // ← no await
    ctx.state["brokenMs"] = performance.now() - t0;
  };

  const fixed: Middleware = async (ctx, next) => {
    const t0 = performance.now();
    await next();
    ctx.state["fixedMs"] = performance.now() - t0;
  };

  const slowHandler: Middleware = async (ctx) => {
    await sleep(40);
    ctx.status = 200;
  };

  const a = makeContext();
  await compose([broken, slowHandler])(a);
  await sleep(60); // let the orphaned work finish
  console.log(`  without await → measured ${(a.state["brokenMs"] as number).toFixed(1)}ms for a 40ms handler ✗`);

  const b = makeContext();
  await compose([fixed, slowHandler])(b);
  console.log(`  with await    → measured ${(b.state["fixedMs"] as number).toFixed(1)}ms ✓`);

  console.log(`
  Every timing/logging middleware written without await reports ~0ms,
  forever, and nobody notices because the dashboard looks great.

  It is worse than a wrong number. The composed promise resolves before the
  handler finishes, so:
    • the response may be sent before the work completes
    • errors thrown after that point are UNHANDLED REJECTIONS (module 07)
    • cleanup in the "after" half runs while the handler is still running

  ESLint's require-await and no-floating-promises both catch this. Turn
  them on.
`);
}

console.log("=== 2. Swallowing errors ===");
{
  const swallow: Middleware = async (_ctx, next) => {
    try {
      await next();
    } catch {
      // "I'll handle it later"
    }
  };

  const boom: Middleware = async () => {
    throw new Error("real failure");
  };

  const ctx = makeContext();
  await compose([swallow, boom])(ctx);
  console.log(`  status after a swallowed error: ${ctx.status}, body: ${JSON.stringify(ctx.body)}`);
  console.log(`
  Nothing threw, nothing was logged, and the context is untouched — status
  ${ctx.status}, no body. In a real server that is a request that never gets a
  response: the client waits until ITS timeout, and your logs show nothing.

  An empty catch is worse than no catch. If you catch, you must either
  handle it (set a status and a body) or rethrow.
`);
}

console.log("=== 3. Responding twice ===");
{
  // In a real server this is res.end() twice — which emits 'error' on the
  // response and, unhandled, crashes the process (module 09 §3.4).
  const sends: string[] = [];
  const send = (ctx: Context, status: number, body: unknown): void => {
    if (ctx.state["sent"]) {
      sends.push(`BLOCKED second send (${status})`);
      return; // ← the guard
    }
    ctx.state["sent"] = true;
    ctx.status = status;
    ctx.body = body;
    sends.push(`sent ${status}`);
  };

  const guard: Middleware = async (ctx, next) => {
    try {
      await next();
    } catch (err) {
      send(ctx, 500, { error: (err as Error).message });
    }
  };

  const handlerThatRespondsThenThrows: Middleware = async (ctx) => {
    send(ctx, 200, { ok: true });
    throw new Error("failed AFTER responding");
  };

  const ctx = makeContext();
  await compose([guard, handlerThatRespondsThenThrows])(ctx);
  console.log("  ", sends.join(" | "));
  console.log(`  final status: ${ctx.status}`);
  console.log(`
  A handler that responds and THEN throws is common — a post-response
  side-effect that fails, a cleanup that rejects. The error boundary then
  tries to send a 500 on a response that already went out.

  In plain Node that is ERR_STREAM_WRITE_AFTER_END, an 'error' event on
  res, and a dead process. Always check before writing:

      if (res.headersSent || res.writableEnded) { res.destroy(); return; }
`);
}

console.log("=== 4. Middleware that assumes it ran ===");
{
  const auth: Middleware = async (ctx, next) => {
    if (ctx.state["token"] === "valid") ctx.state["user"] = { id: "u1" };
    await next();
  };

  // ✗ Assumes auth ran and succeeded.
  const optimistic: Middleware = async (ctx) => {
    const user = ctx.state["user"] as { id: string };
    ctx.body = { greeting: `hello ${user.id}` }; // throws for anonymous
    ctx.status = 200;
  };

  // ✓ Checks.
  const careful: Middleware = async (ctx) => {
    const user = ctx.state["user"] as { id: string } | undefined;
    if (!user) {
      ctx.status = 401;
      ctx.body = { code: "UNAUTHORIZED" };
      return;
    }
    ctx.status = 200;
    ctx.body = { greeting: `hello ${user.id}` };
  };

  const anon = makeContext();
  const err = await compose([auth, optimistic])(anon).catch((e: Error) => e.message);
  console.log("  optimistic, anonymous →", err);

  const anon2 = makeContext();
  await compose([auth, careful])(anon2);
  console.log(`  careful,    anonymous → ${anon2.status} ${JSON.stringify(anon2.body)}`);

  console.log(`
  ctx.state is an untyped bag, so "auth definitely ran" is an assumption the
  compiler cannot check. Two defences:

    1. Make the guard middleware SHORT-CIRCUIT (return without next()) so
       downstream literally cannot run without a user.
    2. Type the accessor:

           function requireUser(ctx: Context): User {
             const user = ctx.state.user as User | undefined;
             if (!user) throw new HttpError(401, "UNAUTHORIZED", "login required");
             return user;
           }

  The second is the one that survives someone reordering app.use() calls.
`);
}

console.log("=== 5. Route matching on the raw path ===");
{
  console.log(`
  Three ways the same resource arrives:

      /users/42          the obvious one
      /users/42/         trailing slash
      /Users/42          different case

  Decide a policy and apply it ONCE, in middleware, before the router:

      • trailing slash → redirect 301 to the canonical form, or strip it
      • case → paths are case-SENSITIVE per RFC; only lowercase the parts
        you control, never the params
      • duplicate slashes (//users//42) → collapse or reject

  Doing it per route guarantees you miss one. Doing it after the router is
  too late — it already returned 404.

  ⚠ And never lowercase the whole path: "/files/MyDocument.pdf" is a
  different file from "/files/mydocument.pdf" on a case-sensitive
  filesystem (module 06 §5.5).
`);
}

console.log("=== 6. The checklist ===");
console.log(`
  ✓ await next() — always. Lint for floating promises.
  ✓ Cleanup in \`finally\`, not after the await.
  ✓ Never an empty catch. Handle or rethrow.
  ✓ Guard every send: headersSent / writableEnded.
  ✓ Guards short-circuit; downstream re-checks anyway.
  ✓ Error boundary ABOVE the router.
  ✓ CORS above auth.
  ✓ Metrics labelled with the route PATTERN.
  ✓ Normalise paths once, before routing.
  ✓ Compose returns a promise — catch it at the top (module 09 §6.3):

        void chain(ctx).catch((err) => { ... });
`);
