/**
 * 15.5 — Graceful shutdown, measured.
 *
 *   node src/15-testing-deploy/05-shutdown.ts
 *
 * Every number below comes from a child process that actually did it.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "node-study-15s-"));

function scenario(name: string, source: string, args: string[] = [], timeoutMs = 25_000) {
  const file = path.join(dir, name);
  writeFileSync(file, source);
  const r = spawnSync(process.execPath, ["--no-warnings", file, ...args], {
    encoding: "utf8",
    timeout: timeoutMs,
  });
  return ((r.stdout ?? "") + (r.stderr ?? "")).trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. What close() does immediately
// ─────────────────────────────────────────────────────────────────────────────

console.log("=== 1. server.close() stops LISTENING at once ===");

console.log(
  scenario(
    "immediate.ts",
    `
import { createServer, get } from "node:http";
import { once } from "node:events";

const server = createServer((_req, res) => setTimeout(() => res.end("ok"), 600));
server.listen(0);
await once(server, "listening");
const { port } = server.address() as { port: number };

// One request already in flight.
get({ port }, (res) => { res.resume(); res.on("end", () => console.log("  in-flight request  → " + res.statusCode)); });
await new Promise((r) => setTimeout(r, 100));

server.close();
console.log("  server.listening after close() → " + server.listening);

get({ port }, () => console.log("  new request → ACCEPTED (would be a bug)"))
  .on("error", (e: NodeJS.ErrnoException) => console.log("  new request        → " + e.code));

setTimeout(() => process.exit(0), 1500);
`,
  ),
);

console.log(`
  close() is two things at once:
    • stop accepting — immediate, synchronous, irreversible
    • wait for existing connections — asynchronous, and the interesting part

  A new connection gets ECONNREFUSED. That is CORRECT behaviour for this
  process, and it is exactly why the load balancer must already have
  stopped sending you traffic before you get here (§5, and 06 §4).
`);

// ─────────────────────────────────────────────────────────────────────────────
// 2. The 6.8 seconds nobody expects
// ─────────────────────────────────────────────────────────────────────────────

console.log("=== 2. How long close() actually takes ===");

const drainSource = `
import { createServer, get, Agent } from "node:http";
import { once } from "node:events";

const mode = process.argv[2]!;
const server = createServer((_req, res) => setTimeout(() => res.end("ok"), 1000));
server.listen(0);
await once(server, "listening");
const { port } = server.address() as { port: number };

// A keep-alive client — what every browser and every proxy is.
const agent = new Agent({ keepAlive: true });
let client = "pending";
get({ port, agent }, (res) => { res.resume(); res.on("end", () => { client = "completed " + res.statusCode; }); })
  .on("error", (e: NodeJS.ErrnoException) => { client = "KILLED (" + e.code + ")"; });

// Let the request arrive and start work, so it is genuinely IN FLIGHT.
await new Promise((r) => setTimeout(r, 200));

const t0 = Date.now();
server.close(() => {
  console.log(mode.padEnd(9) + " drained in " + String(Date.now() - t0).padStart(5) + "ms   client: " + client);
  process.exit(0);
});

if (mode === "idle")  server.closeIdleConnections();
if (mode === "all")   server.closeAllConnections();
if (mode === "sweep") {
  const sweep = setInterval(() => server.closeIdleConnections(), 50);
  const deadline = setTimeout(() => { console.log("  (deadline reached, forcing)"); server.closeAllConnections(); }, 10_000);
  sweep.unref();
  deadline.unref();
}

setTimeout(() => { console.log(mode + ": STILL OPEN after 15s, client: " + client); process.exit(1); }, 15_000);
`;

for (const mode of ["none", "idle", "all", "sweep"]) {
  console.log("  " + scenario(`drain-${mode}.ts`, drainSource, [mode]));
}

console.log(`
  Read the "none" row twice. server.close() with ONE keep-alive client and
  ONE in-flight request took nearly SEVEN SECONDS, and the arithmetic is:

      1000ms   the handler finishing its work
    + 5000ms   keepAliveTimeout, the default
    +  ~800ms  everything else
    ─────────
      ~6800ms

  Since Node 19, close() also closes connections that are IDLE AT THAT
  MOMENT. Ours wasn't — it had a request in flight. It survived, answered
  in 1000ms, and then went back to being an idle keep-alive socket that
  nothing was watching. close() waited out keepAliveTimeout on it.

  That is why "idle" is no better: closeIdleConnections() called ONCE, at
  close() time, closes the same nothing that close() already closed.
`);

// ─────────────────────────────────────────────────────────────────────────────
// 3. The sweep
// ─────────────────────────────────────────────────────────────────────────────

console.log("=== 3. Why the sweep works ===");
console.log(`
  The bug is a one-shot answer to a question that keeps changing. A
  connection is not idle NOW; it will be in 800ms. So keep asking:

    server.close(() => { /* fully drained — resolve here */ });

    // Connections that BECOME idle after close() are nobody's job.
    const sweep = setInterval(() => server.closeIdleConnections(), 50);

    // And a deadline, because one stuck request must not hold the deploy.
    const deadline = setTimeout(() => server.closeAllConnections(), 10_000);

    sweep.unref();      // ← or these two handles keep the process alive
    deadline.unref();   //   forever, which is the bug you were fixing

  The measured result is the third and fourth rows above:

    close() alone            ~6800ms   client completed
    close() + sweep           ~800ms   client completed      ← 8× faster
    closeAllConnections()        0ms   client KILLED

  The last row is the trap. It is the fastest and it severs the in-flight
  request — a 502 for a user who was mid-checkout. It belongs at the
  DEADLINE and nowhere else.

  Do not forget the .unref() calls. An interval that outlives the drain is
  precisely the leaked handle that hangs a test file (03-lies.ts §4) and,
  here, the shutdown itself.
