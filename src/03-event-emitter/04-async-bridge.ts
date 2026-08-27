/**
 * 04 — Bridging events into async/await
 *
 * Run:  node src/03-event-emitter/04-async-bridge.ts
 */

import { EventEmitter, once, on } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";

console.log("=== 1. events.once() → a Promise for the next emission ===");
{
  const bus = new EventEmitter();
  setTimeout(() => bus.emit("ready", "payload", 42), 20);

  // Resolves with the ARGUMENT ARRAY, so destructure it.
  const [msg, n] = (await once(bus, "ready")) as [string, number];
  console.log("  got:", msg, n);
}

console.log("\n=== 2. events.once() rejects on 'error' ===");
{
  const bus = new EventEmitter();
  setTimeout(() => bus.emit("error", new Error("connection refused")), 20);
  try {
    await once(bus, "ready"); // waiting for 'ready', but 'error' fires
    console.log("  unreachable");
  } catch (err) {
    console.log("  rejected with:", (err as Error).message);
  }
  console.log(`
  This is why once() is so useful: it maps the emitter's two-channel model
  (success event / error event) onto the promise's two channels. You get
  try/catch for free.

  Note the exception: if you await once(emitter, "error"), it RESOLVES with
  the error rather than rejecting. Waiting for 'error' is a legitimate thing
  to do, so it isn't special-cased there.
`);
}

console.log("=== 3. Timeouts with AbortSignal ===");
{
  const bus = new EventEmitter();

  // ⚠ SHARP EDGE: AbortSignal.timeout()'s internal timer is UNREF'd — it does
  // not keep the process alive. If it is the only thing pending, Node decides
  // it has nothing left to do and exits (or, under top-level await, dies with
  // "Promise resolution is still pending", exit code 13). It's the right
  // default for a server that has other work, and a foot-gun in a script.
  // A ref'd keepalive makes this demo deterministic:
  const keepalive = setInterval(() => {}, 1000);

  // Nothing will ever emit 'ready'. Without a signal this hangs forever, and
  // it also LEAKS a listener on every call — the classic slow memory leak in
  // event-driven code.
  try {
    await once(bus, "ready", { signal: AbortSignal.timeout(30) });
  } catch (err) {
    // ⚠ NOT "TimeoutError". events.once() WRAPS the signal's reason in its own
    // AbortError and puts the original on `.cause`. Code that checks
    // `err.name === "TimeoutError"` silently never matches.
    const e = err as Error & { code?: string; cause?: Error };
    console.log("  aborted:", e.name, "| code:", e.code); // AbortError | ABORT_ERR
    console.log("  cause:  ", e.cause?.name, "-", e.cause?.message); // TimeoutError
  }
  console.log("  listeners left behind:", bus.listenerCount("ready"), "← the signal cleaned up ✓");

  // AbortSignal.any() composes several reasons to stop:
  const userCancel = new AbortController();
  const composed = AbortSignal.any([userCancel.signal, AbortSignal.timeout(1000)]);
  setTimeout(() => userCancel.abort(new Error("user hit cancel")), 20);
  try {
    await once(bus, "ready", { signal: composed });
  } catch (err) {
    // Same wrapping applies to a custom reason: the message you passed to
    // abort() lives on .cause, not on the error you catch.
    const e = err as Error & { cause?: Error };
    console.log("  composed abort:", e.message, "| cause:", e.cause?.message);
  }
  clearInterval(keepalive);
}

console.log("\n=== 4. events.on() → an async iterator over emissions ===");
{
  const bus = new EventEmitter();
  const ac = new AbortController();

  (async () => {
    for (let i = 1; i <= 5; i++) {
      await sleep(10);
      bus.emit("tick", i);
    }
    ac.abort(); // ends the loop below
  })();

  try {
    for await (const [n] of on(bus, "tick", { signal: ac.signal })) {
      console.log("  tick", n);
    }
  } catch (err) {
    if ((err as Error).name !== "AbortError") throw err;
  }
  console.log("  iteration finished ✓");

  console.log(`
  ⚠ events.on() BUFFERS. Emissions that arrive while your loop body is busy
  queue up in an UNBOUNDED array. A fast producer and a slow consumer will
  grow that array until the process runs out of memory — the emitter has no
  backpressure mechanism to push back with.

  Use it for low-rate control events. For high-rate data, use a Readable
  stream (module 05), which has backpressure built in.
`);
}

console.log("=== 5. Racing several event sources ===");
{
  const primary = new EventEmitter();
  const fallback = new EventEmitter();
  const ac = new AbortController();

  setTimeout(() => fallback.emit("data", "from fallback"), 20);
  setTimeout(() => primary.emit("data", "from primary"), 60);

  const [winner] = (await Promise.race([
    once(primary, "data", { signal: ac.signal }),
    once(fallback, "data", { signal: ac.signal }),
  ])) as [string];

  // ALWAYS abort the losers. Promise.race settles, but the losing promises
  // stay pending and their listeners stay attached — forever, on a
  // long-lived emitter. This is the #1 leak in "race with timeout" code.
  ac.abort();

  console.log("  winner:", winner);
  console.log("  listeners on primary after abort:", primary.listenerCount("data"));
}

console.log("\n=== 6. Making an event API awaitable, end to end ===");
{
  // A realistic pattern: wrap a callback/event API in a promise with proper
  // timeout, cleanup, and error mapping.
  class Connection extends EventEmitter {
    connect(): void {
      setTimeout(() => this.emit("connect"), 25);
    }
  }

  async function connectWithTimeout(conn: Connection, ms: number): Promise<void> {
    conn.connect();
    try {
      await once(conn, "connect", { signal: AbortSignal.timeout(ms) });
    } catch (err) {
      // Check the CAUSE, not the error's own name — see section 3. Checking
      // `err.name === "TimeoutError"` here would never match, and the timeout
      // would surface as a bare "The operation was aborted".
      const cause = (err as Error & { cause?: Error }).cause;
      if (cause?.name === "TimeoutError") {
        throw new Error(`connect timed out after ${ms}ms`, { cause: err });
      }
      throw err;
    }
  }

  await connectWithTimeout(new Connection(), 100);
  console.log("  connected within budget ✓");

  try {
    await connectWithTimeout(new Connection(), 10);
  } catch (err) {
    console.log("  ", (err as Error).message); // connect timed out after 10ms
    // `cause` preserves the original — always use it when rewrapping errors.
    // Here it chains: our Error → the AbortError → the TimeoutError.
    const abortErr = (err as Error).cause as Error & { cause?: Error };
    console.log("   caused by:", abortErr.name, "→", abortErr.cause?.name);
  }
}

console.log(`
=== Summary ===

  once(emitter, name, { signal })   one event → a Promise. Rejects on 'error'.
  on(emitter, name, { signal })     many events → an async iterator. Unbounded buffer.
  AbortSignal.timeout(ms)           a signal that fires itself after ms.
  AbortSignal.any([a, b])           compose several cancellation reasons.

  The rule underneath all of it: every await on an event needs an escape hatch.
  An emitter that never emits leaves you hung AND leaks a listener.
`);
