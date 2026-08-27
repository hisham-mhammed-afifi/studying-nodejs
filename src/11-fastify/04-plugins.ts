/**
 * 04 — Plugin encapsulation: the best idea in the framework
 *
 * Run:  node src/11-fastify/04-plugins.ts
 */

import Fastify, { type FastifyInstance } from "fastify";

console.log("=== 1. A plugin gets its own scope ===");
{
  const app = Fastify({ logger: false });

  app.decorate("config", { env: "test" });

  await app.register(async (child: FastifyInstance) => {
    child.decorate("db", { name: "fake-db" });

    child.get("/inside", async () => ({
      // Inherited from the parent…
      config: (child as unknown as Record<string, unknown>)["config"] ?? null,
      // …and its own.
      db: (child as unknown as Record<string, unknown>)["db"] ?? null,
    }));
  });

  app.get("/outside", async () => ({
    config: (app as unknown as Record<string, unknown>)["config"] ?? null,
    db: (app as unknown as Record<string, unknown>)["db"] ?? null,
  }));

  await app.ready();
  console.log("  inside the plugin: ", (await app.inject({ url: "/inside" })).body);
  console.log("  outside it:        ", (await app.inject({ url: "/outside" })).body);
  await app.close();

  console.log(`
  Scope flows DOWN, never up. A plugin sees everything its parent has, and
  the parent sees nothing the plugin added.

  Compare module 10, where app.use() is global: every middleware applies to
  everything registered after it, forever, and the only control you have is
  ordering. Encapsulation makes "this applies here and nowhere else" a
  structural property rather than a convention.
`);
}

console.log("=== 2. Hooks are scoped too — which is the useful part ===");
{
  const app = Fastify({ logger: false });

  // A public route, registered at the root.
  app.get("/health", async () => ({ ok: true }));

  await app.register(
    async (api: FastifyInstance) => {
      // This hook applies ONLY inside this plugin.
      api.addHook("onRequest", async (req, reply) => {
        if (req.headers["authorization"] !== "Bearer good") {
          return reply.status(401).send({ code: "UNAUTHORIZED" });
        }
      });

      api.get("/me", async () => ({ user: "ada" }));
      api.get("/things", async () => ({ items: [] }));
    },
    { prefix: "/api" },
  );

  await app.ready();

  const cases: Array<[string, string, Record<string, string>]> = [
    ["GET /health (no auth)", "/health", {}],
    ["GET /api/me (no auth)", "/api/me", {}],
    ["GET /api/me (good auth)", "/api/me", { authorization: "Bearer good" }],
  ];
  for (const [label, url, headers] of cases) {
    const res = await app.inject({ url, headers });
    console.log(`  ${label.padEnd(26)} → ${res.statusCode} ${res.body}`);
  }
  await app.close();

  console.log(`
  /health was never touched by the auth hook, and nobody had to remember to
  exclude it. In module 10's model this needed either a conditional
  middleware ("skip if path starts with /health") or two separate chains —
  and the exclusion list is exactly the thing that rots.

  The prefix option is free routing: every route inside got /api prepended.
`);
}

console.log("=== 3. fastify-plugin: opting OUT of encapsulation ===");
{
  const app = Fastify({ logger: false });

  // A plugin that decorates, WITHOUT fastify-plugin: the decoration is
  // trapped in its own scope and the parent can't see it.
  await app.register(async (child: FastifyInstance) => {
    child.decorate("encapsulated", "trapped");
  });

  // The same thing, marked as non-encapsulating. This is what
  // fastify-plugin does — it sets a symbol that tells Fastify to run the
  // plugin in the PARENT's scope instead of a child scope.
  const asShared = async (parent: FastifyInstance) => {
    parent.decorate("shared", "visible to the parent");
  };
  (asShared as unknown as Record<symbol, unknown>)[Symbol.for("skip-override")] = true;
  await app.register(asShared);

  await app.ready();
  const a = app as unknown as Record<string, unknown>;
  console.log("  plain plugin's decorator:      ", a["encapsulated"] ?? "(not visible) ✓");
  console.log("  skip-override plugin's:        ", a["shared"] ?? "(not visible)");
  await app.close();

  console.log(`
  In real code you'd write:

      import fp from "fastify-plugin";
      export default fp(async (app) => { app.decorate("db", pool); });

  The rule of thumb:

    ENCAPSULATE (plain plugin)     a feature area: routes + its own hooks,
                                   auth for one section, a versioned API
    SHARE (fastify-plugin)         infrastructure everyone needs: the
                                   database, a cache client, auth helpers

  Getting this backwards is the #1 Fastify confusion: "I decorated the app
  with my db and it's undefined in my routes" is always a missing fp().
`);
}

console.log("=== 4. ⚠ register() queues — unless you await it ===");
{
  // Without await: register() only QUEUES the plugin.
  const queued = Fastify({ logger: false });
  const orderA: string[] = [];
  void queued.register(async () => void orderA.push("plugin A"));
  void queued.register(async () => void orderA.push("plugin B"));
  orderA.push("after both register() calls");
  await queued.ready(); // ← they boot HERE
  orderA.push("after ready()");
  console.log("  without await:", orderA.join(" → "));
  await queued.close();

  // With await: it boots immediately, before the next line runs.
  const awaited = Fastify({ logger: false });
  const orderB: string[] = [];
  await awaited.register(async () => void orderB.push("plugin A"));
  orderB.push("after awaited register()");
  await awaited.ready();
  console.log("  with await:   ", orderB.join(" → "));
  await awaited.close();

  console.log(`
  I expected register() to always defer until ready(). It does NOT: awaiting
  it boots the plugin then and there.

    register(fn)         queues; the plugin runs when ready()/listen() does
    await register(fn)   boots it immediately, before your next statement

  That matters for ordering. If plugin B needs a decorator from plugin A:

      await app.register(dbPlugin);      // ✓ app.db exists after this line
      await app.register(usersRoutes);   //   and usersRoutes can use it

  Both forms preserve registration order, so the non-awaited version works
  too — but only the awaited one lets you TOUCH the result in between.

  Either way you must await ready() (or listen()) before inject(), or the
  queued plugins have not run at all.
`);
}

console.log("=== 5. What a real plugin looks like ===");
console.log(`
  // plugins/db.ts — infrastructure, so SHARED
  import fp from "fastify-plugin";

  export default fp(async (app) => {
    const pool = createPool(app.config.databaseUrl);
    app.decorate("db", pool);

    // Cleanup belongs with the thing that created it.
    app.addHook("onClose", async () => { await pool.end(); });
  });

  // routes/users.ts — a feature area, so ENCAPSULATED
  export default async function users(app) {
    app.addHook("preHandler", app.authenticate);   // only these routes

    app.get("/:id", { schema: { response: { 200: userSchema } } }, async (req) => {
      return app.db.users.findById(req.params.id);
    });
  }

  // app.ts
  await app.register(dbPlugin);                       // shared
  await app.register(users, { prefix: "/users" });    // encapsulated

  Note the onClose hook: a plugin owns its resource's whole lifecycle, so
  graceful shutdown (module 09 §7) composes automatically — app.close()
  unwinds every plugin in reverse order.
`);
