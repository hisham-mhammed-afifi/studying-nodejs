/**
 *   node scripts/test.ts 09
 *   node scripts/test.ts --solutions 09
 */

import { describe, it, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { Agent, request } from "node:http";
import { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";

import {
  type ContentType,
  type GracefulServer,
  HttpError,
  type ParseJsonOptions,
  type ReadBodyOptions,
} from "./exercise.ts";

const modulePath = process.env["IMPL"] === "solution" ? "./solution.ts" : "./exercise.ts";

type Impl = {
  parseContentType(header: string | undefined): ContentType;
  readBody(req: IncomingMessage, options: ReadBodyOptions): Promise<Buffer>;
  parseJsonBody<T = unknown>(req: IncomingMessage, options: ParseJsonOptions): Promise<T | undefined>;
  sendJson(
    res: ServerResponse,
    status: number,
    body: unknown,
    headers?: Record<string, string | number>,
  ): boolean;
  createGracefulServer(handler: RequestListener): GracefulServer;
};

let impl: Impl;
before(async () => {
  impl = (await import(modulePath)) as unknown as Impl;
});

// Track servers so a failing test can't leave one listening.
let open: GracefulServer[] = [];
const serve = async (handler: RequestListener): Promise<GracefulServer> => {
  const app = impl.createGracefulServer(handler);
  open.push(app);
  await app.listen();
  return app;
};
afterEach(async () => {
  const apps = open;
  open = [];
  await Promise.all(apps.map((a) => a.shutdown({ graceMs: 100 }).catch(() => {})));
});

describe("parseContentType", () => {
  it("parses a bare mime type", () => {
    const ct = impl.parseContentType("application/json");
    assert.equal(ct.mime, "application/json");
    assert.equal(ct.charset, "utf-8");
    assert.deepEqual(ct.params, {});
  });

  it("lowercases the mime and the charset", () => {
    const ct = impl.parseContentType("Application/JSON; charset=UTF-8");
    assert.equal(ct.mime, "application/json");
    assert.equal(ct.charset, "utf-8");
  });

  it("handles a missing header", () => {
    const ct = impl.parseContentType(undefined);
    assert.equal(ct.mime, "");
    assert.equal(ct.charset, "utf-8");
  });

  it("keeps other parameters", () => {
    const ct = impl.parseContentType("multipart/form-data; boundary=--abc123");
    assert.equal(ct.mime, "multipart/form-data");
    assert.equal(ct.params["boundary"], "--abc123");
  });

  it("strips quotes from parameter values", () => {
    const ct = impl.parseContentType('multipart/form-data; boundary="--x--"');
    assert.equal(ct.params["boundary"], "--x--", "surrounding quotes should be removed");
  });

  it("tolerates whitespace and a trailing semicolon", () => {
    const ct = impl.parseContentType("  text/plain ;  charset = us-ascii ; ");
    assert.equal(ct.mime, "text/plain");
    assert.equal(ct.charset, "us-ascii");
  });

  it("lowercases parameter keys but not values", () => {
    const ct = impl.parseContentType("application/json; Boundary=AbC");
    assert.equal(ct.params["boundary"], "AbC");
  });
});

describe("readBody", () => {
  it("reads a body", async () => {
    const app = await serve(async (req, res) => {
      const body = await impl.readBody(req, { maxBytes: 1024 });
      impl.sendJson(res, 200, { text: body.toString("utf8"), bytes: body.length });
    });
    const res = await fetch(`http://127.0.0.1:${app.port}/`, { method: "POST", body: "hello" });
    assert.deepEqual(await res.json(), { text: "hello", bytes: 5 });
  });

  it("returns an empty Buffer for an empty body", async () => {
    const app = await serve(async (req, res) => {
      const body = await impl.readBody(req, { maxBytes: 1024 });
      impl.sendJson(res, 200, { bytes: body.length });
    });
    const res = await fetch(`http://127.0.0.1:${app.port}/`, { method: "POST" });
    assert.deepEqual(await res.json(), { bytes: 0 });
  });

  it("does not corrupt multi-byte characters", async () => {
    const app = await serve(async (req, res) => {
      const body = await impl.readBody(req, { maxBytes: 1024 });
      const text = body.toString("utf8");
      impl.sendJson(res, 200, { text, bytes: body.length, corrupted: text.includes("�") });
    });
    const res = await fetch(`http://127.0.0.1:${app.port}/`, { method: "POST", body: "héllo 😀 wörld" });
    const out = (await res.json()) as { text: string; bytes: number; corrupted: boolean };
    assert.equal(out.text, "héllo 😀 wörld");
    assert.equal(out.bytes, 18);
    assert.equal(out.corrupted, false);
  });

  it("rejects on content-length alone, WITHOUT consuming the body", async () => {
    // A fake request that records whether anything ever pulled from it.
    // (Attaching a real 'data' listener would itself start the flow, so this
    // has to be checked at the stream level, not in a handler.)
    let pulled = false;
    const fake = Object.assign(
      new Readable({
        read() {
          pulled = true;
          this.push(Buffer.alloc(500));
          this.push(null);
        },
      }),
      { headers: { "content-length": "500" } as Record<string, string> },
    ) as unknown as IncomingMessage;

    const err = await impl.readBody(fake, { maxBytes: 10 }).catch((e: unknown) => e);
    assert.ok(err instanceof HttpError);
    assert.equal(err.statusCode, 413);
    assert.equal(err.code, "PAYLOAD_TOO_LARGE");
    assert.equal(pulled, false, "should reject on content-length without reading a byte");
  });

  it("returns a 413 the CLIENT can see (not a socket error)", async () => {
    const app = await serve(async (req, res) => {
      const body = await impl.readBody(req, { maxBytes: 10 });
      impl.sendJson(res, 200, { bytes: body.length });
    });
    const res = await fetch(`http://127.0.0.1:${app.port}/`, { method: "POST", body: "x".repeat(500) });
    assert.equal(res.status, 413, "destroying the request would give the client a socket error instead");
    assert.equal(((await res.json()) as { code: string }).code, "PAYLOAD_TOO_LARGE");
  });

  it("counts real bytes when content-length LIES", async () => {
    const app = await serve(async (req, res) => {
      try {
        await impl.readBody(req, { maxBytes: 100 });
        impl.sendJson(res, 200, { ok: true });
      } catch (err) {
        res.setHeader("connection", "close");
        impl.sendJson(res, (err as HttpError).statusCode, { code: (err as HttpError).code });
        // req.socket can already be null if the peer went away first.
        res.on("finish", () => req.socket?.destroy());
      }
    });

    // Chunked encoding sends no content-length at all, so the only defence
    // is counting actual bytes.
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < 20; i++) c.enqueue(Buffer.from("x".repeat(50)));
        c.close();
      },
    });
    const res = await fetch(`http://127.0.0.1:${app.port}/`, {
      method: "POST",
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    assert.equal(res.status, 413);
  });

  it("allows a body exactly at the limit", async () => {
    const app = await serve(async (req, res) => {
      const body = await impl.readBody(req, { maxBytes: 5 });
      impl.sendJson(res, 200, { bytes: body.length });
    });
    const res = await fetch(`http://127.0.0.1:${app.port}/`, { method: "POST", body: "12345" });
    assert.equal(res.status, 200);
  });
});

