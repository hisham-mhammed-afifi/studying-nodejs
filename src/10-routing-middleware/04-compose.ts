/**
 * 04 — Building compose(), and what each line is for
 *
 * Run:  node src/10-routing-middleware/04-compose.ts
 */

import { compose, makeContext, type Context, type Middleware } from "./_types.ts";

console.log("=== 1. The whole engine ===");
console.log(`
  function compose(middleware) {
    return function run(ctx) {
      let lastCalled = -1;                              // (c)

      function dispatch(i) {
        if (i <= lastCalled) {                          // (c)
          return Promise.reject(new Error("next() called multiple times"));
        }
        lastCalled = i;

        const fn = middleware[i];
        if (!fn) return Promise.resolve();              // (a)

        return Promise.resolve().then(                  // (b)
          () => fn(ctx, () => dispatch(i + 1))          // (d)
        );
      }

      return dispatch(0);
    };
  }

  Four decisions, each load-bearing:

  (a) The end of the array resolves. next() from the LAST middleware is a
      no-op rather than a crash, so a handler can call next() harmlessly.

  (b) Promise.resolve().then() normalises a SYNCHRONOUS throw into a
      rejection. Without it, \`compose([...])(ctx).catch(h)\` misses sync
      throws and you need try/catch AND .catch at every call site.

  (c) The double-next() guard. Without it a stray second next() re-runs
      everything downstream — a second database write, a second res.end()
      (module 09 §3.4), a crash.

  (d) next is a CLOSURE over i, so each middleware can only advance to the
      next one. It cannot skip ahead or restart the chain.
`);

console.log("=== 2. Sync throws are caught too ===");
{
  const syncThrow: Middleware = () => {
    throw new Error("thrown synchronously, not returned as a rejection");
  };

  const err = await compose([syncThrow])(makeContext()).catch((e: Error) => e);
  console.log("  caught by .catch():", (err as Error).message, "✓");
  console.log(`
  That only works because of (b). A naive implementation —

      return fn(ctx, () => dispatch(i + 1));

  — lets a synchronous throw escape past the promise chain entirely, so
  your error boundary silently doesn't cover half your middleware.
`);
}

console.log("=== 3. Errors propagate UP the onion ===");
{
  const trace: string[] = [];
  const outer: Middleware = async (ctx, next) => {
    trace.push("outer→");
    try {
      await next();
    } catch (err) {
      trace.push(`outer caught: ${(err as Error).message}`);
      throw err; // rethrow, so anything above sees it too
    } finally {
      trace.push("←outer");
    }
  };
  const middle: Middleware = async (_ctx, next) => {
    trace.push("middle→");
    await next();
    trace.push("←middle (never reached)");
  };
  const boom: Middleware = async () => {
    trace.push("boom");
    throw new Error("deep failure");
  };

  await compose([outer, middle, boom])(makeContext()).catch(() => trace.push("escaped to caller"));
  for (const t of trace) console.log("   ", t);

  console.log(`
  A rejection unwinds through every await next() on the way out. Middleware
  that did NOT try/catch simply never runs its "after" half — note that
  "←middle" is missing.

  That is why cleanup belongs in \`finally\`, not after the await:

      try { await next(); } finally { releaseConnection(); }
`);
}

console.log("=== 4. The double-next() guard, earning its keep ===");
{
  const doubleNext: Middleware = async (_ctx, next) => {
    await next();
    await next(); // ← the bug
  };

  let handlerRuns = 0;
  const handler: Middleware = async () => {
    handlerRuns++;
  };

  const err = await compose([doubleNext, handler])(makeContext()).catch((e: Error) => e);
  console.log("  handler ran:", handlerRuns, "time(s)");
  console.log("  rejected with:", (err as Error).message);

  console.log(`
  Without the guard the handler runs TWICE: two database writes, two
  res.end() calls (which emits 'error' and can crash the process —
  module 09 §3.4), two log lines with the same request id.

  And it fails silently in the happy path, so it ships. The guard turns a
  heisenbug into a loud, immediate error naming the middleware index.
`);
}

console.log("=== 5. compose returns a Middleware, so it nests ===");
{
  const tag =
    (name: string): Middleware =>
    async (ctx, next) => {
      ctx.trace.push(`${name}→`);
      await next();
      ctx.trace.push(`←${name}`);
    };

  // A composed chain wrapped as ONE middleware — this is how sub-routers,
  // route groups and mounted apps work.
  const apiGroup = compose([tag("auth"), tag("rateLimit")]);
  const asMiddleware: Middleware = (ctx, next) =>
    apiGroup(ctx).then(() => next());

  const ctx = makeContext();
  await compose([tag("logger"), asMiddleware, tag("handler")])(ctx);
  console.log("   ", ctx.trace.join(" "));

  console.log(`
  ⚠ Note the shape of asMiddleware. A composed chain's own next() ends at
  the end of ITS array, so to continue outward you chain .then(next). Koa
  provides compose() with this built in; if you hand-roll grouping, this is
  the line to get right — forget it and everything after the group is
  silently skipped.
`);
}

console.log("=== 6. Compose ONCE, at startup ===");
{
  const layers: Middleware[] = Array.from({ length: 10 }, (_, i) => tagOnly(`m${i}`));
  const N = 20_000;

  // Correct: build the chain once.
  const prebuilt = compose([...layers, async (c: Context) => void (c.status = 200)]);
  for (let i = 0; i < 2_000; i++) await prebuilt(makeContext()); // warm-up
  const t0 = performance.now();
  for (let i = 0; i < N; i++) await prebuilt(makeContext());
  const preMs = performance.now() - t0;

  // Wrong: rebuild it per request.
  const t1 = performance.now();
  for (let i = 0; i < N; i++) {
    await compose([...layers, async (c: Context) => void (c.status = 200)])(makeContext());
  }
  const perReqMs = performance.now() - t1;

  console.log(`  composed once, ${N.toLocaleString()} requests:     ${preMs.toFixed(0)}ms  (${((preMs * 1000) / N).toFixed(1)}µs each)`);
  console.log(`  recomposed per request:              ${perReqMs.toFixed(0)}ms  (${((perReqMs * 1000) / N).toFixed(1)}µs each)`);
  console.log(`
  Two honest conclusions, and the second one surprised me:

  1. 10 middleware layers cost about ${((preMs * 1000) / N).toFixed(1)}µs per request — a closure and
     a promise each. That is cheap. Do not fear layers.

  2. Recomposing per request was only ${(((perReqMs - preMs) / preMs) * 100).toFixed(0)}% slower. compose() just
     builds a closure; the array spread is the only real allocation, and
     V8 handles that easily.

  So "compose once at startup" is good hygiene — it keeps the chain
  identity stable, which matters for caching and for reasoning — but it is
  NOT a performance fix. If someone tells you their framework is slow
  because of middleware depth, measure before believing it.

  For scale: the linear regex router in 02-matchers.ts cost 10.5µs per
  lookup on its own — roughly ${(10.5 / ((preMs * 1000) / N)).toFixed(0)}× the entire 10-layer chain. Routing
  dominates middleware depth, by a lot.
`);

  function tagOnly(name: string): Middleware {
    return async (ctx, next) => {
      ctx.state[name] = true;
      await next();
    };
  }
}
