/**
 * 04 — pino: structured logging that's correct by default
 *
 * Run:  node src/12-config-logging/04-pino.ts
 */

import pino from "pino";
import { Writable } from "node:stream";

/** Capture log output instead of printing it, so the demo stays readable. */
function capture(options: pino.LoggerOptions = {}) {
  const lines: Record<string, unknown>[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      lines.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
      cb();
    },
  });
  return { logger: pino({ level: "trace", ...options }, sink), lines };
}

const show = (line: Record<string, unknown>, keys?: string[]) => {
  const { time, pid, hostname, ...rest } = line;
  void time;
  void pid;
  void hostname;
  const shown = keys ? Object.fromEntries(keys.map((k) => [k, rest[k]])) : rest;
  console.log("   ", JSON.stringify(shown));
};

console.log("=== 1. One JSON object per line ===");
{
  const { logger, lines } = capture();
  logger.info({ userId: "u1", route: "/users/:id" }, "request handled");
  show(lines[0]!);
  console.log(`
  A constant \`msg\` plus variable FIELDS. That is the whole discipline:

    ✗ logger.info(\`user \${id} failed checkout\`)
        → every line unique, so "how often?" needs a regex, and the regex
          breaks the moment someone rewords the message

    ✓ logger.error({ userId: id }, "checkout failed")
        → group by msg, filter by userId, chart the rate

  Pipe it through jq in development:
      node app.ts | jq 'select(.level >= 50)'
`);
}

console.log("=== 2. Levels are NUMBERS ===");
{
  const { logger, lines } = capture({ level: "warn" });
  logger.debug("not emitted");
  logger.info("not emitted");
  logger.warn("emitted");
  logger.error("emitted");

  console.log("  level: 'warn' →", lines.length, "lines emitted of 4 calls");
  for (const l of lines) show(l, ["level", "msg"]);

  console.log(`
    trace 10 · debug 20 · info 30 · warn 40 · error 50 · fatal 60

  The comparison is numeric, which is why level filtering is nearly free.
  But note WHEN it happens — see §3.
`);
}

console.log("=== 3. ⚠ A suppressed log still evaluates its argument ===");
{
  const { logger } = capture({ level: "info" });
  let called = 0;
  const expensive = () => {
    called++;
    return { rows: Array.from({ length: 1000 }, (_, i) => i) };
  };

  logger.debug({ data: expensive() }, "state dump"); // debug is OFF
  console.log("  logger.debug({ data: expensive() }) with level=info");
  console.log("  → expensive() was called", called, "time(s) ✗");

  called = 0;
  if (logger.isLevelEnabled("debug")) logger.debug({ data: expensive() }, "state dump");
  console.log("  guarded with isLevelEnabled → called", called, "times ✓");

  console.log(`
  JavaScript evaluates arguments BEFORE the call, so pino never gets the
  chance to skip the work — it only skips the WRITING.

  For cheap fields this is irrelevant. For a serialization, a database
  lookup, or a big array in a hot path, guard it:

      if (logger.isLevelEnabled("debug")) logger.debug({ dump: build() }, "…");
`);
}

console.log("=== 4. Child loggers: correlation without plumbing ===");
{
  const { logger, lines } = capture();

  const requestLog = logger.child({ requestId: "req-7f3a", userId: "u42" });
  requestLog.info({ route: "/checkout" }, "started");
  requestLog.warn({ attempt: 2 }, "retrying payment");

  // Children nest — a sub-operation can add its own fields.
  const paymentLog = requestLog.child({ component: "payments", provider: "stripe" });
  paymentLog.error({ code: "card_declined" }, "payment failed");

  for (const l of lines) show(l);

  console.log(`
  Bind once, and every subsequent line carries the fields. requestId
  appears on all three; component only on the third.

  Combine with AsyncLocalStorage (module 07 §6) and nothing needs to thread
  a logger through call signatures. Fastify already does exactly this —
  req.log is a child with the request id bound (module 11).
`);
}