describe("parseJsonBody", () => {
  const jsonServer = (options: Partial<ParseJsonOptions> = {}) =>
    serve(async (req, res) => {
      const parsed = await impl.parseJsonBody(req, { maxBytes: 1024, ...options });
      impl.sendJson(res, 200, { parsed: parsed ?? null });
    });

  it("parses a JSON body", async () => {
    const app = await jsonServer();
    const res = await fetch(`http://127.0.0.1:${app.port}/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "ada", n: 42 }),
    });
    assert.deepEqual(await res.json(), { parsed: { name: "ada", n: 42 } });
  });

  it("accepts a +json suffix type", async () => {
    const app = await jsonServer();
    const res = await fetch(`http://127.0.0.1:${app.port}/`, {
      method: "POST",
      headers: { "content-type": "application/ld+json" },
      body: JSON.stringify({ ok: true }),
    });
    assert.equal(res.status, 200);
  });

  it("415s on the wrong content-type", async () => {
    const app = await jsonServer();
    const res = await fetch(`http://127.0.0.1:${app.port}/`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    assert.equal(res.status, 415);
    assert.equal(((await res.json()) as { code: string }).code, "UNSUPPORTED_MEDIA_TYPE");
  });

  it("415s when content-type is absent", async () => {
    const app = await jsonServer();
    // An explicit empty content-type avoids fetch's automatic default.
    const res = await fetch(`http://127.0.0.1:${app.port}/`, {
      method: "POST",
      headers: { "content-type": "" },
      body: "{}",
    });
    assert.equal(res.status, 415);
  });

  it("400s on an empty body when required", async () => {
    const app = await jsonServer();
    const res = await fetch(`http://127.0.0.1:${app.port}/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { code: string }).code, "EMPTY_BODY");
  });

  it("returns undefined for an empty body when not required", async () => {
    const app = await jsonServer({ required: false });
    const res = await fetch(`http://127.0.0.1:${app.port}/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { parsed: null });
  });

  it("400s on malformed JSON, with a cause", async () => {
    let caught: unknown;
    const app = await serve(async (req, res) => {
      try {
        await impl.parseJsonBody(req, { maxBytes: 1024 });
      } catch (err) {
        caught = err;
        throw err;
      }
      impl.sendJson(res, 200, {});
    });
    const res = await fetch(`http://127.0.0.1:${app.port}/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json}",
    });
    assert.equal(res.status, 400);
    assert.equal((caught as HttpError).code, "INVALID_JSON");
    assert.ok((caught as HttpError).cause instanceof Error, "the parse error should be the cause");
  });

  it("propagates the 413 from readBody", async () => {
    const app = await jsonServer({ maxBytes: 10 });
    const res = await fetch(`http://127.0.0.1:${app.port}/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pad: "x".repeat(500) }),
    });
    assert.equal(res.status, 413);
  });
});

