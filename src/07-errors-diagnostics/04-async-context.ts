/**
 * 04 — AsyncLocalStorage: request context without plumbing
 *
 * Run:  node src/07-errors-diagnostics/04-async-context.ts
 */

import { AsyncLocalStorage, AsyncResource } from "node:async_hooks";
import { EventEmitter } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";

interface Ctx {
  requestId: string;
  userId?: string;
}

const context = new AsyncLocalStorage<Ctx>();

/** A logger that picks up the request id with no parameter passing. */
function log(msg: string, extra: Record<string, unknown> = {}) {
  const store = context.getStore();
  console.log(`  ${JSON.stringify({ msg, requestId: store?.requestId ?? null, ...extra })}`);
}

console.log("=== 1. The problem it solves ===");
console.log(`
  A request id has to appear in every log line, from the HTTP handler down
  through service → repository → database driver.

  Without AsyncLocalStorage every signature grows a parameter:

      handler(req, res)
        → service(input, ctx)
          → repository(query, ctx)
            → driver(sql, ctx)

  …and one library in the middle that doesn't take a ctx breaks the chain.
`);

console.log("=== 2. It survives everything async ===");
{
  await context.run({ requestId: "req-1" }, async () => {
    log("synchronous");
    await sleep(10);
    log("after await");

    await Promise.all([
      (async () => {
        await sleep(5);
        log("inside Promise.all");
      })(),
    ]);

    await new Promise<void>((resolve) =>
      setTimeout(() => {
        log("inside setTimeout");
        resolve();
      }, 5),
    );

    // Nested run() shadows the outer store for its own subtree.
    await context.run({ requestId: "req-1-child" }, async () => log("nested run()"));
    log("back outside the nested run");
  });

  log("outside run() entirely");
  console.log(`
  The last line has requestId: null — the context is correctly scoped, not
  a global. Two concurrent requests each see their own store.
`);
}

console.log("=== 3. Concurrent requests don't leak into each other ===");
{
  async function handleRequest(id: string, delayMs: number) {
    await context.run({ requestId: id }, async () => {
      await sleep(delayMs);
      log("finished", { delayMs });
    });
  }

  // Deliberately interleaved: req-B finishes first.
  await Promise.all([handleRequest("req-A", 30), handleRequest("req-B", 10), handleRequest("req-C", 20)]);
  console.log("  → each line carries its OWN id, despite interleaving ✓");
}

console.log("\n=== 4. ⚠ The EventEmitter trap ===");
{
  const bus = new EventEmitter();

  await context.run({ requestId: "REGISTERED-HERE" }, async () => {
    bus.on("plain", () => log("plain listener"));
  });

  await context.run({ requestId: "EMITTED-HERE" }, async () => {
    bus.emit("plain");
  });

  bus.emit("plain");

  console.log(`
  A listener sees the context where the event was EMITTED, not where it was
  registered — and no context at all if the emit happens outside a run().

  That is almost always backwards. A listener registered during request A
  should log with A's id, whoever ends up emitting.
`);
}

console.log("=== 5. The fix: AsyncResource.bind ===");
{
  const bus = new EventEmitter();

  await context.run({ requestId: "REGISTERED-HERE" }, async () => {
    // Captures the CURRENT context and re-enters it on every call.
    bus.on("bound", AsyncResource.bind(() => log("bound listener")));
  });

  await context.run({ requestId: "EMITTED-HERE" }, async () => bus.emit("bound"));
  bus.emit("bound");

  console.log(`
  Both emits now report REGISTERED-HERE ✓

  Use AsyncResource.bind for any callback you hand to something long-lived:
  event listeners, connection-pool callbacks, job-queue handlers, cache
  callbacks — anything that outlives the request that registered it.
`);
}

console.log("=== 6. AsyncLocalStorage.snapshot() (Node 20+) ===");
{
  // Same idea for a plain function you want to run later, in the same context.
  const queue: Array<() => void> = [];

  await context.run({ requestId: "SNAPSHOT-CTX" }, async () => {
    const snapshot = AsyncLocalStorage.snapshot();
    queue.push(() => snapshot(() => log("deferred work")));
    // Without the snapshot the deferred call would see no context.
    queue.push(() => log("deferred work, unbound"));
  });

  for (const job of queue) job();
  console.log("  → the snapshot version keeps the id; the unbound one loses it");
}

