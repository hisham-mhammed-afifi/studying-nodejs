/**
 * 05 — Client errors, aborts, and graceful shutdown
 *
 * The shutdown measurements in §4 are the most useful thing in this module.
 *
 * Run:  node src/09-http/05-errors-shutdown.ts
 */

import { Agent, createServer, request, type Server } from "node:http";
import { connect } from "node:net";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

console.log("=== 1. clientError: when there is no req at all ===");
{
  const server = createServer((_req, res) => res.end("ok"));
  const seen: string[] = [];

  server.on("clientError", (err: NodeJS.ErrnoException, socket) => {
    seen.push(err.code ?? "?");
    // There is no `req` and no `res` — the request never parsed. You must
    // write a raw HTTP response onto the socket yourself.
    if (!socket.writableEnded) {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    }
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;

  // (a) garbage where the method should be
  await new Promise<void>((resolve) => {
    const sock = connect(port, "127.0.0.1", () => sock.write("NOT-HTTP-AT-ALL\r\n\r\n"));
    sock.on("data", (d) => console.log("  malformed request →", JSON.stringify(d.toString().split("\r\n")[0])));
    sock.on("close", () => resolve());
    sock.on("error", () => resolve());
  });

  // (b) client vanishes mid-body
  await new Promise<void>((resolve) => {
    const sock = connect(port, "127.0.0.1", () => {
      sock.write("POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 1000\r\n\r\n");
      sock.write("x".repeat(50));
      setTimeout(() => sock.destroy(), 30);
    });
    sock.on("close", () => setTimeout(resolve, 50));
    sock.on("error", () => {});
  });

  console.log("  error codes observed:", seen);
  console.log(`
  Codes you will see in production logs:

    HPE_INVALID_METHOD      garbage where the method should be
    HPE_INVALID_EOF_STATE   client vanished mid-request
    HPE_HEADER_OVERFLOW     headers exceeded maxHeaderSize (16KB default)
    ECONNRESET              client reset the connection

  These are mostly NORMAL: port scanners, health checks that hang up, users
  closing tabs, TLS probes hitting an HTTP port. Log them at DEBUG, not
  ERROR, or you'll drown. What matters is that you ANSWER — an unhandled
  clientError leaves the socket dangling.
`);

  server.closeAllConnections();
  server.close();
  await once(server, "close");
}

console.log("=== 2. Detecting a client that hung up ===");
{
  let observed = "";
  const server = createServer(async (req, res) => {
    const ac = new AbortController();

    // 'close' on res fires whether we finished or the client left.
    // writableFinished distinguishes them.
    res.on("close", () => {
      if (!res.writableFinished) {
        ac.abort();
        observed = `client disconnected — req.complete=${req.complete}, req.destroyed=${req.destroyed}`;
      }
    });

    try {
      // Pretend this is a slow database query, cancellable via the signal.
      await sleep(2_000, undefined, { signal: ac.signal });
      res.end("finished");
    } catch {
      // Aborted. Do NOT try to respond — the socket is gone.
    }
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;

  const ac = new AbortController();
  const pending = fetch(`http://127.0.0.1:${port}/`, { signal: ac.signal }).catch(() => "aborted");
  await sleep(100);
  ac.abort(); // the user navigates away
  await pending;
  await sleep(100);

  console.log(" ", observed, "✓");
  console.log(`
  Wire that AbortSignal through everything (modules 05-07):

      const rows  = await db.query(sql, { signal });
      const data  = await fetch(upstream, { signal });
      await pipeline(fileStream, res, { signal });

  Without it, a user closing a tab leaves your query running into a dead
  socket — and under load those add up to a saturated connection pool.

  (The old req 'aborted' event is deprecated. Use res 'close' plus
  writableFinished, as above.)
`);

  server.closeAllConnections();
  server.close();
  await once(server, "close");
}

console.log("=== 3. Errors inside a handler ===");
console.log(`
  An async handler that rejects is an UNHANDLED REJECTION, which kills the
  process by default (module 07 §4.1). createServer does not await you:

      createServer(async (req, res) => {
        await mightThrow();        // ✗ nothing catches this
        res.end();
      });

  Always wrap:

      createServer((req, res) => {
        void handle(req, res).catch((err) => {
          logger.error({ err }, "handler failed");
          if (res.headersSent) { res.destroy(); return; }   // can't change status now
          res.statusCode = 500;
          res.end(JSON.stringify({ error: "internal" }));   // never leak err.message
        });
      });

  Three rules in that catch:
    1. res.headersSent → you cannot turn a 200 into a 500; destroy instead
    2. never send err.message or a stack to a client (module 07 §4)
    3. res.on("error") too — a socket write can fail after you've responded
`);

console.log("=== 4. Graceful shutdown, measured ===");
{
  /**
   * One in-flight 200ms request; the socket then sits idle in keep-alive.
   * We measure how long server.close() takes to actually complete, and
   * whether the client's request survived.
   */
  async function measure(
    label: string,
    strategy: (server: Server) => { stop: () => void },
  ): Promise<void> {
    const server = createServer((_req, res) => setTimeout(() => res.end("ok"), 200));
    server.keepAliveTimeout = 5_000; // the default
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;

    const agent = new Agent({ keepAlive: true });
    let clientOutcome = "pending";
    const inflight = new Promise<void>((resolve) => {
      const req = request({ port, host: "127.0.0.1", path: "/", agent }, (res) => {
        res.resume();
        res.on("end", () => {
          clientOutcome = "completed ✓";
          resolve();
        });
      });
      req.on("error", (e: NodeJS.ErrnoException) => {
        clientOutcome = `FAILED (${e.code}) ✗`;
        resolve();
      });
      req.end();
    });

    await sleep(30); // let the request start
    const t0 = Date.now();

    const closed = new Promise<number>((resolve) => server.close(() => resolve(Date.now() - t0)));
    const { stop } = strategy(server);

    const ms = await Promise.race([closed, sleep(8_000).then(() => -1)]);
    stop();
    await inflight;

    console.log(
      `  ${label.padEnd(46)} close@ ${(ms === -1 ? ">8000" : String(ms)).padStart(5)}ms   client: ${clientOutcome}`,
    );

    agent.destroy();
    server.closeAllConnections();
  }

  await measure("close() alone", () => ({ stop: () => {} }));

  await measure("close() + closeIdleConnections() once", (server) => {
    const t = setTimeout(() => server.closeIdleConnections(), 50);
    return { stop: () => clearTimeout(t) };
  });

  await measure("close() + closeAllConnections() at 50ms", (server) => {
    const t = setTimeout(() => server.closeAllConnections(), 50);
    return { stop: () => clearTimeout(t) };
  });

  await measure("close() + REPEATED closeIdleConnections()", (server) => {
    const i = setInterval(() => server.closeIdleConnections(), 50);
    return { stop: () => clearInterval(i) };
  });

  console.log(`
  Read those four lines carefully — this is the trap.

  Row 1: server.close() stops ACCEPTING new connections and waits for
  existing ones. But after the 200ms request finishes, its socket sits in
  keep-alive, and an idle keep-alive socket still counts as "existing". So
  close() waits out the full keepAliveTimeout — 5 seconds of a deploy
  hanging for no reason.

  Row 2 is the surprise: closeIdleConnections() only closes sockets that are
  idle AT THAT INSTANT. Called at 50ms, while the request is still running,
  it does nothing — and then the socket goes idle and holds the server
  anyway. Calling it once, at the start of shutdown, is a no-op.

  Row 3 is fast but WRONG: closeAllConnections() kills in-flight requests.
  Every user mid-request gets a connection reset during your deploy.

  Row 4 is correct: sweep repeatedly, so each socket is closed the moment it
  goes idle, while requests that are still running are left alone.
`);
}

console.log("=== 5. The shutdown you should ship ===");
console.log(`
  import { once } from "node:events";

  async function shutdown(server: Server, graceMs = 10_000): Promise<void> {
    // 1. Fail the health check FIRST, so the load balancer stops routing
    //    to us before we close anything.
    healthy = false;
    await sleep(2_000);              // let the LB notice (2-3 check intervals)

    // 2. Stop accepting new connections.
    const closed = once(server, "close");
    server.close();

    // 3. Sweep idle keep-alive sockets repeatedly — the §4 lesson.
    const sweeper = setInterval(() => server.closeIdleConnections(), 100);

    // 4. Hard deadline: kill whatever is still running.
    const deadline = setTimeout(() => server.closeAllConnections(), graceMs);

    try {
      await closed;
    } finally {
      clearInterval(sweeper);
      clearTimeout(deadline);
    }

    // 5. Now close everything else: db pools, queues, worker pools.
    await Promise.all([db.end(), pool.close()]);
  }

  process.on("SIGTERM", () => {
    shutdown(server).then(
      () => process.exit(0),
      (err) => { logger.fatal({ err }); process.exit(1); },
    );
  });

  SIGTERM is what Docker, Kubernetes and systemd send. SIGINT is Ctrl+C.
  Handle both. SIGKILL cannot be caught — that's the point of the deadline.
`);