describe("sendJson", () => {
  it("sets status, content-type and a BYTE content-length", async () => {
    const app = await serve((_req, res) => {
      impl.sendJson(res, 201, { msg: "héllo" });
    });
    const res = await fetch(`http://127.0.0.1:${app.port}/`);
    assert.equal(res.status, 201);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    const body = JSON.stringify({ msg: "héllo" });
    assert.equal(
      res.headers.get("content-length"),
      String(Buffer.byteLength(body)),
      "content-length must be BYTES — 'héllo' is 5 chars but 6 bytes",
    );
    assert.deepEqual(await res.json(), { msg: "héllo" });
  });

  it("does not truncate multi-byte responses", async () => {
    const payload = { text: "日本語 😀 café" };
    const app = await serve((_req, res) => impl.sendJson(res, 200, payload));
    const res = await fetch(`http://127.0.0.1:${app.port}/`);
    assert.deepEqual(await res.json(), payload, "response was truncated — byteLength bug?");
  });

  it("merges extra headers", async () => {
    const app = await serve((_req, res) => {
      impl.sendJson(res, 200, {}, { "X-Request-Id": "abc", "x-count": 7 });
    });
    const res = await fetch(`http://127.0.0.1:${app.port}/`);
    assert.equal(res.headers.get("x-request-id"), "abc");
    assert.equal(res.headers.get("x-count"), "7");
  });

  it("returns true when it writes and false when it is a no-op", async () => {
    let results: boolean[] = [];
    const app = await serve((_req, res) => {
      results = [impl.sendJson(res, 200, { first: true }), impl.sendJson(res, 500, { second: true })];
    });
    const res = await fetch(`http://127.0.0.1:${app.port}/`);
    assert.deepEqual(await res.json(), { first: true }, "the second call should not have written");
    assert.deepEqual(results, [true, false]);
  });

  it("a double send does not crash the process", async () => {
    // A second end() emits 'error' on res; unhandled, that kills the server.
    const app = await serve((_req, res) => {
      impl.sendJson(res, 200, { ok: true });
      impl.sendJson(res, 200, { ok: true });
      impl.sendJson(res, 500, { boom: true });
    });
    assert.equal((await fetch(`http://127.0.0.1:${app.port}/`)).status, 200);
    // Still alive?
    assert.equal((await fetch(`http://127.0.0.1:${app.port}/`)).status, 200);
  });

  it("sends no body for 204", async () => {
    const app = await serve((_req, res) => impl.sendJson(res, 204, { ignored: true }));
    const res = await fetch(`http://127.0.0.1:${app.port}/`);
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("content-length"), null);
    assert.equal(await res.text(), "");
  });
});