console.log("\n=== 7. ⚠ enterWith() has no scope ===");
{
  const legacy = new AsyncLocalStorage<string>();

  function middlewareStyle() {
    // Mutates the CURRENT async context and everything downstream — with no
    // exit point. There is no matching "leaveWith".
    legacy.enterWith("entered");
  }

  middlewareStyle();
  console.log("  after enterWith:", legacy.getStore());
  await sleep(1);
  console.log("  still set after await:", legacy.getStore());

  console.log(`
  Use run() unless you're adapting a callback-style middleware chain that
  gives you nowhere to wrap. enterWith can bleed context into unrelated work
  scheduled from the same async context — which is a data-leak bug when the
  store contains a user id.
`);
}

console.log("=== 8. ⚠ Pooled resources lose it ===");
{
  // A connection pool creates its sockets ONCE, at startup. Callbacks fired
  // by those sockets run in the POOL's context, not the request's.
  class FakePool extends EventEmitter {
    #handlers: Array<(row: string) => void> = [];
    readonly #timer: NodeJS.Timeout;
    constructor() {
      super();
      // Simulates the pool's own long-lived loop, created at startup —
      // OUTSIDE any request context. That's the whole point of the demo.
      this.#timer = setInterval(() => {
        const h = this.#handlers.shift();
        h?.("row");
      }, 5);
    }
    query(_sql: string, cb: (row: string) => void) {
      this.#handlers.push(cb);
    }
    close() {
      clearInterval(this.#timer);
    }
  }

  const pool = new FakePool();

  await context.run({ requestId: "req-pooled" }, async () => {
    await new Promise<void>((resolve) => {
      pool.query("SELECT 1", () => {
        log("pool callback, unbound");
        resolve();
      });
    });
  });

  await context.run({ requestId: "req-pooled-bound" }, async () => {
    await new Promise<void>((resolve) => {
      pool.query(
        "SELECT 1",
        AsyncResource.bind(() => {
          log("pool callback, bound");
          resolve();
        }),
      );
    });
  });

  pool.close();

  console.log(`
  Look at the two requestIds above. The UNBOUND callback ran in the POOL's
  context — the interval was created at startup, outside any request — so it
  lost the id. The BOUND one kept it.

  Real pools behave the same way: the socket, its parser, and its timers
  were all created before any request existed.

  Rule: bind at the boundary where you hand a callback to something you did
  not create during this request.
`);
}

console.log("=== 9. What to put in the store ===");
console.log(`
  ✓ requestId / traceId / spanId
  ✓ authenticated user id, tenant id, locale
  ✓ a request-scoped logger, already bound to those fields
  ✓ an AbortSignal for the request

  ✗ mutable accumulators — a downstream function mutating the store is
    action-at-a-distance, and impossible to follow
  ✗ database connections or transactions — make those explicit; an implicit
    ambient transaction is how you accidentally commit the wrong work
  ✗ anything you'd be upset to see leak between requests

  Treat the store as immutable request metadata. If you need to add
  something mid-request, start a nested run() with an extended object:

      await context.run({ ...context.getStore()!, userId }, next);
`);

console.log("=== 10. Wiring it up in a server ===");
console.log(`
  import { randomUUID } from "node:crypto";

  const context = new AsyncLocalStorage<Ctx>();

  server.on("request", (req, res) => {
    const requestId = req.headers["x-request-id"] ?? randomUUID();
    const ac = new AbortController();
    req.on("close", () => ac.abort());

    context.run({ requestId, signal: ac.signal }, () => {
      res.setHeader("x-request-id", requestId);
      handler(req, res).catch((err) => {
        logger.error({ err }, "unhandled");   // requestId comes from the store
        res.statusCode = 500;
        res.end();
      });
    });
  });

  export function getContext(): Ctx {
    const store = context.getStore();
    if (!store) throw new Error("no request context — called outside a request?");
    return store;
  }

  You build exactly this in the exercise.
`);

// Demonstrate the generated id shape used above.
console.log("  (a real requestId looks like:", randomUUID() + ")");
