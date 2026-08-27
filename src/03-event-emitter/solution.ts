/**
 * SOLUTION 03 — reference implementation, hand-rolled dispatch.
 */

import type { EventMap, SubscribeOptions } from "./exercise.ts";

// Internally we erase the payload types. `unknown[]` would be more virtuous,
// but a listener typed `(...args: E[K]) => void` is not assignable to one
// typed `(...args: unknown[]) => void` (parameters are contravariant), so
// every call site would need a double cast through `unknown`. Erasing once,
// here, keeps the casts in one place — and the PUBLIC API below stays fully
// typed, which is the part that matters.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyListener = (...args: any[]) => void;

interface Entry {
  /** The function the caller gave us — what `off()` is matched against. */
  original: AnyListener;
  /** What we actually invoke (a self-removing wrapper for `once`). */
  invoke: AnyListener;
  /** Detaches the abort listener, if this entry was registered with a signal. */
  cleanup?: () => void;
}

export class TypedBus<E extends EventMap> {
  // A Map keyed by event name. Entries are deleted when their array empties,
  // so a bus that sees many one-off event names doesn't grow forever.
  readonly #events = new Map<string, Entry[]>();

  #add(event: string, entry: Entry, opts: SubscribeOptions | undefined): this {
    // An already-aborted signal means "don't bother" — subscribing and then
    // immediately unsubscribing is observably different if the event fires
    // synchronously in between.
    if (opts?.signal?.aborted) return this;

    const list = this.#events.get(event) ?? [];
    if (opts?.prepend) list.unshift(entry);
    else list.push(entry);
    this.#events.set(event, list);