`);

// ─────────────────────────────────────────────────────────────────────────────
// 4. Everything else that must close, and in what order
// ─────────────────────────────────────────────────────────────────────────────

console.log("=== 4. Ordering ===");

const orderSource = `
import { createServer } from "node:http";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";

const log: string[] = [];
const db = new DatabaseSync(":memory:");
db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");

const server = createServer((_req, res) => {
  setTimeout(() => {
    // If the database is closed first, THIS is where the 500 comes from.
    try {
      db.prepare("INSERT INTO t DEFAULT VALUES").run();
      res.end("ok");
    } catch (err) {
      log.push("HANDLER FAILED: " + (err as Error).message.slice(0, 40));
      res.statusCode = 500;
      res.end("db gone");
    }
  }, 400);
});
server.listen(0);
await once(server, "listening");
const { port } = server.address() as { port: number };

const inFlight = fetch("http://127.0.0.1:" + port + "/").then((r) => r.status);
await new Promise((r) => setTimeout(r, 100));

const wrong = process.argv[2] === "wrong";

if (wrong) {
  db.close();                       // ✗ before the requests using it are done
  log.push("closed db first");
}

const closed = new Promise<void>((resolve) => server.close(() => resolve()));
const sweep = setInterval(() => server.closeIdleConnections(), 20);
sweep.unref();

const status = await inFlight;
await closed;

if (!wrong) { db.close(); log.push("closed db after draining"); }

console.log("  " + (wrong ? "WRONG order" : "RIGHT order") + ": in-flight request got " + status + "  [" + log.join("; ") + "]");
process.exit(0);
`;

console.log(scenario("order.ts", orderSource, ["wrong"]));
console.log(scenario("order.ts", orderSource, []));

console.log(`
  The full sequence, and every step is load-bearing:

    1. flip readiness to NOT READY            ← 06-deployment.ts §4
    2. wait 5-15 seconds                      ← the load balancer has not
                                                 noticed yet
    3. server.close() + sweep + deadline      ← drain
    4. close the database, the queue, the workers
    5. flush the logger                       ← module 12 §6
    6. process.exitCode = 0                   ← NOT process.exit()

  Step 2 is the one everyone omits, and it is why "we implemented graceful
  shutdown and still see 502s". Deregistration is eventually consistent:
  your instance is already terminating while the load balancer's health
  check is three seconds from noticing. Closing the socket in that window
  produces exactly the error you set out to prevent.

  Shut down in the reverse order of startup. Never close the database
  before the requests that are still using it.
`);

// ─────────────────────────────────────────────────────────────────────────────
// 5. Handling the signal exactly once
// ─────────────────────────────────────────────────────────────────────────────

console.log("=== 5. The second SIGTERM ===");
console.log(`
  An operator who does not see anything happen presses Ctrl-C again. That
  second signal must not start a second shutdown — it must force-exit:

    let shuttingDown = false;

    async function shutdown(signal: string) {
      if (shuttingDown) {
        // The impatient path. Somebody wants this over with.
        process.exit(1);
      }
      shuttingDown = true;
      log.info({ signal }, "shutting down");

      const forced = setTimeout(() => {
        log.error("shutdown timed out, forcing");
        process.exit(1);
      }, 30_000);
      forced.unref();

      try {
        ready = false;                       // 1
        await delay(5_000);                  // 2
        await drain(server);                 // 3
        db.close();                          // 4
        await flushLogs();                   // 5
        process.exitCode = 0;                // 6
      } catch (err) {
        log.error({ err }, "shutdown failed");
        process.exitCode = 1;
      }
    }

    for (const s of ["SIGTERM", "SIGINT"] as const) {
      process.on(s, () => void shutdown(s));
    }

  Two details in there that are easy to miss:

    • the forced timer is the LAST line of defence. Your orchestrator's
      grace period is usually 30s; make yours shorter, so YOU decide the
      exit code instead of collecting a SIGKILL.
    • \`void shutdown(s)\` — a signal handler cannot be awaited, so an
      async one produces a floating promise. Mark it deliberate, and make
      sure shutdown() cannot reject (03-lies.ts §3).
`);

export {};
