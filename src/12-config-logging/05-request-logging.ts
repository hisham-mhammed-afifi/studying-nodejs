/**
 * 05 — Request-scoped logging: correlation without plumbing
 *
 * Run:  node src/12-config-logging/05-request-logging.ts
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import Fastify from "fastify";
import pino from "pino";

/** Collect output so the demo stays readable. */
function capture() {
  const lines: Record<string, unknown>[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      for (const raw of chunk.toString().trim().split("\n")) {
        if (raw) lines.push(JSON.parse(raw) as Record<string, unknown>);
      }
      cb();
    },
  });
  return { sink, lines };
}

const show = (l: Record<string, unknown>) => {
  const { time, pid, hostname, level, ...rest } = l;
  void time;
  void pid;
  void hostname;
  console.log(`    [${String(level).padStart(2)}] ${JSON.stringify(rest)}`);
};

console.log("=== 1. The problem ===");
console.log(`
  Two requests are interleaved. Their log lines are interleaved too. Which
  "payment failed" belongs to which customer?

  Threading a logger through every signature works and is miserable:

      handler(req, res, log)
        → service(input, log)
          → repository(query, log)
            → driver(sql, log)

  …and one library in the middle that doesn't take a logger breaks it.
`);

console.log("=== 2. AsyncLocalStorage + a child logger ===");
{
  const { sink, lines } = capture();
  const baseLogger = pino({ level: "info" }, sink);

  const store = new AsyncLocalStorage<{ log: pino.Logger }>();

  /** Anywhere, at any depth: no parameter passing (module 07 §6). */
  const log = (): pino.Logger => store.getStore()?.log ?? baseLogger;

  async function chargeCard(amountCents: number) {
    await sleep(5);
    log().warn({ amountCents }, "payment declined");
  }

  async function handleRequest(requestId: string, userId: string, delayMs: number) {
    // ONE child logger per request, bound with the correlation fields.
    const requestLog = baseLogger.child({ requestId, userId });
    await store.run({ log: requestLog }, async () => {
      log().info({ route: "/checkout" }, "started");
      await sleep(delayMs);
      await chargeCard(4999);
      log().info("finished");
    });
  }

  await Promise.all([
    handleRequest("req-A", "u1", 30),
    handleRequest("req-B", "u2", 5),
    handleRequest("req-C", "u3", 15),
  ]);

  console.log("  interleaved output, every line correlated:");
  for (const l of lines) show(l);

  console.log(`
  chargeCard() takes no logger and knows nothing about requests, yet every
  line it writes carries the right requestId and userId.

  Two mechanisms, doing different jobs:
    • AsyncLocalStorage carries the CONTEXT across awaits (module 07 §6)
    • pino's child logger BINDS the fields once, so they repeat for free
`);
}

console.log("=== 3. Fastify does this for you ===");
{
  const { sink, lines } = capture();

  const app = Fastify({
    loggerInstance: pino({ level: "info" }, sink),
    // Honour an incoming id so a trace survives across services; generate
    // one otherwise. ⚠ The header is attacker-controlled — validate it
    // before it reaches your logs (see §4).
    genReqId: (req) => {
      const incoming = req.headers["x-request-id"];
      return typeof incoming === "string" && /^[\w-]{1,64}$/.test(incoming) ? incoming : randomUUID();
    },
  });

  app.get("/users/:id", async (req) => {
    // req.log is ALREADY a child logger with reqId bound.
    req.log.info({ step: "loading" }, "fetching user");
    await sleep(3);
    return { id: (req.params as { id: string }).id };
  });

  await app.ready();
  await app.inject({ url: "/users/42", headers: { "x-request-id": "trace-abc" } });
  await app.inject({ url: "/users/7" });
  await app.close();

  console.log("  Fastify's own request/response lines plus ours:");
  for (const l of lines) show(l);

  console.log(`
  Note reqId on every line, including Fastify's own "incoming request" and
  "request completed". The first request reused OUR header value; the second
  got a generated uuid.

  responseTime comes for free too — no hand-rolled timing middleware
  (module 10 §3).
`);
}

console.log("=== 4. ⚠ Do not trust an incoming request id ===");
{
  const hostile = [
    "trace-abc", // fine
    "a".repeat(500), // unbounded length
    'x", "admin": true, "y": "', // JSON injection attempt
    "line1\nline2", // log forging via a newline
  ];

  const safe = (v: string) => /^[\w-]{1,64}$/.test(v);

  for (const value of hostile) {
    const preview = value.length > 24 ? value.slice(0, 24) + "…" : value;
    console.log(`  ${JSON.stringify(preview).padEnd(30)} accepted: ${safe(value)}`);
  }

  console.log(`
  x-request-id is a header, so it is whatever the caller wants. Unvalidated
  it goes into every log line AND into your response headers.

  The newline one is the interesting attack: in a LINE-based log format an
  embedded \\n forges a whole extra log entry. pino writes JSON and escapes
  it, so you are protected there — but plenty of pipelines and sidecars
  still split on newlines.

  Validate: a length cap and a character allowlist. Reject or regenerate.
`);
}

console.log("=== 5. What belongs on every request line ===");
console.log(`
  requestId / traceId    correlation — the whole point
  route PATTERN          "/users/:id", never "/users/42" (module 10 §3)
  method, status         the basics
  durationMs             from onResponse (module 11 §5)
  userId / tenantId      once authenticated
  outcome                a stable code, not a prose message

  NOT: the full url with query (secrets end up in query strings), request
  or response bodies, headers wholesale, or anything from §4 unvalidated.

  One access line per request at info, plus warn/error as they happen. At
  1,000 req/s that is already 86 MILLION lines a day (README §6.2) — so
  everything beyond one line per request needs a reason.
`);
