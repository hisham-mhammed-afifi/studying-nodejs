/**
 * 03 — Making EventEmitter type-safe
 *
 * Run:  node src/03-event-emitter/03-typed-emitter.ts
 *
 * The built-in signatures are `on(event: string | symbol, listener: (...args: any[]) => void)`.
 * Every event name is valid, every payload is `any`. This file fixes that with
 * ZERO runtime cost — it's all in the type layer.
 */

import { EventEmitter } from "node:events";

console.log("=== The problem ===");
{
  const bus = new EventEmitter();
  bus.on("user:created", (id: number) => console.log("  id +1 =", id + 1));
  // Every one of these compiles fine, and every one is a bug:
  bus.emit("user:crated", 1); // typo in the event name → silently never fires
  bus.emit("user:created", "not-a-number"); // wrong payload type → "1not-a-number" at runtime
  bus.emit("user:created"); // missing payload → NaN
  console.log("  (all three of those compiled and 'worked')");
}

// ─────────────────────────────────────────────────────────────────────────────
// The fix: an event map + a generic subclass.
// ─────────────────────────────────────────────────────────────────────────────

/** Map event name → the tuple of arguments it carries. */
type EventMap = Record<string, unknown[]>;

export class TypedEmitter<E extends EventMap> {
  // Composition, not inheritance: callers get exactly the API below and cannot
  // reach the untyped EventEmitter surface underneath.
  readonly #inner = new EventEmitter({ captureRejections: true });

  constructor() {
    // Without this, an emitted 'error' with no listener kills the process.
    // Give it a harmless default; real subscribers can still add their own.
    this.#inner.on("error", () => {});
  }

  on<K extends keyof E & string>(event: K, listener: (...args: E[K]) => void): this {
    this.#inner.on(event, listener as (...args: unknown[]) => void);
    return this;
  }

  once<K extends keyof E & string>(event: K, listener: (...args: E[K]) => void): this {
    this.#inner.once(event, listener as (...args: unknown[]) => void);
    return this;
  }

  off<K extends keyof E & string>(event: K, listener: (...args: E[K]) => void): this {
    this.#inner.off(event, listener as (...args: unknown[]) => void);
    return this;
  }

  emit<K extends keyof E & string>(event: K, ...args: E[K]): boolean {
    return this.#inner.emit(event, ...args);
  }

  listenerCount<K extends keyof E & string>(event: K): number {
    return this.#inner.listenerCount(event);
  }

  /** Promise for the next emission of `event`. Rejects if `signal` aborts. */
  waitFor<K extends keyof E & string>(event: K, signal?: AbortSignal): Promise<E[K]> {
    return new Promise((resolve, reject) => {
      const onEvent = (...args: unknown[]) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(args as E[K]);
      };
      const onAbort = () => {
        this.#inner.off(event, onEvent);
        reject(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
      };
      this.#inner.once(event, onEvent);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────

// NOTE: `type`, not `interface`. A type alias gets an implicit index signature,
// so it satisfies `Record<string, unknown[]>`; an interface does not, and you
// get "Index signature for type 'string' is missing". A real TypeScript gotcha
// that bites everyone the first time they write a constraint like this.
// (An interface works if you declare it as `interface JobEvents extends EventMap`.)
type JobEvents = {
  // Each key is an event; the value is the ARGUMENT TUPLE, not a single type.
  progress: [percent: number, label: string];
  done: [result: { rows: number }];
  failed: [error: Error];
  // Zero-argument events are an empty tuple.
  cancelled: [];
};

console.log("\n=== The fix in use ===");
{
  const jobs = new TypedEmitter<JobEvents>();

  // Parameter types are INFERRED — no annotations needed, and the names from
  // the labelled tuple show up in editor tooltips.
  jobs.on("progress", (percent, label) => {
    console.log(`  ${label}: ${percent.toFixed(0)}%`); // percent is number
  });
  jobs.on("done", (result) => console.log("  done,", result.rows, "rows"));
  jobs.on("cancelled", () => console.log("  cancelled"));

  jobs.emit("progress", 42.5, "extracting");
  jobs.emit("done", { rows: 1200 });
  jobs.emit("cancelled");

  // Every one of these is now a COMPILE ERROR. Uncomment to see:
  //
  // jobs.emit("progres", 50, "typo");           // ✗ not assignable to keyof JobEvents
  // jobs.emit("progress", "50", "wrong type");  // ✗ string not assignable to number
  // jobs.emit("progress", 50);                  // ✗ expected 2 arguments, got 1
  // jobs.emit("done", { rows: "many" });        // ✗ string not assignable to number
  // jobs.on("done", (r) => r.nope);             // ✗ property 'nope' does not exist
}

console.log("\n=== waitFor: bridging to async/await ===");
{
  const jobs = new TypedEmitter<JobEvents>();
  setTimeout(() => jobs.emit("done", { rows: 7 }), 20);

  // Destructuring the tuple; `result` is typed as { rows: number }.
  const [result] = await jobs.waitFor("done");
  console.log("  awaited result:", result);

  // With a timeout, via AbortSignal.
  const ac = new AbortController();
  setTimeout(() => ac.abort(new Error("timed out after 30ms")), 30);
  try {
    await jobs.waitFor("done", ac.signal);
  } catch (err) {
    console.log("  aborted:", (err as Error).message);
  }
}

console.log(`
=== Notes ===

  • This is a zero-cost abstraction: all the generics erase, and the runtime
    behaviour is plain EventEmitter.
  • The alternative is declaration merging on a subclass (overloading on/emit
    with a union of signatures). It works, but scales badly — you write every
    signature twice, once for on and once for emit.
  • If your emitter has a FIXED set of subscribers, consider not using an
    emitter at all. A callbacks object —
        { onProgress(p, l) {...}, onDone(r) {...}, onFailed(e) {...} }
    — is type-safe for free, forces you to handle every case, and makes the
    control flow readable. Emitters earn their keep when N is unknown.
  • Node core's own emitters (Socket, Server, Readable) DO ship typed overloads
    via @types/node, so you get autocompletion on \`socket.on("data", ...)\`.
    You only need this pattern for your own emitters.
`);
