/**
 * 15.4 — Testing a server for real.
 *
 *   node src/15-testing-deploy/04-testing-servers.ts
 *
 * Everything from modules 09-14, under test. The theme: use real sockets
 * and a real database, and make the fixtures cheap enough that you can.
 */

import { comments, resultLines, runTestFile, verdict } from "./_helpers.ts";

// ─────────────────────────────────────────────────────────────────────────────
// 1. Port 0
// ─────────────────────────────────────────────────────────────────────────────

console.log("=== 1. Never hard-code a port ===");

const ports = runTestFile(
  "ports.test.ts",
  `
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";

test("port 0 means 'the OS picks a free one'", async () => {
  const servers = await Promise.all(
    Array.from({ length: 5 }, async () => {
      const s = createServer();
      s.listen(0);
      await once(s, "listening");
      return s;
    }),
  );
  const assigned = servers.map((s) => (s.address() as { port: number }).port);
  console.log("assigned ports:", assigned.join(", "));
  assert.equal(new Set(assigned).size, 5, "all distinct");
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
});
`,
);
console.log(`  ${comments(ports.stdout).find((c) => c.startsWith("assigned")) ?? ""}`);
console.log(`  ${verdict(ports)}`);
console.log(`
  Test files run as PARALLEL PROCESSES (01-runner.ts §1). Two files that
  both listen on 3000 produce EADDRINUSE in whichever loses the race — and
  it is a different one each run, which is the definition of a flaky test.

  listen(0) asks the OS for a free port; read it back from
  server.address(). Never a constant, never an environment variable with
  a default, and never a "find a free port" helper that races between the
  check and the bind.
`);

// ─────────────────────────────────────────────────────────────────────────────
// 2. A fixture that starts and stops the whole thing
// ─────────────────────────────────────────────────────────────────────────────

console.log("=== 2. before/after as the app lifecycle ===");

const fixture = runTestFile(
  "fixture.test.ts",
  `
import { test, before, after, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";

let db: DatabaseSync;
let server: Server;
let base: string;

before(async () => {
  // The real database — in memory, so it costs microseconds (module 13).
  db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");

  server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "GET" && req.url === "/notes") {
      const rows = db.prepare("SELECT * FROM notes ORDER BY id").all();
      res.end(JSON.stringify(rows));
      return;
    }
    if (req.method === "POST" && req.url === "/notes") {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        try {
          const { body: text } = JSON.parse(body) as { body?: unknown };
          if (typeof text !== "string" || text === "") {
            res.statusCode = 400;
            res.end(JSON.stringify({ code: "INVALID_BODY" }));
            return;
          }
          const row = db.prepare("INSERT INTO notes (body) VALUES (?) RETURNING *").get(text);
          res.statusCode = 201;
          res.end(JSON.stringify(row));
        } catch {
          res.statusCode = 400;
          res.end(JSON.stringify({ code: "INVALID_JSON" }));
        }
      });
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ code: "NOT_FOUND" }));
  });

  server.listen(0);
  await once(server, "listening");
  base = "http://127.0.0.1:" + (server.address() as { port: number }).port;
});

// Close EVERYTHING, or the file hangs (03-lies.ts §4).
after(async () => {
  await new Promise((r) => server.close(r));
  db.close();
});

// A clean slate per test, without rebuilding the schema.
beforeEach(() => db.exec("DELETE FROM notes"));

describe("POST /notes", () => {
  test("creates a note", async () => {
    const res = await fetch(base + "/notes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "hello" }),
    });
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { id: 1, body: "hello" });
  });

  test("rejects an empty body", async () => {
    const res = await fetch(base + "/notes", { method: "POST", body: JSON.stringify({ body: "" }) });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { code: "INVALID_BODY" });
  });

  test("rejects malformed JSON", async () => {
    const res = await fetch(base + "/notes", { method: "POST", body: "{not json" });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { code: "INVALID_JSON" });
  });

  test("each test starts empty — beforeEach really ran", async () => {
    const res = await fetch(base + "/notes");
    assert.deepEqual(await res.json(), []);
  });
});

test("404 for an unknown route", async () => {
  const res = await fetch(base + "/nope");
  assert.equal(res.status, 404);
});
`,
);
for (const line of resultLines(fixture.stdout)) console.log(`  ${line}`);
console.log(`  ${verdict(fixture)}  in ${fixture.ms}ms`);
console.log(`
  Nine assertions across a real socket and a real database, start to
  finish, in the time it takes to read this sentence. That is the argument
  against mocking the layer below (02-mocking.ts §4): it isn't faster.

  The shape to copy:
    before      build the world — schema, server, listen(0)
    beforeEach  reset the DATA, not the schema. DELETE, not DROP.
    after       close the server AND the database, or the file hangs
    fetch       Node has it built in; no supertest, no axios

  Note what is NOT here: no test asserts on an internal function. Every
  one goes through the HTTP boundary, which is the contract that actually
  ships. Refactor the handler freely; these tests keep their meaning.
`);

