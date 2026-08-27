/**
 *   node scripts/test.ts 11
 *   node scripts/test.ts --solutions 11
 */

import { describe, it, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";

import type { BuildOptions, Store } from "./exercise.ts";

const modulePath = process.env["IMPL"] === "solution" ? "./solution.ts" : "./exercise.ts";

type Impl = {
  createStore(): Store;
  buildApp(options?: BuildOptions): FastifyInstance;
};

let impl: Impl;
before(async () => {
  impl = (await import(modulePath)) as unknown as Impl;
});

let open: FastifyInstance[] = [];
/** A booted instance, ready to inject(). */
const build = async (options?: BuildOptions): Promise<FastifyInstance> => {
  const app = buildRaw(options);
  await app.ready();
  return app;
};

/**
 * An instance that has NOT booted yet. Needed whenever a test adds hooks or
 * routes — addHook/get/setErrorHandler all throw once the instance is
 * listening, and ready() counts as listening (06 §3).
 */
const buildRaw = (options?: BuildOptions): FastifyInstance => {
  const app = impl.buildApp(options);
  open.push(app);
  return app;
};
afterEach(async () => {
  const apps = open;
  open = [];
  await Promise.all(apps.map((a) => a.close().catch(() => {})));
});

const AUTH = { authorization: "Bearer secret" };

describe("createStore", () => {
  it("creates with sequential string ids", () => {
    const store = impl.createStore();
    assert.equal(store.create({ title: "a", body: "b", authorId: "x" }).id, "1");
    assert.equal(store.create({ title: "c", body: "d", authorId: "x" }).id, "2");
  });

  it("lists, gets and removes", () => {
    const store = impl.createStore();
    const note = store.create({ title: "a", body: "b", authorId: "x" });
    assert.equal(store.list().length, 1);
    assert.equal(store.get(note.id)?.title, "a");
    assert.equal(store.remove(note.id), true);
    assert.equal(store.remove(note.id), false);
    assert.equal(store.get(note.id), undefined);
  });

  it("sets internalScore", () => {
    const note = impl.createStore().create({ title: "hello", body: "b", authorId: "x" });
    assert.equal(note.internalScore, 5);
  });
});

describe("health", () => {
  it("returns ok WITHOUT auth", async () => {
    const app = await build();
    const res = await app.inject({ url: "/health" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { status: "ok" });
  });
});

describe("auth", () => {
  it("401s with no authorization header", async () => {
    const app = await build();
    const res = await app.inject({ url: "/notes" });
    assert.equal(res.statusCode, 401);
    assert.equal((res.json() as { code: string }).code, "UNAUTHORIZED");
  });

  it("401s with a non-Bearer header", async () => {
    const app = await build();
    const res = await app.inject({ url: "/notes", headers: { authorization: "Basic abc" } });
    assert.equal(res.statusCode, 401);
  });

  it("401s with the wrong token", async () => {
    const app = await build();
    const res = await app.inject({ url: "/notes", headers: { authorization: "Bearer wrong" } });
    assert.equal(res.statusCode, 401);
  });

  it("accepts a configured token", async () => {
    const app = await build({ token: "custom" });
    assert.equal((await app.inject({ url: "/notes", headers: { authorization: "Bearer custom" } })).statusCode, 200);
    assert.equal((await app.inject({ url: "/notes", headers: AUTH })).statusCode, 401);
  });

  it("protects every /notes route", async () => {
    const app = await build();
    for (const [method, url] of [
      ["GET", "/notes"],
      ["GET", "/notes/1"],
      ["POST", "/notes"],
      ["DELETE", "/notes/1"],
    ] as const) {
      const res = await app.inject({ method, url, payload: { title: "t", body: "b" } });
      assert.equal(res.statusCode, 401, `${method} ${url} should require auth`);
    }
  });

  it("runs in onRequest — the body is never read for a 401", async () => {
    const app = buildRaw();
    let bodyBytes = 0;
    // A preParsing hook only fires if the request got past onRequest.
    app.addHook("preParsing", async (_req, _reply, payload) => {
      payload.on("data", (c: Buffer) => (bodyBytes += c.length));
      return payload;
    });
    await app.ready();

    await app.inject({
      method: "POST",
      url: "/notes",
      payload: { title: "x".repeat(50_000), body: "y" },
    });
    assert.equal(bodyBytes, 0, "auth must be in onRequest, before the body is read");
  });
});

describe("GET /notes", () => {
  it("lists notes", async () => {
    const store = impl.createStore();
    store.create({ title: "one", body: "b", authorId: "a" });
    store.create({ title: "two", body: "b", authorId: "a" });
    const app = await build({ store });

    const res = await app.inject({ url: "/notes", headers: AUTH });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { items: Array<{ title: string }> };
    assert.deepEqual(body.items.map((n) => n.title), ["one", "two"]);
  });

  it("NEVER exposes internalScore", async () => {
    const store = impl.createStore();
    store.create({ title: "secret-scored", body: "b", authorId: "a" });
    const app = await build({ store });

    const res = await app.inject({ url: "/notes", headers: AUTH });
    assert.ok(!res.body.includes("internalScore"), "internalScore leaked — is there a response schema?");
  });

  it("coerces limit to a NUMBER and applies it", async () => {
    const store = impl.createStore();
    for (let i = 0; i < 5; i++) store.create({ title: `n${i}`, body: "b", authorId: "a" });
    const app = await build({ store });

    const res = await app.inject({ url: "/notes?limit=2", headers: AUTH });
    assert.equal((res.json() as { items: unknown[] }).items.length, 2);
  });

  it("defaults limit to 10", async () => {
    const store = impl.createStore();
    for (let i = 0; i < 15; i++) store.create({ title: `n${i}`, body: "b", authorId: "a" });
    const app = await build({ store });

    const res = await app.inject({ url: "/notes", headers: AUTH });
    assert.equal((res.json() as { items: unknown[] }).items.length, 10);
  });

  it("400s on an out-of-range limit", async () => {
    const app = await build();
    const res = await app.inject({ url: "/notes?limit=999", headers: AUTH });
    assert.equal(res.statusCode, 400);
    assert.equal((res.json() as { code: string }).code, "VALIDATION");
  });
});

describe("GET /notes/:id", () => {
  it("returns one note", async () => {
    const store = impl.createStore();
    const note = store.create({ title: "hello", body: "world", authorId: "ada" });
    const app = await build({ store });

    const res = await app.inject({ url: `/notes/${note.id}`, headers: AUTH });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { id: note.id, title: "hello", body: "world", authorId: "ada" });
  });

  it("strips internalScore even though the handler returns the whole note", async () => {
    const store = impl.createStore();
    const note = store.create({ title: "hello", body: "w", authorId: "a" });
    const app = await build({ store });

    const res = await app.inject({ url: `/notes/${note.id}`, headers: AUTH });
    assert.equal((res.json() as Record<string, unknown>)["internalScore"], undefined);
  });

  it("404s for a missing note", async () => {
    const app = await build();
    const res = await app.inject({ url: "/notes/999", headers: AUTH });
    assert.equal(res.statusCode, 404);
    assert.equal((res.json() as { code: string }).code, "NOT_FOUND");
  });
});

describe("POST /notes", () => {
  it("creates a note", async () => {
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: "/notes",
      headers: AUTH,
      payload: { title: "new", body: "content", authorId: "ada" },
    });
    assert.equal(res.statusCode, 201);
    assert.deepEqual(res.json(), { id: "1", title: "new", body: "content", authorId: "ada" });
  });

  it("defaults authorId", async () => {
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: "/notes",
      headers: AUTH,
      payload: { title: "new", body: "content" },
    });
    assert.equal((res.json() as { authorId: string }).authorId, "anonymous");
  });

  it("400s on a missing title", async () => {
    const app = await build();
    const res = await app.inject({ method: "POST", url: "/notes", headers: AUTH, payload: { body: "x" } });
    assert.equal(res.statusCode, 400);
    const body = res.json() as { code: string; details: Array<{ path: string; issue: string }> };
    assert.equal(body.code, "VALIDATION");
    assert.ok(Array.isArray(body.details) && body.details.length > 0, "details should list the failures");
  });

  it("400s on an empty title", async () => {
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: "/notes",
      headers: AUTH,
      payload: { title: "", body: "x" },
    });
    assert.equal(res.statusCode, 400);
  });

  it("400s on a too-long title", async () => {
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: "/notes",
      headers: AUTH,
      payload: { title: "x".repeat(101), body: "y" },
    });
    assert.equal(res.statusCode, 400);
  });

  it("STRIPS extra fields (mass-assignment defence)", async () => {
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: "/notes",
      headers: AUTH,
      payload: { title: "t", body: "b", id: "forged", internalScore: 9999, isAdmin: true },
    });
    assert.equal(res.statusCode, 201);
    const note = res.json() as Record<string, unknown>;
    assert.equal(note["id"], "1", "a client must not be able to set the id");
    assert.equal(note["isAdmin"], undefined);
    assert.equal(note["internalScore"], undefined);
  });

  it("does not leak Ajv wording in the message", async () => {
    const app = await build();
    const res = await app.inject({ method: "POST", url: "/notes", headers: AUTH, payload: {} });
    const body = res.json() as { message: string };
    assert.ok(
      !body.message.includes("must NOT have fewer than"),
      "map validation errors to your own shape rather than leaking schema-speak",
    );
  });
});

