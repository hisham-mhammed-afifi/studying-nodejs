/**
 * 05 — Listener leaks, and how to make teardown reliable
 *
 * Run:  node src/03-event-emitter/05-leaks.ts
 */

import { EventEmitter, getEventListeners } from "node:events";

console.log("=== 1. The warning ===");
{
  const bus = new EventEmitter();
  // The 11th listener on the same event triggers MaxListenersExceededWarning
  // on stderr. It's a heuristic, not an error — nothing stops working.
  for (let i = 0; i < 11; i++) bus.on("data", () => {});
  console.log("  ↑ that warning came from the 11th listener");
  console.log("  count:", bus.listenerCount("data"));

  // Raise it only when the listeners are genuinely supposed to be there.
  bus.setMaxListeners(50);
  // Or globally: EventEmitter.defaultMaxListeners = 20;  (blunt instrument)
  // Or 0 to disable the check entirely — which just hides real leaks.
}

console.log("\n=== 2. The classic leak ===");
{
  const appBus = new EventEmitter(); // long-lived, app-scoped
  appBus.setMaxListeners(0); // silence the warning so we can see the growth

  // Imagine this is a request handler. Every request subscribes...
  function handleRequestBadly(id: number): void {
    appBus.on("config:changed", () => {
      /* re-read config for this request */
      void id;
    });
    // ...and nothing ever unsubscribes.
  }

  for (let i = 0; i < 1000; i++) handleRequestBadly(i);
  console.log("  after 1000 'requests':", appBus.listenerCount("config:changed"), "listeners");
  console.log(`
  Every one of those closures pins its captured scope in memory. On a real
  server this is a slow leak that shows up as steadily rising RSS and, hours
  later, an OOM kill. The listener array itself also makes every subsequent
  emit linearly slower.
`);
}

console.log("=== 3. Fix A: once() ===");
{
  const bus = new EventEmitter();
  for (let i = 0; i < 100; i++) bus.once("ready", () => {});
  console.log("  before emit:", bus.listenerCount("ready"));
  bus.emit("ready");
  console.log("  after emit: ", bus.listenerCount("ready"), "← self-removed ✓");
  console.log(`
  BUT: a once() listener for an event that NEVER fires is still a leak. It
  sits there forever. once() only helps when the event is guaranteed to
  arrive — and "guaranteed" rarely survives contact with the network.
`);
}

console.log("=== 4. Fix B: AbortSignal (the good one) ===");
{
  const bus = new EventEmitter();

  // ⚠ COMMON MISCONCEPTION: `emitter.on(name, fn, { signal })` does NOT work.
  // EventEmitter#on takes exactly two arguments and silently IGNORES a third —
  // so that code compiles, runs, and leaks. Only the STATIC helpers
  // events.once() and events.on() accept a signal. EventTarget's
  // addEventListener does support it natively; EventEmitter never has.
  //
  // Verify for yourself:
  //   const ac = new AbortController();
  //   bus.on("x", fn, { signal: ac.signal });
  //   ac.abort();
  //   bus.listenerCount("x");   // → 1. Still there.
  //
  // So write the four-line helper. It's the same ergonomics, and it's correct.
  function onWithSignal<T extends unknown[]>(
    emitter: EventEmitter,
    event: string,
    listener: (...args: T) => void,
    signal: AbortSignal,
  ): void {
    if (signal.aborted) return; // never subscribe to an already-cancelled scope
    emitter.on(event, listener as (...args: unknown[]) => void);
    // addAbortListener (Node 20.5+) is `signal.addEventListener("abort", …)`
    // with better semantics for an already-aborted signal.
    signal.addEventListener("abort", () => emitter.off(event, listener as (...args: unknown[]) => void), {
      once: true,
    });
  }

  function handleRequestWell(signal: AbortSignal): void {
    onWithSignal(bus, "config:changed", () => {}, signal);
    onWithSignal(bus, "shutdown", () => {}, signal);
    onWithSignal(bus, "flush", () => {}, signal);
  }

  const controllers = Array.from({ length: 100 }, () => {
    const ac = new AbortController();
    handleRequestWell(ac.signal);
    return ac;
  });
  console.log("  during 100 requests:", bus.listenerCount("config:changed"), "listeners");

  for (const ac of controllers) ac.abort(); // e.g. in a `finally` per request
  console.log("  after aborting all: ", bus.listenerCount("config:changed"), "← all gone ✓");

  console.log(`
  Why this is better than remembering to off() each listener:
    • ONE abort() tears down every listener registered with that signal,
      across every emitter — no matching pairs to keep in sync.
    • Exercise 03 has you build a bus with { signal } support baked in, so
      the helper above becomes unnecessary.
    • It composes: pass the same signal to fetch(), fs reads, and setTimeout
      from node:timers/promises, and they all cancel together.
    • It survives refactors. A new bus.on(..., { signal }) is cleaned up by
      construction; a new bus.on() without one is a leak you have to notice.

  In a request handler, the shape is:

      const ac = new AbortController();
      req.on("close", () => ac.abort());     // client hung up
      try { ...work using ac.signal... } finally { ac.abort(); }
`);
}

console.log("=== 5. Finding leaks ===");
{
  const bus = new EventEmitter();
  bus.on("a", function namedHandler() {});
  bus.on("a", () => {});
  bus.on("b", () => {});

  // getEventListeners is the introspection tool — useful in tests to assert
  // that teardown actually happened.
  console.log("  listeners on 'a':", getEventListeners(bus, "a").length);
  console.log("  names:", getEventListeners(bus, "a").map((f) => f.name || "(anonymous)"));
  console.log("  all events:", bus.eventNames());

  console.log(`
  In tests:
      afterEach(() => assert.equal(bus.listenerCount("x"), 0));
  is a cheap, effective regression guard.

  In production:
    • Watch the MaxListenersExceededWarning on stderr — don't filter it out.
      process.on("warning", w => log.warn({ w }, "node warning"));
    • Rising RSS with flat traffic → take two heap snapshots minutes apart
      (node --inspect, DevTools Memory tab) and diff. Growing arrays of
      closures point straight at the emitter.
    • node --heapsnapshot-signal=SIGUSR2 lets you dump from a live process.
`);
}

console.log("=== 6. EventTarget, for comparison ===");
{
  const target = new EventTarget();
  const ac = new AbortController();

  target.addEventListener("ping", (e) => console.log("  EventTarget got:", (e as CustomEvent).detail), {
    signal: ac.signal, // same idea, and it's been standard here since day one
  });
  target.dispatchEvent(new CustomEvent("ping", { detail: { n: 1 } }));
  ac.abort();
  target.dispatchEvent(new CustomEvent("ping", { detail: { n: 2 } }));
  console.log("  second dispatch after abort: (nothing) ✓");

  console.log(`
  EventTarget vs EventEmitter:
    • One Event object, not N positional arguments (payload goes in .detail).
    • A throwing listener does NOT stop the others — it becomes an uncaught
      exception and the rest still run. Arguably safer, definitely different.
    • No 'error' special case, so no crash-on-unhandled-error.
    • Web-standard, so the same code works in browsers and workers.
    • No once()/prepend()/listenerCount() ergonomics; introspection is worse.

  Rule: EventEmitter for Node-shaped APIs, EventTarget for anything that
  crosses into web-standard territory or is shared with browser code.
`);
}