// ─────────────────────────────────────────────────────────────────────────────
// 3. The cases only a real socket can reach
// ─────────────────────────────────────────────────────────────────────────────

console.log("=== 3. What a real socket buys you ===");

const socket = runTestFile(
  "socket.test.ts",
  `
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { once } from "node:events";

let server: Server;
let port: number;

before(async () => {
  server = createServer(
    // These must be CONSTRUCTOR options. Setting server.headersTimeout
    // afterwards leaves connectionsCheckingInterval at its 30s default, so
    // a 300ms timeout is not CHECKED for 30 seconds (module 09 §5).
    { headersTimeout: 300, connectionsCheckingInterval: 50 },
    (req, res) => {
      let size = 0;
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > 1024) {
          res.statusCode = 413;
          res.setHeader("connection", "close");
          res.end(JSON.stringify({ code: "PAYLOAD_TOO_LARGE" }));
          req.destroy();
        }
      });
      req.on("end", () => { if (!res.headersSent) res.end(JSON.stringify({ size })); });
    },
  );
  server.listen(0);
  await once(server, "listening");
  port = (server.address() as { port: number }).port;
});
after(async () => {
  server.closeAllConnections();          // or this file hangs (03-lies.ts §4)
  await new Promise((r) => server.close(r));
});

test("rejects an oversized body mid-upload", async () => {
  const res = await fetch("http://127.0.0.1:" + port + "/", {
    method: "POST",
    body: "x".repeat(100_000),
  });
  assert.equal(res.status, 413);
  assert.deepEqual(await res.json(), { code: "PAYLOAD_TOO_LARGE" });
});

test("a slowloris client is cut off by headersTimeout", async () => {
  const sock = connect(port, "127.0.0.1");
  await once(sock, "connect");
  sock.write("POST / HTTP/1.1\\r\\nHost: x\\r\\n");   // headers never finished
  const t0 = Date.now();
  const chunks: Buffer[] = [];
  sock.on("data", (c: Buffer) => chunks.push(c));
  await once(sock, "close");
  const ms = Date.now() - t0;
  const status = Buffer.concat(chunks).toString().split("\\r\\n")[0];
  console.log("slowloris cut off after " + ms + "ms: " + JSON.stringify(status));
  assert.ok(ms < 2000, "should be cut within the headersTimeout window");
});

test("a malformed request line gets a 400 from Node itself", async () => {
  const sock = connect(port, "127.0.0.1");
  await once(sock, "connect");
  sock.write("NOT-A-VALID-REQUEST\\r\\n\\r\\n");
  const chunks: Buffer[] = [];
  sock.on("data", (c: Buffer) => chunks.push(c));
  await once(sock, "close");
  const response = Buffer.concat(chunks).toString();
  console.log("raw response: " + JSON.stringify(response.split("\\r\\n")[0]));
  assert.match(response, /400 Bad Request/);
});
`,
);
for (const line of resultLines(socket.stdout)) console.log(`  ${line}`);
for (const c of comments(socket.stdout).filter((c) => /^(slowloris|raw response)/.test(c)))
  console.log(`    ${c}`);
console.log(`
  None of these are reachable through an in-process shortcut. A
  malformed request line never reaches your handler at all — Node's
  parser answers it. A slowloris is a client that stops writing, which
  only exists if there is a socket. And an oversized body has to actually
  arrive in chunks for the mid-upload abort to be exercised.

  So: use inject() (module 11 §6) for the fast bulk of your route tests,
  and keep a handful of real-socket tests for the edges that only exist
  down there. The two are not in competition.
`);

// ─────────────────────────────────────────────────────────────────────────────
// 4. Testing shutdown itself
// ─────────────────────────────────────────────────────────────────────────────

console.log("=== 4. Shutdown is testable, and usually untested ===");

const shutdown = runTestFile(
  "shutdown.test.ts",
  `
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";

test("in-flight requests finish; new ones are refused", async () => {
  const server = createServer((_req, res) => setTimeout(() => res.end("done"), 300));
  server.listen(0);
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const url = "http://127.0.0.1:" + port + "/";

  // One request in flight.
  const inFlight = fetch(url).then((r) => r.text());
  await new Promise((r) => setTimeout(r, 50));

  // Shut down, the right way (05-shutdown.ts).
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  const sweep = setInterval(() => server.closeIdleConnections(), 20);

  // The in-flight request must still get its answer.
  assert.equal(await inFlight, "done");

  // And a new one must be refused, not queued.
  await assert.rejects(() => fetch(url));

  await closed;
  clearInterval(sweep);
  assert.equal(server.listening, false);
});
`,
);
for (const line of resultLines(shutdown.stdout)) console.log(`  ${line}`);
console.log(`  ${verdict(shutdown)}`);
console.log(`
  Two assertions, and they are the entire contract of a graceful
  shutdown: nothing in flight is dropped, and nothing new is accepted.

  Almost nobody writes this test, and shutdown is almost always where the
  502s come from. It is not hard to write — the whole thing is above.
`);

export {};
