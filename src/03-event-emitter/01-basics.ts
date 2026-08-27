/**
 * 01 — EventEmitter basics
 *
 * Run:  node src/03-event-emitter/01-basics.ts
 */

import { EventEmitter } from "node:events";

console.log("=== 1. emit() is SYNCHRONOUS ===");
{
  const bus = new EventEmitter();
  bus.on("ping", () => console.log("  listener ran"));
  console.log("  before emit");
  bus.emit("ping");
  console.log("  after emit");
  // → before / listener / after
  // There is no queue and no scheduling. emit() is a for-loop that calls your
  // functions on the current stack. If a listener blocks, emit blocks.
}

console.log("\n=== 2. Registration order, and jumping the queue ===");
{
  const bus = new EventEmitter();
  bus.on("x", () => console.log("  second"));
  bus.prependListener("x", () => console.log("  first"));
  bus.on("x", () => console.log("  third"));
  bus.emit("x");
  // prependListener exists for interceptors/instrumentation that must observe
  // an event before application handlers get a chance to mutate anything.
}

console.log("\n=== 3. emit() returns whether anyone was listening ===");
{
  const bus = new EventEmitter();
  console.log("  no listeners →", bus.emit("nobody-home")); // false
  bus.on("somebody", () => {});
  console.log("  one listener →", bus.emit("somebody")); // true
  // Useful for "log it if nothing handled it" fallbacks. Note it says nothing
  // about whether the listeners SUCCEEDED.
}

console.log("\n=== 4. Arguments are positional and untyped ===");
{
  const bus = new EventEmitter();
  bus.on("data", (...args: unknown[]) => console.log("  got:", args));
  bus.emit("data", 1, "two", { three: true });
  bus.emit("data"); // no args at all — nothing stops you
  // The base types say `(...args: any[]) => void`. That's why 03-typed-emitter.ts
  // exists: without it you get no help at all from TypeScript here.
}

console.log("\n=== 5. once() self-removes BEFORE running ===");
{
  const bus = new EventEmitter();
  bus.once("boot", () => {
    console.log("  boot handler, listenerCount now:", bus.listenerCount("boot"));
    // Already 0 — removal happens first. That means a `once` handler that
    // re-emits the same event will NOT re-enter itself. Deliberate design.
    bus.emit("boot");
  });
  bus.emit("boot");
  console.log("  emitted twice, handled once ✓");
}

console.log("\n=== 6. Removal is by FUNCTION IDENTITY ===");
{
  const bus = new EventEmitter();

  bus.on("tick", () => console.log("  anonymous"));
  bus.off("tick", () => console.log("  anonymous")); // a DIFFERENT function object
  console.log("  after off() with a fresh arrow:", bus.listenerCount("tick"), "(still 1 — nothing removed)");

  const handler = () => console.log("  named");
  bus.on("tick", handler);
  bus.off("tick", handler); // same reference → removed
  console.log("  after off() with the same reference:", bus.listenerCount("tick"));

  bus.removeAllListeners("tick");
  console.log("  after removeAllListeners:", bus.listenerCount("tick"));
  // Careful: removeAllListeners() with NO event name also removes your
  // 'error' handler, which re-arms the crash-on-error behaviour (see 02).

  // Bound methods are a classic trap: `this.handle.bind(this)` creates a NEW
  // function every call, so you can never remove it. Bind once and store it.
}

console.log("\n=== 7. Mutating listeners during emit ===");
{
  const bus = new EventEmitter();
  const b = () => console.log("  B (should NOT run — removed by A)");
  bus.on("go", () => {
    console.log("  A");
    bus.off("go", b);
  });
  bus.on("go", b);
  bus.emit("go");
  console.log("  → emit() snapshots the listener array, but `once`/`off` still");
  console.log("    take effect for the CURRENT emit in recent Node. Don't rely");
  console.log("    on either behaviour; it's a code smell either way.");
}

console.log("\n=== 8. Introspection ===");
{
  const bus = new EventEmitter();
  bus.on("a", () => {});
  bus.on("a", () => {});
  bus.once("b", () => {});
  console.log("  eventNames():   ", bus.eventNames());
  console.log("  listenerCount(a):", bus.listenerCount("a"));
  console.log("  rawListeners(b) length:", bus.rawListeners("b").length);
  // rawListeners() gives you the WRAPPER for once() handlers; listeners()
  // unwraps to the original function. Matters when writing test helpers.
}

console.log("\n=== 9. Composition beats inheritance ===");
{
  // `class X extends EventEmitter` is idiomatic Node, but it leaks the whole
  // emitter API (emit, removeAllListeners, setMaxListeners) to your callers —
  // meaning anyone can forge your events. Holding one privately is safer:
  class Job {
    readonly #bus = new EventEmitter();
    on(event: "done", fn: (ms: number) => void): this {
      this.#bus.on(event, fn);
      return this;
    }
    run(): void {
      const t0 = performance.now();
      // ...work...
      this.#bus.emit("done", performance.now() - t0);
    }
  }
  new Job().on("done", (ms) => console.log(`  job done in ${ms.toFixed(3)}ms`)).run();
  // Callers can subscribe; they cannot emit. Note `on` is fully typed here.
}