console.log("=== 5. Errors, and two traps ===");
{
  const inner = Object.assign(new Error("gateway timeout"), { code: "ETIMEDOUT" });
  const outer = new Error("checkout failed", { cause: inner });
  const noStack = (e: unknown) => JSON.stringify(e, (k, v) => (k === "stack" ? undefined : v));

  // (a) The key must be `err`.
  {
    const { logger, lines } = capture();
    logger.error({ err: outer }, "logged as err");
    logger.error({ error: outer }, "logged as error");
    console.log("  { err: … }   →", noStack(lines[0]!["err"]));
    console.log("  { error: … } →", noStack(lines[1]!["error"]), "  ✗ the classic {} again");
  }

  // (b) The DEFAULT serializer flattens cause into the message.
  {
    const { logger, lines } = capture();
    logger.error({ err: outer }, "default serializer");
    logger.error({ err: inner }, "custom props survive");
    console.log("\n  default serializer  →", noStack(lines[0]!["err"]));
    console.log("  custom props        →", noStack(lines[1]!["err"]));
  }

  // (c) errWithCause keeps the chain structured.
  {
    const { logger, lines } = capture({ serializers: { err: pino.stdSerializers.errWithCause } });
    logger.error({ err: outer }, "errWithCause");
    console.log("  errWithCause        →", noStack(lines[0]!["err"]));
  }

  console.log(`
  Three things I had to check rather than assume:

  1. The key MUST be "err". pino's serializer is registered on that exact
     name, so { error: err } is serialized as a plain object — which, since
     Error's properties are non-enumerable (module 07 §1.1), is {}. The same
     empty-object bug pino exists to prevent, reintroduced by a typo.

  2. The DEFAULT serializer FLATTENS the cause into the message string:
     "checkout failed: gateway timeout". Readable, but you cannot query on
     the inner error's code, and a three-deep chain becomes one long line.

  3. pino.stdSerializers.errWithCause keeps it STRUCTURED — a nested
     { cause: { type, message, code } } you can actually filter on.

  Custom own-properties like .code survive either way, because those ARE
  enumerable (module 07 §1.1).

  So for a service that rewraps errors with cause (module 07 §2 — and you
  should), configure it explicitly:

      pino({ serializers: { err: pino.stdSerializers.errWithCause } })
`);
}

console.log("=== 6. Custom serializers ===");
{
  const { logger, lines } = capture({
    serializers: {
      // Never log a whole user object; reduce it to what's useful.
      user: (u: { id: string; email: string; passwordHash: string }) => ({
        id: u.id,
        emailDomain: u.email.split("@")[1],
      }),
    },
  });

  logger.info(
    { user: { id: "u1", email: "ada@example.com", passwordHash: "$2b$SECRET" } },
    "user loaded",
  );
  show(lines[0]!);

  console.log(`
  A serializer runs on a KEY, everywhere that key appears. That makes it a
  far better control than remembering to pick fields at each call site —
  the same argument as Fastify's response schemas (module 11 §3.1).

  Note it kept only the email DOMAIN. Logging full email addresses is a
  privacy decision, not a technical one; make it once, centrally.
`);
}

console.log("=== 7. Transports: keep formatting off the hot path ===");
console.log(`
  DEVELOPMENT — human-readable, colourised:

      node app.ts | npx pino-pretty

  …or configured, which runs the formatting in a WORKER THREAD (module 08):

      pino({ transport: { target: "pino-pretty" } });

  PRODUCTION — raw NDJSON to stdout, and nothing else:

      pino({ level: config.LOG_LEVEL });

  Let the platform collect stdout. A process that manages its own log files
  eventually fills a disk (module 06: ENOSPC), and rotation, retention and
  shipping are all solved problems outside your process.

  ⚠ Do NOT use pino-pretty in production. It is ~10× slower and it turns
  structured logs back into strings, destroying the reason you chose pino.
`);

console.log("=== 8. Why pino rather than console.log ===");
console.log(`
  console.log is SYNCHRONOUS to a TTY and to a file (module 01 §4.3), so
  every log line blocks the event loop for its write. pino writes to a
  buffered stream and can hand formatting to a worker thread.

  It also gets the details right that module 07 §7 said to get right:
    • NDJSON, one object per line
    • Error serialized with its cause chain
    • path-based redaction (06-redaction.ts)
    • child loggers for correlation
    • a level check that is a numeric comparison

  You wrote a version of this by hand in module 07's demos. This is the
  same thing, faster and battle-tested.
`);