describe("createGracefulServer", () => {
  it("serves a handler", async () => {
    const app = await serve((_req, res) => impl.sendJson(res, 200, { ok: true }));
    assert.deepEqual(await (await fetch(`http://127.0.0.1:${app.port}/`)).json(), { ok: true });
  });

  it("turns an HttpError into its status and code", async () => {
    const app = await serve(() => {
      throw new HttpError(404, "NOT_FOUND", "user 42 not found");
    });
    const res = await fetch(`http://127.0.0.1:${app.port}/`);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { code: "NOT_FOUND", message: "user 42 not found" });
  });

  it("catches an ASYNC rejection (createServer does not await you)", async () => {
    const app = await serve(async () => {
      await sleep(5);
      throw new HttpError(422, "UNPROCESSABLE", "bad input");
    });
    assert.equal((await fetch(`http://127.0.0.1:${app.port}/`)).status, 422);
  });

  it("turns an unknown error into an opaque 500", async () => {
    const app = await serve(() => {
      throw new Error("connection string is postgres://user:hunter2@db");
    });
    const res = await fetch(`http://127.0.0.1:${app.port}/`);
    assert.equal(res.status, 500);
    const text = await res.text();
    assert.ok(!text.includes("hunter2"), "internal error message leaked to the client");
    assert.equal((JSON.parse(text) as { code: string }).code, "INTERNAL");
  });

  it("survives an error thrown after headers were sent", async () => {
    const app = await serve((_req, res) => {
      res.statusCode = 200;
      res.write("partial");
      throw new Error("too late");
    });
    await fetch(`http://127.0.0.1:${app.port}/`).catch(() => "connection destroyed");
    // The server must still be alive.
    const app2 = await serve((_req, res) => impl.sendJson(res, 200, { alive: true }));
    assert.equal((await fetch(`http://127.0.0.1:${app2.port}/`)).status, 200);
  });

  it("reports healthy, then unhealthy from the start of shutdown", async () => {
    const app = await serve((_req, res) => impl.sendJson(res, 200, {}));
    assert.equal(app.healthy, true);
    const closing = app.shutdown({ graceMs: 500 });
    assert.equal(app.healthy, false, "health must flip BEFORE the server closes");
    await closing;
  });

  it("rejects new connections after shutdown", async () => {
    const app = await serve((_req, res) => impl.sendJson(res, 200, {}));
    const port = app.port;
    await app.shutdown({ graceMs: 500 });
    await assert.rejects(() => fetch(`http://127.0.0.1:${port}/`));
  });

  it("lets an in-flight request FINISH", async () => {
    const app = await serve(async (_req, res) => {
      await sleep(150);
      impl.sendJson(res, 200, { finished: true });
    });
    const pending = fetch(`http://127.0.0.1:${app.port}/`);
    await sleep(30);
    await app.shutdown({ graceMs: 2_000 });
    const res = await pending;
    assert.deepEqual(await res.json(), { finished: true }, "shutdown killed an in-flight request");
  });

  it("does NOT wait out keepAliveTimeout (the repeated-sweep lesson)", async () => {
    const app = await serve(async (_req, res) => {
      await sleep(100);
      impl.sendJson(res, 200, { ok: true });
    });
    app.server.keepAliveTimeout = 5_000; // the default

    // A keep-alive agent, so the socket lingers after the response.
    const agent = new Agent({ keepAlive: true });
    await new Promise<void>((resolve, reject) => {
      const req = request({ port: app.port, host: "127.0.0.1", path: "/", agent }, (res) => {
        res.resume();
        res.on("end", () => resolve());
      });
      req.on("error", reject);
      req.end();
    });

    const t0 = Date.now();
    await app.shutdown({ graceMs: 5_000 });
    const elapsed = Date.now() - t0;
    agent.destroy();

    assert.ok(
      elapsed < 1_500,
      `shutdown took ${elapsed}ms — it waited out keepAliveTimeout. Sweep closeIdleConnections() repeatedly.`,
    );
  });

  it("is idempotent", async () => {
    const app = await serve((_req, res) => impl.sendJson(res, 200, {}));
    await Promise.all([app.shutdown({ graceMs: 200 }), app.shutdown({ graceMs: 200 })]);
    await app.shutdown({ graceMs: 200 });
  });

  it("forces closure after graceMs", async () => {
    const app = await serve(async (_req, res) => {
      await sleep(10_000); // never finishes in time
      impl.sendJson(res, 200, {});
    });
    const pending = fetch(`http://127.0.0.1:${app.port}/`).catch(() => "killed");
    await sleep(30);

    const t0 = Date.now();
    await app.shutdown({ graceMs: 200 });
    const elapsed = Date.now() - t0;
    await pending;

    assert.ok(elapsed < 1_500, `shutdown took ${elapsed}ms — the graceMs deadline did not fire`);
  });
});
