/**
 * 04 — Keep-alive and the four timeouts
 *
 * Run:  node src/09-http/04-timeouts-keepalive.ts
 */

import http, { Agent, createServer, request } from "node:http";
import { connect } from "node:net";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { Socket } from "node:net";

console.log("=== 1. The defaults ===");
{
  const s = createServer(() => {});
  console.log("  server.headersTimeout   =", s.headersTimeout, "ms   (complete headers must arrive)");
  console.log("  server.requestTimeout   =", s.requestTimeout, "ms  (the entire request)");
  console.log("  server.keepAliveTimeout =", s.keepAliveTimeout, "ms    (idle socket before close)");
  console.log("  server.timeout          =", s.timeout, "ms       (socket inactivity; 0 = off)");
  console.log("  http.maxHeaderSize      =", http.maxHeaderSize, "bytes (total header size)");
  // Not in @types/node yet, though it exists at runtime — the types are a
  // community package that trails the runtime (module 05 §5.4).
  const checkingInterval = (s as unknown as { connectionsCheckingInterval: number }).connectionsCheckingInterval;
  console.log("  connectionsCheckingInterval =", checkingInterval, "ms  ← see the warning below");
  s.close();
  console.log(`
  ⚠ THE SWEEP INTERVAL. Node does not arm a timer per connection. It sweeps
  every connection on an interval — connectionsCheckingInterval, 30_000ms by
  default — and closes whatever has expired. So a timeout is only enforced to
  within that granularity.

  Setting headersTimeout = 300 in this demo produced a socket that lived for
  30004ms, until the next sweep. If you need tight enforcement, lower the
  interval when you create the server:

      createServer({ connectionsCheckingInterval: 1_000 }, handler);

  For production defaults (60s+) the 30s sweep is fine, and cheaper.

  Four different timeouts, protecting four different things:

    headersTimeout    Slowloris — a client dribbling headers one byte at a
                      time, holding a connection open forever
    requestTimeout    a slow or endless BODY
    keepAliveTimeout  idle sockets accumulating after a response
    maxHeaderSize     a header bomb (thousands of headers, or one huge one)
`);
}

console.log("=== 2. Keep-alive, measured ===");
{
  const sockets = new Set<Socket>();
  const server = createServer((_req, res) => res.end("ok"));
  server.on("connection", (s) => sockets.add(s));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;

  const hit = (agent: Agent) =>
    new Promise<void>((resolve, reject) => {
      const req = request({ port, host: "127.0.0.1", path: "/", agent }, (res) => {
        res.resume();
        res.on("end", () => resolve());
      });
      req.on("error", reject);
      req.end();
    });

  sockets.clear();
  const noKa = new Agent({ keepAlive: false });
  for (let i = 0; i < 10; i++) await hit(noKa);
  const without = sockets.size;
  noKa.destroy();

  sockets.clear();
  const withKa = new Agent({ keepAlive: true });
  for (let i = 0; i < 10; i++) await hit(withKa);
  const with_ = sockets.size;
  withKa.destroy();

  console.log(`  10 sequential requests, keepAlive: false → ${without} TCP connections`);
  console.log(`  10 sequential requests, keepAlive: true  → ${with_} TCP connection`);
  console.log(`
  Each new connection costs a TCP handshake — and a TLS handshake over
  HTTPS, which is often more expensive than the request itself.

  Node's http.globalAgent has keepAlive: true by default since v19
  (currently ${(http.globalAgent as unknown as { keepAlive: boolean }).keepAlive}), and fetch() uses a pooled
  keep-alive connection too. You mostly get this for free now; you needed
  to opt in on older versions.
`);

  server.closeAllConnections();
  server.close();
  await once(server, "close");
}

console.log("=== 3. headersTimeout stops Slowloris ===");
{
  // ⚠ connectionsCheckingInterval matters as much as the timeout itself.
  // Node does not arm a timer per connection — it SWEEPS all connections on
  // an interval, 30_000ms by default. So headersTimeout = 300 without this
  // option actually fires at the next sweep, i.e. up to 30 SECONDS later.
  // (I measured 30004ms before adding this line.)
  const server = createServer({ connectionsCheckingInterval: 50 }, (_req, res) => res.end("ok"));
  server.headersTimeout = 300; // absurdly short, for the demo
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;

  const t0 = Date.now();
  const outcome = await new Promise<string>((resolve) => {
    let reply = "";
    let drip: NodeJS.Timeout | undefined;
    const finish = (how: string) => {
      if (drip) clearInterval(drip);
      const first = reply.split("\r\n")[0];
      resolve(`${how} after ${Date.now() - t0}ms${first ? ` — server said "${first}"` : ""}`);
    };

    const sock = connect(port, "127.0.0.1", () => {
      // A classic Slowloris: keep sending headers forever, never sending
      // the blank line that would end them.
      sock.write("GET / HTTP/1.1\r\nHost: x\r\n");
      drip = setInterval(() => sock.write("X-Pad: 1\r\n"), 50);
    });
    sock.on("data", (d) => {
      reply += d.toString();
    });
    sock.on("close", () => finish("socket closed"));
    // The server may RST rather than FIN; either way it's the timeout firing.
    sock.on("error", () => finish("socket reset"));
  });
  console.log(" ", outcome, "✓ (headersTimeout was 300ms)");
  console.log(`
  Without headersTimeout that connection lives forever. A few thousand of
  them and you're out of file descriptors (module 06 §9) with almost no
  bandwidth spent by the attacker.
`);

  server.closeAllConnections();
  server.close();
  await once(server, "close");
}

