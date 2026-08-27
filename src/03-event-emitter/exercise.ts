/**
 * EXERCISE 03 — A production-shaped typed event bus
 *
 * Check yourself:  node --test "src/03-event-emitter/*.test.ts"
 * Solution:        ./solution.ts   (try first!)
 */

/** Map of event name → the tuple of arguments that event carries. */
export type EventMap = Record<string, unknown[]>;

export interface SubscribeOptions {
  /** Removes the listener automatically when the signal aborts. */
  signal?: AbortSignal;
  /** Run before listeners registered earlier. */
  prepend?: boolean;
}

const TODO = (what: string): never => {
  throw new Error(`TODO: implement ${what}`);
};

/**
 * TASK 1 — Implement `TypedBus`.
 *
 * You may wrap node:events, or implement dispatch yourself with a Map — both
 * are fine, and doing it by hand is the more instructive option.
 *
 * Requirements:
 *   - `emit` is SYNCHRONOUS and returns true iff at least one listener ran.
 *   - Listeners run in registration order; `prepend: true` puts one at the front.
 *   - `once` removes the listener BEFORE invoking it.
 *   - `off` matches by function identity, and must also remove a `once`
 *     listener when given the ORIGINAL function (not the internal wrapper).
 *   - `{ signal }` removes the listener on abort. An ALREADY-aborted signal
 *     means the listener is never registered at all.
 *   - Adding or removing listeners from inside a listener must not disturb the
 *     dispatch in progress (snapshot before iterating).
 *   - A throwing listener must NOT prevent the remaining listeners from
 *     running. Collect the errors; after dispatch, throw the single error, or
 *     an `AggregateError` if there was more than one.
 *   - No unbounded growth: an event whose last listener is removed must not
 *     retain an entry (check with `eventNames()`).
 */
export class TypedBus<E extends EventMap> {
  on<K extends keyof E & string>(_event: K, _listener: (...args: E[K]) => void, _opts?: SubscribeOptions): this {
    return TODO("TypedBus#on");
  }

  once<K extends keyof E & string>(_event: K, _listener: (...args: E[K]) => void, _opts?: SubscribeOptions): this {
    return TODO("TypedBus#once");
  }

  off<K extends keyof E & string>(_event: K, _listener: (...args: E[K]) => void): this {
    return TODO("TypedBus#off");
  }

  emit<K extends keyof E & string>(_event: K, ..._args: E[K]): boolean {
    return TODO("TypedBus#emit");
  }

  listenerCount<K extends keyof E & string>(_event: K): number {
    return TODO("TypedBus#listenerCount");
  }

  eventNames(): Array<keyof E & string> {
    return TODO("TypedBus#eventNames");
  }

  /** Remove every listener for one event, or for all events if omitted. */
  clear<K extends keyof E & string>(_event?: K): void {
    return TODO("TypedBus#clear");
  }
}

/**
 * TASK 2 — `waitFor`: promise for the next emission.
 *
 * Requirements:
 *   - Resolves with the full argument tuple.
 *   - `signal` aborts → reject with the signal's `reason`.
 *   - An already-aborted signal rejects immediately, without subscribing.
 *   - Must NOT leak: once it settles, `listenerCount` is back where it started
 *     AND the listener on the signal is detached too.
 */
export function waitFor<E extends EventMap, K extends keyof E & string>(
  _bus: TypedBus<E>,
  _event: K,
  _signal?: AbortSignal,
): Promise<E[K]> {
  return TODO("waitFor");
}

/**
 * TASK 3 — `waitForAny`: race several events on one bus.
 *
 * Resolves with `{ event, args }` for whichever fires first, and cleans up the
 * listeners for ALL of them — including the losers. (See 04-async-bridge.ts
 * section 5; forgetting the losers is the leak nearly everyone ships.)
 */
export function waitForAny<E extends EventMap, K extends keyof E & string>(
  _bus: TypedBus<E>,
  _events: readonly K[],
  _signal?: AbortSignal,
): Promise<{ event: K; args: E[K] }> {
  return TODO("waitForAny");
}

/**
 * TASK 4 — `pipe`: forward events from one bus to another.
 *
 * Forwards each named event from `source` to `dest` unchanged. Returns a
 * function that undoes the wiring; calling it twice must be harmless.
 * Honour `signal` too, if given.
 *
 * Think about: what should happen if someone pipes a bus to itself?
 */
export function pipe<E extends EventMap, K extends keyof E & string>(
  _source: TypedBus<E>,
  _dest: TypedBus<E>,
  _events: readonly K[],
  _signal?: AbortSignal,
): () => void {
  return TODO("pipe");
}
