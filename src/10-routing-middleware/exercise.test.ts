/**
 *   node scripts/test.ts 10
 *   node scripts/test.ts --solutions 10
 */

import { describe, it, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

import {
  type Application,
  type Context,
  HttpError,
  type MatchResult,
  type Middleware,
} from "./exercise.ts";

const modulePath = process.env["IMPL"] === "solution" ? "./solution.ts" : "./exercise.ts";

interface RouterLike {
  add(method: string, pattern: string, handler: Middleware): RouterLike;
  get(pattern: string, handler: Middleware): RouterLike;
  post(pattern: string, handler: Middleware): RouterLike;
  match(method: string, pathname: string): MatchResult;
  routes(): Middleware;
}

type Impl = {
  compose(middleware: readonly Middleware[]): (ctx: Context) => Promise<void>;
  Router: new () => RouterLike;
  createApp(): Application;
};

let impl: Impl;
before(async () => {
  impl = (await import(modulePath)) as unknown as Impl;
});

let open: Application[] = [];
const serve = async (configure: (app: Application) => void): Promise<Application> => {
  const app = impl.createApp();
  open.push(app);
  configure(app);
  await app.listen();
  return app;
};
afterEach(async () => {
  const apps = open;
  open = [];
  await Promise.all(apps.map((a) => a.close().catch(() => {})));
});

/** A context with no real socket, for unit-testing the chain. */
function fakeContext(method = "GET", path = "/"): Context {
  return {
    req: {} as IncomingMessage,
    res: {} as ServerResponse,
    method,
    path,
    query: new URLSearchParams(),
    params: {},
    status: 404,
    body: null,
    state: {},
  };
}

const tag =
  (name: string, trace: string[]): Middleware =>
  async (_ctx, next) => {
    trace.push(`${name}→`);
    await next();
    trace.push(`←${name}`);
  };

describe("compose", () => {
  it("runs middleware in order, onion-style", async () => {
    const trace: string[] = [];
    await impl.compose([
      tag("a", trace),
      tag("b", trace),
      async () => void trace.push("handler"),
    ])(fakeContext());
    assert.deepEqual(trace, ["a→", "b→", "handler", "←b", "←a"]);
  });

  it("resolves for an empty chain", async () => {
    await impl.compose([])(fakeContext());
  });

  it("next() from the last middleware is a no-op", async () => {
    let reached = false;
    await impl.compose([
      async (_ctx, next) => {
        await next();
        reached = true;
      },
    ])(fakeContext());
    assert.equal(reached, true);
  });

  it("propagates an async rejection", async () => {
    await assert.rejects(
      () => impl.compose([async () => { throw new Error("async boom"); }])(fakeContext()),
      /async boom/,
    );
  });

  it("turns a SYNCHRONOUS throw into a rejection", async () => {
    // A naive `return fn(ctx, next)` lets this escape the promise chain.
    await assert.rejects(
      () =>
        impl.compose([
          (): void => {
            throw new Error("sync boom");
          },
        ])(fakeContext()),
      /sync boom/,
    );
  });

  it("lets an upstream middleware catch a downstream error", async () => {
    const ctx = fakeContext();
    await impl.compose([
      async (c, next) => {
        try {
          await next();
        } catch {
          c.status = 500;
        }
      },
      async () => {
        throw new Error("deep");
      },
    ])(ctx);
    assert.equal(ctx.status, 500);
  });

  it("skips the rest when a middleware does not call next()", async () => {
    const trace: string[] = [];
    await impl.compose([
      async (c) => {
        trace.push("guard");
        c.status = 401;
      },
      async () => void trace.push("handler"),
    ])(fakeContext());
    assert.deepEqual(trace, ["guard"]);
  });

  it("rejects when next() is called twice", async () => {
    let handlerRuns = 0;
    await assert.rejects(
      () =>
        impl.compose([
          async (_c, next) => {
            await next();
            await next();
          },
          async () => void handlerRuns++,
        ])(fakeContext()),
      /multiple times/,
    );
    assert.equal(handlerRuns, 1, "downstream must not run twice");
  });

  it("still runs the 'after' half in reverse on success", async () => {
    const trace: string[] = [];
    await impl.compose([tag("outer", trace), tag("inner", trace)])(fakeContext());
    assert.deepEqual(trace, ["outer→", "inner→", "←inner", "←outer"]);
  });
});

describe("Router — matching", () => {
  const noop: Middleware = async () => {};

  it("matches a static route", () => {
    const r = new impl.Router();
    r.get("/users", noop);
    const m = r.match("GET", "/users");
    assert.ok(m.handler);
    assert.equal(m.route, "/users");
    assert.deepEqual(m.params, {});
  });

  it("captures a parameter", () => {
    const r = new impl.Router();
    r.get("/users/:id", noop);
    assert.deepEqual(r.match("GET", "/users/42").params, { id: "42" });
  });

  it("captures several parameters", () => {
    const r = new impl.Router();
    r.get("/users/:id/posts/:postId", noop);
    assert.deepEqual(r.match("GET", "/users/7/posts/9").params, { id: "7", postId: "9" });
  });

  it("reports the PATTERN as route, not the path", () => {
    const r = new impl.Router();
    r.get("/users/:id", noop);
    assert.equal(r.match("GET", "/users/42").route, "/users/:id", "metrics need the pattern");
  });

  it("prefers static over param REGARDLESS of registration order", () => {
    const paramFirst = new impl.Router();
    paramFirst.get("/users/:id", async (c) => void (c.body = "param"));
    paramFirst.get("/users/me", async (c) => void (c.body = "static"));

    const staticFirst = new impl.Router();
    staticFirst.get("/users/me", async (c) => void (c.body = "static"));
    staticFirst.get("/users/:id", async (c) => void (c.body = "param"));

    for (const [label, r] of [["param first", paramFirst], ["static first", staticFirst]] as const) {
      assert.equal(r.match("GET", "/users/me").route, "/users/me", `${label}: static must win`);
      assert.equal(r.match("GET", "/users/42").route, "/users/:id", `${label}: param for others`);
    }
  });

  it("prefers a param over a wildcard", () => {
    const r = new impl.Router();
    r.get("/files/*path", noop);
    r.get("/files/:name", noop);
    assert.equal(r.match("GET", "/files/a.txt").route, "/files/:name");
  });

  it("captures the rest of the path in a wildcard", () => {
    const r = new impl.Router();
    r.get("/files/*path", noop);
    assert.deepEqual(r.match("GET", "/files/a/b/c.txt").params, { path: "a/b/c.txt" });
  });

  it("ignores a trailing slash", () => {
    const r = new impl.Router();
    r.get("/users", noop);
    assert.ok(r.match("GET", "/users/").handler);
  });

  it("uppercases the method", () => {
    const r = new impl.Router();
    r.add("get", "/x", noop);
    assert.ok(r.match("GET", "/x").handler);
    assert.ok(r.match("get", "/x").handler);
  });

  it("DECODES parameters", () => {
    const r = new impl.Router();
    r.get("/users/:name", noop);
    assert.deepEqual(r.match("GET", "/users/" + encodeURIComponent("ada l")).params, { name: "ada l" });
  });

  it("splits BEFORE decoding, so %2F cannot forge a separator", () => {
    const r = new impl.Router();
    r.get("/users/:name", noop);
    // "a%2Fb" is ONE segment containing a slash — not two segments.
    const m = r.match("GET", "/users/" + encodeURIComponent("a/b"));
    assert.ok(m.handler, "should still match a single-param route");
    assert.deepEqual(m.params, { name: "a/b" });
  });

  it("throws a 400 HttpError on malformed percent-encoding", () => {
    const r = new impl.Router();
    r.get("/users/:id", noop);
    assert.throws(
      () => r.match("GET", "/users/%E0%A4%A"),
      (err: unknown) => err instanceof HttpError && err.statusCode === 400,
    );
  });
});

describe("Router — 404 vs 405", () => {
  const noop: Middleware = async () => {};

  it("reports matchedPath false for an unknown path", () => {
    const r = new impl.Router();
    r.get("/users", noop);
    const m = r.match("GET", "/nope");
    assert.equal(m.matchedPath, false);
    assert.equal(m.handler, undefined);
    assert.deepEqual(m.allowed, []);
  });

  it("reports matchedPath true with allowed methods for a wrong verb", () => {
    const r = new impl.Router();
    r.get("/users/:id", noop);
    r.add("DELETE", "/users/:id", noop);
    const m = r.match("PUT", "/users/42");
    assert.equal(m.matchedPath, true);
    assert.equal(m.handler, undefined);
    assert.deepEqual(m.allowed, ["DELETE", "GET"], "allowed should be sorted");
  });
});

describe("Router — as middleware", () => {
  it("sets params and route, then runs the handler", async () => {
    const r = new impl.Router();
    r.get("/users/:id", async (c) => {
      c.status = 200;
      c.body = { id: c.params["id"], route: c.route };
    });
    const ctx = fakeContext("GET", "/users/42");
    await impl.compose([r.routes()])(ctx);
    assert.equal(ctx.status, 200);
    assert.deepEqual(ctx.body, { id: "42", route: "/users/:id" });
  });

  it("calls next() when nothing matched", async () => {
    const r = new impl.Router();
    r.get("/users", async () => {});
    let fellThrough = false;
    await impl.compose([r.routes(), async () => void (fellThrough = true)])(
      fakeContext("GET", "/nope"),
    );
    assert.equal(fellThrough, true, "an unmatched route must fall through, not swallow");
  });

  it("throws a 405 when the path matched but the method did not", async () => {
    const r = new impl.Router();
    r.get("/users/:id", async () => {});
    await assert.rejects(
      () => impl.compose([r.routes()])(fakeContext("PUT", "/users/42")),
      (err: unknown) => err instanceof HttpError && err.statusCode === 405,
    );
  });
});

describe("createApp", () => {
  const get = async (app: Application, path = "/", init?: RequestInit) =>
    fetch(`http://127.0.0.1:${app.port}${path}`, init);

  it("serves a route", async () => {
    const app = await serve((a) => {
      const r = new impl.Router();
      r.get("/hello", async (c) => {
        c.status = 200;
        c.body = { msg: "hi" };
      });
      a.use(r.routes());
    });
    const res = await get(app, "/hello");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { msg: "hi" });
  });

  it("404s an unmatched path", async () => {
    const app = await serve((a) => a.use(new impl.Router().routes()));
    const res = await get(app, "/nope");
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { code: "NOT_FOUND" });
  });

  it("405s a wrong method", async () => {
    const app = await serve((a) => {
      const r = new impl.Router();
      r.get("/users/:id", async (c) => void (c.status = 200));
      a.use(r.routes());
    });
    const res = await get(app, "/users/42", { method: "PUT" });
    assert.equal(res.status, 405);
    assert.equal(((await res.json()) as { code: string }).code, "METHOD_NOT_ALLOWED");
  });

  it("parses path and query into the context", async () => {
    const app = await serve((a) =>
      a.use(async (c) => {
        c.status = 200;
        c.body = { path: c.path, page: c.query.get("page") };
      }),
    );
    const res = await get(app, "/things?page=2");
    assert.deepEqual(await res.json(), { path: "/things", page: "2" });
  });

  it("sets a BYTE content-length", async () => {
    const payload = { msg: "héllo 😀" };
    const app = await serve((a) =>
      a.use(async (c) => {
        c.status = 200;
        c.body = payload;
      }),
    );
    const res = await get(app);
    assert.equal(res.headers.get("content-length"), String(Buffer.byteLength(JSON.stringify(payload))));
    assert.deepEqual(await res.json(), payload, "response was truncated — byteLength bug?");
  });

  it("runs middleware in registration order", async () => {
    const trace: string[] = [];
    const app = await serve((a) => {
      a.use(tag("first", trace));
      a.use(tag("second", trace));
      a.use(async (c) => {
        trace.push("handler");
        c.status = 200;
      });
    });
    await get(app);
    assert.deepEqual(trace, ["first→", "second→", "handler", "←second", "←first"]);
  });

  it("turns an HttpError into its status", async () => {
    const app = await serve((a) =>
      a.use(async () => {
        throw new HttpError(422, "UNPROCESSABLE", "bad input");
      }),
    );
    const res = await get(app);
    assert.equal(res.status, 422);
    assert.deepEqual(await res.json(), { code: "UNPROCESSABLE", message: "bad input" });
  });

  it("never leaks an internal error message", async () => {
    const app = await serve((a) =>
      a.use(async () => {
        throw new Error("postgres://user:hunter2@db.internal");
      }),
    );
    const res = await get(app);
    assert.equal(res.status, 500);
    const text = await res.text();
    assert.ok(!text.includes("hunter2"), "internal message leaked to the client");
    assert.equal((JSON.parse(text) as { code: string }).code, "INTERNAL");
  });

  it("catches an ASYNC rejection without crashing", async () => {
    const app = await serve((a) =>
      a.use(async () => {
        await sleep(5);
        throw new Error("async failure");
      }),
    );
    assert.equal((await get(app)).status, 500);
    // Still alive?
    assert.equal((await get(app)).status, 500);
  });

  it("lets an error boundary above the router handle things", async () => {
    const app = await serve((a) => {
      a.use(async (c, next) => {
        try {
          await next();
        } catch (err) {
          c.status = err instanceof HttpError ? err.statusCode : 500;
          c.body = { handled: true };
        }
      });
      const r = new impl.Router();
      r.get("/boom", async () => {
        throw new HttpError(418, "TEAPOT", "no coffee");
      });
      a.use(r.routes());
    });
    const res = await get(app, "/boom");
    assert.equal(res.status, 418);
    assert.deepEqual(await res.json(), { handled: true });
  });

  it("handle() runs the chain without a socket", async () => {
    const app = impl.createApp();
    app.use(async (c) => {
      c.status = 200;
      c.body = { unit: true };
    });
    const ctx = fakeContext("GET", "/x");
    await app.handle(ctx);
    assert.equal(ctx.status, 200);
    assert.deepEqual(ctx.body, { unit: true });
  });

  it("picks up middleware added after an earlier request", async () => {
    const app = await serve(() => {});
    assert.equal((await get(app)).status, 404);
    app.use(async (c) => {
      c.status = 200;
      c.body = { added: true };
    });
    assert.equal((await get(app)).status, 200);
  });
});