describe("DELETE /notes/:id", () => {
  it("deletes and returns 204 with no body", async () => {
    const store = impl.createStore();
    const note = store.create({ title: "t", body: "b", authorId: "a" });
    const app = await build({ store });

    const res = await app.inject({ method: "DELETE", url: `/notes/${note.id}`, headers: AUTH });
    assert.equal(res.statusCode, 204);
    assert.equal(res.body, "", "204 must carry no body");
    assert.equal(store.get(note.id), undefined);
  });

  it("404s for a missing note", async () => {
    const app = await build();
    const res = await app.inject({ method: "DELETE", url: "/notes/999", headers: AUTH });
    assert.equal(res.statusCode, 404);
  });
});

describe("error handling", () => {
  it("NEVER leaks an internal error message", async () => {
    const app = buildRaw();
    app.get("/boom", async () => {
      throw new Error("postgres://user:hunter2@db.internal");
    });
    await app.ready();

    const res = await app.inject({ url: "/boom" });
    assert.equal(res.statusCode, 500);
    assert.ok(!res.body.includes("hunter2"), "the default handler leaks — install setErrorHandler");
    assert.equal((res.json() as { code: string }).code, "INTERNAL");
  });

  it("logs the real error even though it is not sent", async () => {
    const logs: string[] = [];
    const app = buildRaw({ onLog: (l) => logs.push(l) });
    app.get("/boom", async () => {
      throw new Error("the real reason");
    });
    await app.ready();

    await app.inject({ url: "/boom" });
    assert.ok(logs.some((l) => l.includes("the real reason")), "errors must still be logged");
  });

  it("404s an unknown route with the app's error shape", async () => {
    const app = await build();
    const res = await app.inject({ url: "/no-such-route" });
    assert.equal(res.statusCode, 404);
    assert.equal((res.json() as { code: string }).code, "NOT_FOUND");
  });
});

describe("structure", () => {
  it("decorates the ROOT instance with the store", async () => {
    const store = impl.createStore();
    const app = await build({ store });
    assert.equal(
      (app as unknown as Record<string, unknown>)["store"],
      store,
      "app.store must be visible at the root — a plain plugin encapsulates it",
    );
  });

  it("returns an instance that is NOT listening", async () => {
    const app = buildRaw();
    assert.equal(app.server.listening, false, "buildApp must not listen — the caller decides");
    await app.ready();
  });

  it("supports several independent instances", async () => {
    const a = await build();
    const b = await build();
    await a.inject({ method: "POST", url: "/notes", headers: AUTH, payload: { title: "t", body: "b" } });
    const listB = await b.inject({ url: "/notes", headers: AUTH });
    assert.equal((listB.json() as { items: unknown[] }).items.length, 0, "instances must not share state");
  });
});