    if (opts?.signal) {
      const signal = opts.signal;
      const onAbort = () => this.#remove(event, entry.original);
      // { once: true } so the abort listener itself doesn't accumulate.
      signal.addEventListener("abort", onAbort, { once: true });
      entry.cleanup = () => signal.removeEventListener("abort", onAbort);
    }
    return this;
  }

  #remove(event: string, original: AnyListener): void {
    const list = this.#events.get(event);
    if (!list) return;
    const i = list.findIndex((e) => e.original === original);
    if (i === -1) return;
    // Non-null assertion avoided: we just found the index.
    const [entry] = list.splice(i, 1);
    entry?.cleanup?.();
    // Drop the key entirely when empty — this is what keeps eventNames() honest
    // and stops the Map growing without bound.
    if (list.length === 0) this.#events.delete(event);
  }

  on<K extends keyof E & string>(event: K, listener: (...args: E[K]) => void, opts?: SubscribeOptions): this {
    const fn = listener as AnyListener;
    return this.#add(event, { original: fn, invoke: fn }, opts);
  }

  once<K extends keyof E & string>(event: K, listener: (...args: E[K]) => void, opts?: SubscribeOptions): this {
    const fn = listener as AnyListener;
    const wrapper = ((...args: unknown[]) => {
      // Remove FIRST, then invoke. If the listener re-emits the same event, it
      // must not re-enter itself — that's the documented EventEmitter contract
      // and it prevents a whole class of accidental infinite recursion.
      this.#remove(event, fn);
      fn(...args);
    }) as AnyListener;
    return this.#add(event, { original: fn, invoke: wrapper }, opts);
  }

  off<K extends keyof E & string>(event: K, listener: (...args: E[K]) => void): this {
    // Matching on `original` is why the Entry indirection exists: callers hold
    // the function they passed in, not our once() wrapper.
    this.#remove(event, listener as AnyListener);
    return this;
  }

  emit<K extends keyof E & string>(event: K, ...args: E[K]): boolean {
    const list = this.#events.get(event);
    if (!list || list.length === 0) return false;

    // SNAPSHOT. A listener may call on()/off()/clear() while we iterate; without
    // a copy we'd skip listeners or read past the end of a mutating array.
    const snapshot = list.slice();

    let errors: unknown[] | undefined;
    for (const entry of snapshot) {
      try {
        entry.invoke(...args);
      } catch (err) {
        // Node's EventEmitter lets the first throw abort the rest. That means
        // one buggy subscriber silently disables every subscriber after it —
        // so here we isolate them and report afterwards instead.
        (errors ??= []).push(err);
      }
    }

    if (errors) {
      if (errors.length === 1) throw errors[0];
      throw new AggregateError(errors, `${errors.length} listeners for "${event}" threw`);
    }
    return true;
  }

  listenerCount<K extends keyof E & string>(event: K): number {
    return this.#events.get(event)?.length ?? 0;
  }

  eventNames(): Array<keyof E & string> {
    return [...this.#events.keys()] as Array<keyof E & string>;
  }

  clear<K extends keyof E & string>(event?: K): void {
    if (event === undefined) {
      for (const list of this.#events.values()) for (const e of list) e.cleanup?.();
      this.#events.clear();
      return;
    }
    for (const e of this.#events.get(event) ?? []) e.cleanup?.();
    this.#events.delete(event);
  }
}

// --- Task 2 ------------------------------------------------------------------

/** Normalises a signal's `reason` (which is `any`) into an Error. */
function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  const err = new Error(typeof reason === "string" ? reason : "The operation was aborted");
  err.name = "AbortError";
  return err;
}

export function waitFor<E extends EventMap, K extends keyof E & string>(
  bus: TypedBus<E>,
  event: K,
  signal?: AbortSignal,
): Promise<E[K]> {
  // Reject before subscribing — otherwise a synchronous emit between the
  // subscribe and the abort check would resolve a promise the caller cancelled.
  if (signal?.aborted) return Promise.reject(abortError(signal));

  return new Promise<E[K]>((resolve, reject) => {
    // Both paths must run `cleanup`. This is the whole point of the exercise:
    // a promise that settles but leaves its listener attached is a leak that
    // only shows up under load, hours later.
    const cleanup = () => {
      bus.off(event, onEvent);
      signal?.removeEventListener("abort", onAbort);
    };
    const onEvent = (...args: E[K]) => {
      cleanup();
      resolve(args);
    };
    const onAbort = () => {
      cleanup();
      reject(abortError(signal as AbortSignal));
    };

    bus.on(event, onEvent);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// --- Task 3 ------------------------------------------------------------------

export function waitForAny<E extends EventMap, K extends keyof E & string>(
  bus: TypedBus<E>,
  events: readonly K[],
  signal?: AbortSignal,
): Promise<{ event: K; args: E[K] }> {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  if (events.length === 0) return Promise.reject(new RangeError("events must not be empty"));

  return new Promise((resolve, reject) => {
    // One cleanup that detaches EVERY listener, not just the winner's.
    // Promise.race would settle correctly but leave the losers subscribed —
    // on a long-lived bus that's an unbounded leak.
    const handlers = new Map<K, (...args: E[K]) => void>();
    const cleanup = () => {
      for (const [event, handler] of handlers) bus.off(event, handler);
      handlers.clear();
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(abortError(signal as AbortSignal));
    };

    for (const event of events) {
      const handler = (...args: E[K]) => {
        cleanup();
        resolve({ event, args });
      };
      handlers.set(event, handler);
      bus.on(event, handler);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// --- Task 4 ------------------------------------------------------------------

export function pipe<E extends EventMap, K extends keyof E & string>(
  source: TypedBus<E>,
  dest: TypedBus<E>,
  events: readonly K[],
  signal?: AbortSignal,
): () => void {
  // Self-piping would make every emit re-enter itself forever. Fail loudly
  // rather than blowing the stack at 3am.
  if (source === dest) throw new RangeError("cannot pipe a bus to itself");

  const wires: Array<[K, (...args: E[K]) => void]> = [];
  for (const event of events) {
    const forward = (...args: E[K]) => {
      dest.emit(event, ...args);
    };
    source.on(event, forward, signal ? { signal } : undefined);
    wires.push([event, forward]);
  }

  let undone = false;
  return () => {
    // Idempotent: teardown functions get called from `finally` blocks, error
    // paths, and shutdown hooks — often more than once.
    if (undone) return;
    undone = true;
    for (const [event, forward] of wires) source.off(event, forward);
    wires.length = 0;
  };
}
