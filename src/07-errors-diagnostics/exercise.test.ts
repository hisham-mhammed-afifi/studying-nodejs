/**
 *   node scripts/test.ts 07
 *   node scripts/test.ts --solutions 07
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";

import type { AppErrorOptions, RetryOptions, Store } from "./exercise.ts";

const modulePath = process.env["IMPL"] === "solution" ? "./solution.ts" : "./exercise.ts";

interface AppErrorLike extends Error {
  code: string;
  statusCode: number;
  details: Record<string, unknown>;
  isOperational: boolean;
  toJSON(): Record<string, unknown>;
  toResponse(): { code: string; message: string };
}

type Impl = {
  AppError: new (message: string, options: AppErrorOptions) => AppErrorLike;
  NotFoundError: new (resource: string, id: string, cause?: unknown) => AppErrorLike;
  ValidationError: new (field: string, reason: string, cause?: unknown) => AppErrorLike;
  UpstreamError: new (service: string, cause?: unknown) => AppErrorLike;
  causeChain(err: unknown): Generator<Error>;
  rootCause(err: unknown): Error | undefined;
  findCause(err: unknown, predicate: (e: Error) => boolean): Error | undefined;
  serializeError(err: unknown): Record<string, unknown>;
  withRetry<T>(fn: (attempt: number) => Promise<T>, options?: RetryOptions): Promise<T>;
  RequestContext: new () => {
    run<T>(store: Store, fn: () => T | Promise<T>): Promise<T>;
    get(): Store | undefined;
    require(): Store;
    extend<T>(patch: Partial<Store>, fn: () => T | Promise<T>): Promise<T>;
    bind<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R;
  };
};

let impl: Impl;
before(async () => {
  impl = (await import(modulePath)) as unknown as Impl;
});

describe("AppError", () => {
  it("carries code, statusCode, details and isOperational", () => {
    const err = new impl.AppError("boom", { code: "E_TEST", statusCode: 418, details: { a: 1 } });
    assert.equal(err.code, "E_TEST");
    assert.equal(err.statusCode, 418);
    assert.deepEqual(err.details, { a: 1 });
    assert.equal(err.isOperational, true);
    assert.equal(err.message, "boom");
  });

  it("defaults statusCode to 500 and details to {}", () => {
    const err = new impl.AppError("boom", { code: "E" });
    assert.equal(err.statusCode, 500);
    assert.deepEqual(err.details, {});
  });

  it("is an instanceof Error", () => {
    assert.ok(new impl.AppError("x", { code: "E" }) instanceof Error);
  });

  it("passes cause through", () => {
    const cause = new Error("root");
    assert.equal(new impl.AppError("x", { code: "E", cause }).cause, cause);
  });

  it("name is the SUBCLASS name, not 'AppError'", () => {
    assert.equal(new impl.AppError("x", { code: "E" }).name, "AppError");
    assert.equal(new impl.NotFoundError("user", "42").name, "NotFoundError");
    assert.equal(new impl.ValidationError("email", "bad").name, "ValidationError");
    assert.equal(new impl.UpstreamError("payments").name, "UpstreamError");
  });

  it("stack starts at the caller, not inside the constructor", () => {
    function throwIt() {
      throw new impl.NotFoundError("user", "42");
    }
    try {
      throwIt();
      assert.fail("should have thrown");
    } catch (err) {
      const top = ((err as Error).stack ?? "").split("\n")[1] ?? "";
      assert.ok(top.includes("throwIt"), `stack should start at throwIt, got: ${top}`);
      assert.ok(!top.includes("new NotFoundError"), "constructor frames were not stripped");
    }
  });

  it("toJSON includes non-enumerable message and stack", () => {
    const json = new impl.AppError("boom", { code: "E", statusCode: 400, details: { x: 1 } }).toJSON();
    assert.equal(json["message"], "boom", "message is non-enumerable — list it explicitly");
    assert.equal(json["name"], "AppError");
    assert.equal(json["code"], "E");
    assert.equal(json["statusCode"], 400);
    assert.deepEqual(json["details"], { x: 1 });
    assert.equal(typeof json["stack"], "string");
  });

  it("toJSON serialises the cause chain", () => {
    const err = new impl.AppError("outer", {
      code: "E",
      cause: new Error("middle", { cause: new Error("inner") }),
    });
    const json = err.toJSON();
    const cause = json["cause"] as Record<string, unknown>;
    assert.equal(cause["message"], "middle");
    assert.equal((cause["cause"] as Record<string, unknown>)["message"], "inner");
  });

  it("toJSON survives JSON.stringify with real content", () => {
    const out = JSON.parse(JSON.stringify(new impl.AppError("boom", { code: "E" }).toJSON()));
    assert.equal(out.message, "boom", "the classic {} bug");
  });

  it("toResponse leaks nothing internal", () => {
    const err = new impl.AppError("boom", {
      code: "E",
      details: { internalId: "secret-123" },
      cause: new Error("db password is hunter2"),
    });
    const res = err.toResponse();
    assert.deepEqual(res, { code: "E", message: "boom" });
    const serialised = JSON.stringify(res);
    assert.ok(!serialised.includes("secret-123"), "details leaked to the client");
    assert.ok(!serialised.includes("hunter2"), "cause leaked to the client");
    assert.ok(!serialised.includes("stack"), "stack leaked to the client");
  });
});

describe("error subclasses", () => {
  it("NotFoundError", () => {
    const err = new impl.NotFoundError("user", "42");
    assert.equal(err.message, "user 42 not found");
    assert.equal(err.code, "NOT_FOUND");
    assert.equal(err.statusCode, 404);
    assert.deepEqual(err.details, { resource: "user", id: "42" });
  });

  it("ValidationError", () => {
    const err = new impl.ValidationError("email", "must contain @");
    assert.equal(err.message, "invalid email: must contain @");
    assert.equal(err.code, "VALIDATION");
    assert.equal(err.statusCode, 400);
    assert.deepEqual(err.details, { field: "email", reason: "must contain @" });
  });

  it("UpstreamError", () => {
    const err = new impl.UpstreamError("payments");
    assert.equal(err.message, "upstream service payments failed");
    assert.equal(err.code, "UPSTREAM");
    assert.equal(err.statusCode, 502);
    assert.deepEqual(err.details, { service: "payments" });
  });

  it("subclasses are instanceof AppError", () => {
    assert.ok(new impl.NotFoundError("u", "1") instanceof impl.AppError);
    assert.ok(new impl.ValidationError("f", "r") instanceof impl.AppError);
    assert.ok(new impl.UpstreamError("s") instanceof impl.AppError);
  });

  it("subclasses accept a cause", () => {
    const cause = new Error("root");
    assert.equal(new impl.UpstreamError("payments", cause).cause, cause);
  });
});

describe("causeChain / rootCause / findCause", () => {
  const build = () => {
    const inner = new Error("inner");
    const middle = new Error("middle", { cause: inner });
    const outer = new Error("outer", { cause: middle });
    return { inner, middle, outer };
  };

  it("yields outermost first", () => {
    const { outer } = build();
    assert.deepEqual([...impl.causeChain(outer)].map((e) => e.message), ["outer", "middle", "inner"]);
  });

  it("yields a single error with no cause", () => {
    assert.deepEqual([...impl.causeChain(new Error("solo"))].map((e) => e.message), ["solo"]);
  });

  it("yields nothing for a non-Error", () => {
    assert.deepEqual([...impl.causeChain("just a string")], []);
    assert.deepEqual([...impl.causeChain(undefined)], []);
  });

  it("does NOT loop forever on a self-referencing cause", () => {
    const err = new Error("cyclic");
    err.cause = err;
    assert.deepEqual([...impl.causeChain(err)].map((e) => e.message), ["cyclic"]);
  });

  it("does NOT loop forever on a two-node cycle", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    a.cause = b;
    const chain = [...impl.causeChain(b)];
    assert.equal(chain.length, 2, `expected 2 links, got ${chain.length}`);
  });

  it("rootCause returns the deepest error", () => {
    const { outer, inner } = build();
    assert.equal(impl.rootCause(outer), inner);
  });

  it("rootCause of a non-Error is undefined", () => {
    assert.equal(impl.rootCause("nope"), undefined);
  });

  it("findCause finds by predicate", () => {
    const err = new Error("outer", { cause: new impl.UpstreamError("payments") });
    const found = impl.findCause(err, (e) => (e as AppErrorLike).code === "UPSTREAM");
    assert.equal(found?.message, "upstream service payments failed");
  });

  it("findCause returns undefined when nothing matches", () => {
    const { outer } = build();
    assert.equal(impl.findCause(outer, (e) => e.name === "TypeError"), undefined);
  });
});

describe("serializeError", () => {
  it("serialises a plain Error with message and stack", () => {
    const out = impl.serializeError(new Error("boom"));
    assert.equal(out["name"], "Error");
    assert.equal(out["message"], "boom");
    assert.equal(typeof out["stack"], "string");
  });

  it("includes own enumerable properties", () => {
    const err = Object.assign(new Error("boom"), { code: "ECONNRESET", retries: 3 });
    const out = impl.serializeError(err);
    assert.equal(out["code"], "ECONNRESET");
    assert.equal(out["retries"], 3);
  });

  it("serialises the cause chain", () => {
    const out = impl.serializeError(new Error("a", { cause: new Error("b", { cause: new Error("c") }) }));
    const b = out["cause"] as Record<string, unknown>;
    assert.equal(b["message"], "b");
    assert.equal((b["cause"] as Record<string, unknown>)["message"], "c");
  });

  it("handles non-Errors", () => {
    assert.equal(impl.serializeError("a string")["value"], "a string");
    assert.equal(impl.serializeError(42)["value"], "42");
    assert.equal(impl.serializeError(null)["value"], "null");
    assert.equal(impl.serializeError(undefined)["value"], "undefined");
  });

  it("uses toJSON when the error provides one", () => {
    const out = impl.serializeError(new impl.NotFoundError("user", "42"));
    assert.equal(out["code"], "NOT_FOUND");
    assert.equal(out["statusCode"], 404);
    assert.deepEqual(out["details"], { resource: "user", id: "42" });
  });

  it("is depth-limited and does not hang on a cycle", () => {
    const err = new Error("cyclic");
    err.cause = err;
    const out = impl.serializeError(err); // must terminate
    assert.equal(typeof out, "object");
    assert.ok(JSON.stringify(out).length < 100_000);
  });

  it("never throws, even on a hostile object", () => {
    const hostile = new Error("hostile");
    Object.defineProperty(hostile, "evil", {
      enumerable: true,
      get() {
        throw new Error("nope");
      },
    });
    const out = impl.serializeError(hostile);
    assert.equal(typeof out, "object", "serializeError must not throw");
  });

  it("produces JSON-stringifiable output", () => {
    const out = impl.serializeError(new Error("a", { cause: new Error("b") }));
    assert.doesNotThrow(() => JSON.stringify(out));
    const json = JSON.stringify(out);
    assert.ok(json.includes('"message":"a"'), "outer message missing");
    assert.ok(json.includes('"message":"b"'), "cause message missing");
  });
});

describe("withRetry", () => {
  // Deterministic: no real sleeping, no real randomness.
  const deterministic = (extra: RetryOptions = {}): RetryOptions => ({
    sleep: async () => {},
    random: () => 0.5,
    ...extra,
  });

  it("returns the value on first success", async () => {
    let calls = 0;
    const out = await impl.withRetry(async () => {
      calls++;
      return "ok";
    }, deterministic());
    assert.equal(out, "ok");
    assert.equal(calls, 1);
  });

  it("passes a 0-based attempt number", async () => {
    const attempts: number[] = [];
    await impl.withRetry(
      async (attempt) => {
        attempts.push(attempt);
        if (attempt < 2) throw Object.assign(new Error("x"), { code: "ECONNRESET" });
        return "ok";
      },
      deterministic(),
    );
    assert.deepEqual(attempts, [0, 1, 2]);
  });

  it("retries retryable errors and eventually succeeds", async () => {
    let calls = 0;
    const out = await impl.withRetry(async () => {
      calls++;
      if (calls < 3) throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
      return "ok";
    }, deterministic());
    assert.equal(out, "ok");
    assert.equal(calls, 3);
  });

  it("makes at most retries + 1 calls", async () => {
    let calls = 0;
    await assert.rejects(() =>
      impl.withRetry(async () => {
        calls++;
        throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
      }, deterministic({ retries: 2 })),
    );
    assert.equal(calls, 3, "should be 1 initial + 2 retries");
  });

  it("rethrows a NON-retryable error immediately and unwrapped", async () => {
    let calls = 0;
    const err = await impl
      .withRetry(async () => {
        calls++;
        throw new impl.ValidationError("email", "bad");
      }, deterministic())
      .catch((e: unknown) => e);
    assert.equal(calls, 1, "a 400 must not be retried");
    assert.equal((err as AppErrorLike).code, "VALIDATION", "must not be wrapped in RETRY_EXHAUSTED");
  });

  it("retries 5xx AppErrors", async () => {
    let calls = 0;
    await impl.withRetry(async () => {
      calls++;
      if (calls < 2) throw new impl.UpstreamError("payments");
      return "ok";
    }, deterministic());
    assert.equal(calls, 2);
  });

  it("throws RETRY_EXHAUSTED with the last error as cause", async () => {
    const last = Object.assign(new Error("final failure"), { code: "ETIMEDOUT" });
    const err = (await impl
      .withRetry(async () => {
        throw last;
      }, deterministic({ retries: 2 }))
      .catch((e: unknown) => e)) as AppErrorLike;

    assert.equal(err.code, "RETRY_EXHAUSTED");
    assert.equal(err.details["attempts"], 3);
    assert.equal(impl.rootCause(err), last, "the real error must be reachable via cause");
  });

  it("uses exponential backoff with full jitter, capped at maxMs", async () => {
    const delays: number[] = [];
    await impl
      .withRetry(
        async () => {
          throw Object.assign(new Error("x"), { code: "ECONNRESET" });
        },
        {
          retries: 5,
          baseMs: 100,
          maxMs: 500,
          random: () => 1, // full ceiling, so the schedule is visible
          sleep: async (ms) => void delays.push(ms),
        },
      )
      .catch(() => {});
    // 100, 200, 400, then capped at 500, 500
    assert.deepEqual(delays, [100, 200, 400, 500, 500]);
  });

  it("multiplies the delay by random() (jitter is applied)", async () => {
    const delays: number[] = [];
    await impl
      .withRetry(
        async () => {
          throw Object.assign(new Error("x"), { code: "ECONNRESET" });
        },
        { retries: 2, baseMs: 100, random: () => 0.25, sleep: async (ms) => void delays.push(ms) },
      )
      .catch(() => {});
    assert.deepEqual(delays, [25, 50], "delay should be random() * ceiling");
  });

  it("honours a custom isRetryable", async () => {
    let calls = 0;
    await assert.rejects(() =>
      impl.withRetry(
        async () => {
          calls++;
          throw new Error("anything");
        },
        deterministic({ retries: 2, isRetryable: () => true }),
      ),
    );
    assert.equal(calls, 3);
  });

  it("throws immediately for an already-aborted signal", async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        impl.withRetry(async () => {
          calls++;
          return "ok";
        }, deterministic({ signal: AbortSignal.abort() })),
      (err: unknown) => (err as Error).name === "AbortError",
    );
    assert.equal(calls, 0, "must not call fn at all");
  });

  it("stops retrying when aborted mid-flight", async () => {
    const ac = new AbortController();
    let calls = 0;
    await assert.rejects(
      () =>
        impl.withRetry(
          async () => {
            calls++;
            if (calls === 2) ac.abort();
            throw Object.assign(new Error("x"), { code: "ECONNRESET" });
          },
          deterministic({ retries: 10, signal: ac.signal }),
        ),
      (err: unknown) => (err as Error).name === "AbortError",
    );
    assert.ok(calls <= 3, `expected to stop quickly, made ${calls} calls`);
  });
});

describe("RequestContext", () => {
  it("run provides the store and returns the result", async () => {
    const ctx = new impl.RequestContext();
    const out = await ctx.run({ requestId: "r1" }, () => {
      assert.equal(ctx.get()?.requestId, "r1");
      return "value";
    });
    assert.equal(out, "value");
  });

  it("awaits an async fn and returns its resolved value", async () => {
    const ctx = new impl.RequestContext();
    const out = await ctx.run({ requestId: "r1" }, async () => {
      await sleep(5);
      return 42;
    });
    assert.equal(out, 42);
  });

  it("get() is undefined outside a run", () => {
    assert.equal(new impl.RequestContext().get(), undefined);
  });

  it("survives await, timers and Promise.all", async () => {
    const ctx = new impl.RequestContext();
    await ctx.run({ requestId: "r1" }, async () => {
      await sleep(5);
      assert.equal(ctx.get()?.requestId, "r1");
      await Promise.all([
        (async () => {
          await sleep(1);
          assert.equal(ctx.get()?.requestId, "r1");
        })(),
      ]);
      await new Promise<void>((r) =>
        setTimeout(() => {
          assert.equal(ctx.get()?.requestId, "r1");
          r();
        }, 1),
      );
    });
  });

  it("does not leak between concurrent runs", async () => {
    const ctx = new impl.RequestContext();
    const seen: string[] = [];
    await Promise.all(
      [
        ["a", 20],
        ["b", 5],
        ["c", 10],
      ].map(([id, ms]) =>
        ctx.run({ requestId: id as string }, async () => {
          await sleep(ms as number);
          seen.push(ctx.get()!.requestId);
        }),
      ),
    );
    assert.deepEqual(seen.sort(), ["a", "b", "c"]);
  });

  it("require() returns the store inside a run", async () => {
    const ctx = new impl.RequestContext();
    await ctx.run({ requestId: "r1" }, () => {
      assert.equal(ctx.require().requestId, "r1");
    });
  });

  it("require() throws NO_CONTEXT outside a run", () => {
    const ctx = new impl.RequestContext();
    assert.throws(
      () => ctx.require(),
      (err: unknown) => (err as AppErrorLike).code === "NO_CONTEXT",
    );
  });

  it("extend merges into the current store", async () => {
    const ctx = new impl.RequestContext();
    await ctx.run({ requestId: "r1" }, async () => {
      await ctx.extend({ userId: "u9" }, () => {
        assert.equal(ctx.get()?.requestId, "r1");
        assert.equal(ctx.get()?.userId, "u9");
      });
      assert.equal(ctx.get()?.userId, undefined, "extend must not mutate the parent store");
    });
  });

  it("extend works with no current context", async () => {
    const ctx = new impl.RequestContext();
    await ctx.extend({ userId: "u9" }, () => {
      assert.equal(ctx.get()?.userId, "u9");
    });
  });

  it("bind captures the context at BIND time, not call time", async () => {
    const ctx = new impl.RequestContext();
    const bus = new EventEmitter();
    const seen: Array<string | undefined> = [];

    await ctx.run({ requestId: "REGISTERED" }, async () => {
      bus.on("go", ctx.bind(() => seen.push(ctx.get()?.requestId)));
      bus.on("go", () => seen.push(ctx.get()?.requestId)); // unbound, for contrast
    });

    await ctx.run({ requestId: "EMITTED" }, async () => bus.emit("go"));

    assert.equal(seen[0], "REGISTERED", "bound listener must see the REGISTRATION context");
    assert.equal(seen[1], "EMITTED", "unbound listener sees the emit context — the trap");
  });

  it("bound functions work outside any run", async () => {
    const ctx = new impl.RequestContext();
    let bound!: () => string | undefined;
    await ctx.run({ requestId: "CAPTURED" }, async () => {
      bound = ctx.bind(() => ctx.get()?.requestId);
    });
    assert.equal(bound(), "CAPTURED");
  });

  it("bind preserves arguments and the return value", async () => {
    const ctx = new impl.RequestContext();
    let bound!: (a: number, b: number) => number;
    await ctx.run({ requestId: "r" }, async () => {
      bound = ctx.bind((a: number, b: number) => a + b);
    });
    assert.equal(bound(2, 3), 5);
  });
});
