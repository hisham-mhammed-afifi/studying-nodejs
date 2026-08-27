/**
 *   node --test "src/03-event-emitter/*.test.ts"
 *   IMPL=solution node --test "src/03-event-emitter/*.test.ts"
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import type { EventMap, SubscribeOptions } from "./exercise.ts";

const modulePath = process.env["IMPL"] === "solution" ? "./solution.ts" : "./exercise.ts";

interface Events extends EventMap {
  ping: [n: number];
  message: [text: string, from: string];
  empty: [];
  other: [flag: boolean];
}

interface Bus {
  on(event: string, listener: (...a: never[]) => void, opts?: SubscribeOptions): Bus;
  once(event: string, listener: (...a: never[]) => void, opts?: SubscribeOptions): Bus;
  off(event: string, listener: (...a: never[]) => void): Bus;
  emit(event: string, ...args: never[]): boolean;
  listenerCount(event: string): number;
  eventNames(): string[];
  clear(event?: string): void;
}

type Impl = {
  TypedBus: new <E extends EventMap>() => Bus;
  waitFor(bus: Bus, event: string, signal?: AbortSignal): Promise<unknown[]>;
  waitForAny(bus: Bus, events: readonly string[], signal?: AbortSignal): Promise<{ event: string; args: unknown[] }>;
  pipe(source: Bus, dest: Bus, events: readonly string[], signal?: AbortSignal): () => void;
};

let impl: Impl;
let make: () => Bus;
before(async () => {
  impl = (await import(modulePath)) as unknown as Impl;
  make = () => new impl.TypedBus<Events>();
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("TypedBus — dispatch", () => {
  it("calls listeners synchronously with the right args", () => {
    const bus = make();
    const seen: unknown[][] = [];
    bus.on("message", ((...a: unknown[]) => seen.push(a)) as never);
    bus.emit("message", ...(["hi", "alice"] as never[]));
    assert.deepEqual(seen, [["hi", "alice"]], "emit must be synchronous");
  });

  it("emit returns false with no listeners, true with some", () => {
    const bus = make();
    assert.equal(bus.emit("ping", ...([1] as never[])), false);
    bus.on("ping", (() => {}) as never);
    assert.equal(bus.emit("ping", ...([1] as never[])), true);
  });

  it("runs listeners in registration order", () => {
    const bus = make();
    const order: string[] = [];
    bus.on("ping", (() => order.push("a")) as never);
    bus.on("ping", (() => order.push("b")) as never);
    bus.on("ping", (() => order.push("c")) as never);
    bus.emit("ping", ...([1] as never[]));
    assert.deepEqual(order, ["a", "b", "c"]);
  });

  it("prepend puts a listener first", () => {
    const bus = make();
    const order: string[] = [];
    bus.on("ping", (() => order.push("a")) as never);
    bus.on("ping", (() => order.push("first")) as never, { prepend: true });
    bus.emit("ping", ...([1] as never[]));
    assert.deepEqual(order, ["first", "a"]);
  });

  it("supports zero-argument events", () => {
    const bus = make();
    let called = 0;
    bus.on("empty", (() => called++) as never);
    bus.emit("empty");
    assert.equal(called, 1);
  });
});

describe("TypedBus — once", () => {
  it("fires exactly once", () => {
    const bus = make();
    let n = 0;
    bus.once("ping", (() => n++) as never);
    bus.emit("ping", ...([1] as never[]));
    bus.emit("ping", ...([2] as never[]));
    assert.equal(n, 1);
    assert.equal(bus.listenerCount("ping"), 0);
  });

  it("removes itself BEFORE invoking (no self re-entry)", () => {
    const bus = make();
    let n = 0;
    bus.once("ping", (() => {
      n++;
      if (n < 5) bus.emit("ping", ...([n] as never[])); // must not re-enter itself
    }) as never);
    bus.emit("ping", ...([0] as never[]));
    assert.equal(n, 1, "once() listener re-entered itself");
  });

  it("off() removes a once listener by its ORIGINAL function", () => {
    const bus = make();
    const fn = (() => assert.fail("should never run")) as never;
    bus.once("ping", fn);
    bus.off("ping", fn);
    assert.equal(bus.listenerCount("ping"), 0);
    bus.emit("ping", ...([1] as never[]));
  });
});

describe("TypedBus — removal", () => {
  it("off matches by identity", () => {
    const bus = make();
    const fn = (() => {}) as never;
    bus.on("ping", fn);
    bus.off("ping", (() => {}) as never); // different function object
    assert.equal(bus.listenerCount("ping"), 1);
    bus.off("ping", fn);
    assert.equal(bus.listenerCount("ping"), 0);
  });

  it("off on an unknown event is a no-op", () => {
    const bus = make();
    bus.off("ping", (() => {}) as never);
    assert.equal(bus.listenerCount("ping"), 0);
  });

  it("removes only ONE registration of a duplicated listener", () => {
    const bus = make();
    const fn = (() => {}) as never;
    bus.on("ping", fn);
    bus.on("ping", fn);
    bus.off("ping", fn);
    assert.equal(bus.listenerCount("ping"), 1);
  });

  it("clear(event) and clear() work", () => {
    const bus = make();
    bus.on("ping", (() => {}) as never);
    bus.on("other", (() => {}) as never);
    bus.clear("ping");
    assert.equal(bus.listenerCount("ping"), 0);
    assert.equal(bus.listenerCount("other"), 1);
    bus.clear();
    assert.deepEqual(bus.eventNames(), []);
  });

  it("does not retain empty event entries", () => {
    const bus = make();
    const fn = (() => {}) as never;
    bus.on("ping", fn);
    assert.deepEqual(bus.eventNames(), ["ping"]);
    bus.off("ping", fn);
    assert.deepEqual(bus.eventNames(), [], "empty event key was not cleaned up");
  });
});

describe("TypedBus — mutation during dispatch", () => {
  it("a listener added during emit does not run in that emit", () => {
    const bus = make();
    const order: string[] = [];
    bus.on("ping", (() => {
      order.push("a");
      bus.on("ping", (() => order.push("late")) as never);
    }) as never);
    bus.emit("ping", ...([1] as never[]));
    assert.deepEqual(order, ["a"]);
    bus.emit("ping", ...([2] as never[]));
    assert.deepEqual(order, ["a", "a", "late"]);
  });

  it("removing a later listener during emit does not skip anyone", () => {
    const bus = make();
    const order: string[] = [];
    const b = (() => order.push("b")) as never;
    bus.on("ping", (() => {
      order.push("a");
      bus.off("ping", b);
    }) as never);
    bus.on("ping", b);
    bus.on("ping", (() => order.push("c")) as never);
    bus.emit("ping", ...([1] as never[]));
    // Snapshot semantics: b was already scheduled for this dispatch.
    assert.deepEqual(order, ["a", "b", "c"]);
    assert.equal(bus.listenerCount("ping"), 2);
  });
});

describe("TypedBus — throwing listeners", () => {
  it("still runs the remaining listeners, then throws", () => {
    const bus = make();
    let ran = false;
    bus.on("ping", (() => {
      throw new Error("boom");
    }) as never);
    bus.on("ping", (() => {
      ran = true;
    }) as never);
    assert.throws(() => bus.emit("ping", ...([1] as never[])), /boom/);
    assert.equal(ran, true, "a throwing listener must not block the others");
  });

  it("aggregates multiple errors", () => {
    const bus = make();
    bus.on("ping", (() => {
      throw new Error("one");
    }) as never);
    bus.on("ping", (() => {
      throw new Error("two");
    }) as never);
    assert.throws(
      () => bus.emit("ping", ...([1] as never[])),
      (err: unknown) => err instanceof AggregateError && err.errors.length === 2,
    );
  });
});

describe("TypedBus — AbortSignal", () => {
  it("removes the listener on abort", () => {
    const bus = make();
    const ac = new AbortController();
    bus.on("ping", (() => assert.fail("should not run")) as never, { signal: ac.signal });
    assert.equal(bus.listenerCount("ping"), 1);
    ac.abort();
    assert.equal(bus.listenerCount("ping"), 0);
    bus.emit("ping", ...([1] as never[]));
  });

  it("never registers with an already-aborted signal", () => {
    const bus = make();
    bus.on("ping", (() => assert.fail("should not run")) as never, { signal: AbortSignal.abort() });
    assert.equal(bus.listenerCount("ping"), 0);
    bus.emit("ping", ...([1] as never[]));
  });

  it("one signal tears down many listeners across events", () => {
    const bus = make();
    const ac = new AbortController();
    for (let i = 0; i < 20; i++) {
      bus.on("ping", (() => {}) as never, { signal: ac.signal });
      bus.on("other", (() => {}) as never, { signal: ac.signal });
    }
    assert.equal(bus.listenerCount("ping"), 20);
    ac.abort();
    assert.deepEqual(bus.eventNames(), []);
  });
});

describe("waitFor", () => {
  it("resolves with the argument tuple", async () => {
    const bus = make();
    setTimeout(() => bus.emit("message", ...(["hello", "bob"] as never[])), 10);
    assert.deepEqual(await impl.waitFor(bus, "message"), ["hello", "bob"]);
  });

  it("resolves for a zero-arg event", async () => {
    const bus = make();
    setTimeout(() => bus.emit("empty"), 10);
    assert.deepEqual(await impl.waitFor(bus, "empty"), []);
  });

  it("leaves no listener behind on success", async () => {
    const bus = make();
    setTimeout(() => bus.emit("ping", ...([1] as never[])), 10);
    await impl.waitFor(bus, "ping");
    assert.equal(bus.listenerCount("ping"), 0);
  });

  it("rejects with the signal's reason", async () => {
    const bus = make();
    const ac = new AbortController();
    setTimeout(() => ac.abort(new Error("cancelled by user")), 10);
    await assert.rejects(() => impl.waitFor(bus, "ping", ac.signal), /cancelled by user/);
  });

  it("leaves no listener behind on abort", async () => {
    const bus = make();
    const ac = new AbortController();
    const p = impl.waitFor(bus, "ping", ac.signal);
    ac.abort(new Error("stop"));
    await assert.rejects(() => p);
    assert.equal(bus.listenerCount("ping"), 0);
  });

  it("rejects immediately for an already-aborted signal", async () => {
    const bus = make();
    await assert.rejects(() => impl.waitFor(bus, "ping", AbortSignal.abort(new Error("nope"))), /nope/);
    assert.equal(bus.listenerCount("ping"), 0);
  });

  it("works with AbortSignal.timeout", async () => {
    const bus = make();
    // AbortSignal.timeout's internal timer is UNREF'd, so on its own it will
    // not keep the loop alive. A ref'd keepalive makes this deterministic.
    const keepalive = setInterval(() => {}, 100);
    try {
      await assert.rejects(() => impl.waitFor(bus, "ping", AbortSignal.timeout(20)));
      assert.equal(bus.listenerCount("ping"), 0);
    } finally {
      clearInterval(keepalive);
    }
  });

  it("does not accumulate listeners across many calls", async () => {
    const bus = make();
    for (let i = 0; i < 50; i++) {
      const ac = new AbortController();
      const p = impl.waitFor(bus, "ping", ac.signal);
      setTimeout(() => ac.abort(new Error("timeout")), 1);
      await assert.rejects(() => p);
    }
    assert.equal(bus.listenerCount("ping"), 0);
  });
});

describe("waitForAny", () => {
  it("resolves with the winning event and its args", async () => {
    const bus = make();
    setTimeout(() => bus.emit("other", ...([true] as never[])), 10);
    const result = await impl.waitForAny(bus, ["ping", "other", "empty"]);
    assert.equal(result.event, "other");
    assert.deepEqual(result.args, [true]);
  });

  it("cleans up the LOSERS too", async () => {
    const bus = make();
    setTimeout(() => bus.emit("ping", ...([1] as never[])), 10);
    await impl.waitForAny(bus, ["ping", "other", "empty"]);
    assert.equal(bus.listenerCount("ping"), 0);
    assert.equal(bus.listenerCount("other"), 0, "losing listeners were left attached");
    assert.deepEqual(bus.eventNames(), []);
  });

  it("honours an abort signal and cleans up", async () => {
    const bus = make();
    const ac = new AbortController();
    setTimeout(() => ac.abort(new Error("give up")), 10);
    await assert.rejects(() => impl.waitForAny(bus, ["ping", "other"], ac.signal), /give up/);
    assert.deepEqual(bus.eventNames(), []);
  });
});

describe("pipe", () => {
  it("forwards the listed events with their args", () => {
    const src = make();
    const dst = make();
    const seen: unknown[][] = [];
    dst.on("message", ((...a: unknown[]) => seen.push(a)) as never);
    impl.pipe(src, dst, ["message"]);
    src.emit("message", ...(["hi", "carol"] as never[]));
    assert.deepEqual(seen, [["hi", "carol"]]);
  });

  it("does not forward unlisted events", () => {
    const src = make();
    const dst = make();
    let n = 0;
    dst.on("ping", (() => n++) as never);
    impl.pipe(src, dst, ["message"]);
    src.emit("ping", ...([1] as never[]));
    assert.equal(n, 0);
  });

  it("the returned function unwires, and is idempotent", () => {
    const src = make();
    const dst = make();
    let n = 0;
    dst.on("ping", (() => n++) as never);
    const unpipe = impl.pipe(src, dst, ["ping"]);
    src.emit("ping", ...([1] as never[]));
    unpipe();
    unpipe();
    src.emit("ping", ...([2] as never[]));
    assert.equal(n, 1);
    assert.deepEqual(src.eventNames(), []);
  });

  it("honours an abort signal", async () => {
    const src = make();
    const dst = make();
    let n = 0;
    dst.on("ping", (() => n++) as never);
    const ac = new AbortController();
    impl.pipe(src, dst, ["ping"], ac.signal);
    src.emit("ping", ...([1] as never[]));
    ac.abort();
    await sleep(0);
    src.emit("ping", ...([2] as never[]));
    assert.equal(n, 1);
  });

  it("refuses to pipe a bus to itself", () => {
    const bus = make();
    assert.throws(() => impl.pipe(bus, bus, ["ping"]), RangeError);
  });
});