console.log("=== 4. ⚠ The keep-alive 502 race ===");
console.log(`
  This one causes real, intermittent, low-traffic-only 502s behind a load
  balancer, and it is pure timing:

    1. The LB has an idle pooled connection to your server.
    2. It decides to reuse it and sends a request.
    3. At that same instant Node's keepAliveTimeout fires and closes the
       socket.
    4. The LB sees the connection die mid-request → 502.

  It only happens when your timeout is SHORTER than the proxy's, and only
  when traffic is light enough for connections to sit idle that long —
  which is why it never reproduces in load testing.

  The fix is to outlive the proxy:

      server.keepAliveTimeout = 65_000;   // AWS ALB idle default is 60s
      server.headersTimeout   = 66_000;   // must EXCEED keepAliveTimeout

  headersTimeout has to be larger, or it can cut off a legitimately reused
  connection before its request line arrives.

  Check your proxy's idle timeout: ALB 60s, nginx keepalive_timeout 75s,
  Cloudflare 100s, GCP LB 600s. Then add a few seconds.
`);

console.log("=== 5. ⚠ NOTHING times out a slow handler ===");
{
  /** Race a request against a wall clock, so a hang is visible. */
  async function probe(configure: (s: ReturnType<typeof createServer>) => void, label: string) {
    const server = createServer({ connectionsCheckingInterval: 50 }, () => {
      // A handler that simply never responds.
    });
    configure(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;

    const t0 = Date.now();
    const outcome = await Promise.race([
      fetch(`http://127.0.0.1:${port}/`)
        .then((r) => `HTTP ${r.status}`)
        .catch((e: Error & { cause?: NodeJS.ErrnoException }) => `client error (${e.cause?.code ?? e.message})`),
      new Promise<string>((r) => setTimeout(() => r("STILL HANGING"), 2_000)),
    ]);
    console.log(`  ${label.padEnd(34)} ${outcome} after ${Date.now() - t0}ms`);

    server.closeAllConnections();
    server.close();
    await once(server, "close");
  }

  await probe((s) => {
    s.requestTimeout = 400;
  }, "requestTimeout = 400");

  await probe((s) => {
    s.requestTimeout = 400;
    s.setTimeout(400); // socket inactivity
  }, "…plus server.setTimeout(400)");

  console.log(`
  I assumed requestTimeout would cover this. It does not, and the docs are
  precise about why:

      requestTimeout — "for receiving the ENTIRE REQUEST from the client"

  Once the request has fully ARRIVED, requestTimeout is satisfied. Your
  handler can then take forever and Node will wait patiently. Only
  server.setTimeout() — socket INACTIVITY, and off by default (0) — cuts it.

  And even that is a blunt instrument: it destroys the socket, it does NOT
  cancel your work. The query keeps running, the upstream fetch keeps
  waiting, the connection pool stays occupied.

  So a slow handler needs BOTH:

      // 1. cancel the work when the client leaves or the budget expires
      const ac = new AbortController();
      res.on("close", () => { if (!res.writableFinished) ac.abort(); });
      const signal = AbortSignal.any([ac.signal, AbortSignal.timeout(3_000)]);
      const rows = await db.query(sql, { signal });

      // 2. a socket-level backstop for anything that ignores the signal
      server.setTimeout(30_000);

  Nothing in Node gives you a per-route deadline for free. You write it.
`);
}

console.log("=== 6. A production timeout configuration ===");
console.log(`
  const server = createServer(handler);

  // Longer than the proxy in front of you, to avoid the §4 race.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout   = 66_000;   // must exceed keepAliveTimeout

  // Tighten from the 5-minute default unless you accept large uploads.
  server.requestTimeout   = 30_000;

  // Cap header size (default 16KB) — smaller if you don't use big cookies.
  //   node --max-http-header-size=8192 app.ts

  // Optional: recycle sockets so a long-lived proxy connection can't pin
  // one worker forever.
  server.maxRequestsPerSocket = 1000;

  And per request, the thing timeouts alone cannot do — actually CANCEL
  the work:

      const ac = new AbortController();
      res.on("close", () => { if (!res.writableFinished) ac.abort(); });
`);
