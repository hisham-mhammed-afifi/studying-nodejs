/**
 * Tests for exercise 15.
 *
 *   node scripts/test.ts 15              ← your exercise.ts
 *   node scripts/test.ts --solutions 15  ← the reference solution
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createServer, get, Agent, type Server } from "node:http";
import { once } from "node:events";
import type {
  DrainOptions,
  DrainResult,
  HealthRegistry as HealthRegistryType,
  Readiness as ReadinessType,
  ShutdownManager as ShutdownManagerType,
} from "./exercise.ts";

interface Impl {
  HealthRegistry: new (timeoutMs?: number) => HealthRegistryType;
  Readiness: new () => ReadinessType;
  drain(server: Server, options?: DrainOptions): Promise<DrainResult>;
  ShutdownManager: new (deadlineMs?: number) => ShutdownManagerType;
}

const modulePath = process.env["IMPL"] === "solution" ? "./solution.ts" : "./exercise.ts";
let impl: Impl;
before(async () => {
  impl = (await import(modulePath)) as unknown as Impl;
});

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────────

describe("Task 1 — HealthRegistry", () => {
  it("reports pass when every check passes", async () => {
    const registry = new impl.HealthRegistry();
    registry.register("database", () => true);
    registry.register("cache", async () => "pong");

    const report = await registry.run();
    assert.equal(report.status, "pass");
    assert.equal(report.checks["database"]?.status, "pass");
    assert.equal(report.checks["cache"]?.status, "pass");
  });

  it("reports pass for an empty registry", async () => {
    // No dependencies is healthy, not broken.
    const report = await new impl.HealthRegistry().run();
    assert.deepEqual(report, { status: "pass", checks: {} });
  });

  it("fails the whole report when one check fails", async () => {
    const registry = new impl.HealthRegistry();
    registry.register("ok", () => true);
    registry.register("broken", () => {
      throw new Error("connection refused");
    });

    const report = await registry.run();
    assert.equal(report.status, "fail");
    assert.equal(report.checks["ok"]?.status, "pass");
    assert.equal(report.checks["broken"]?.status, "fail");
    assert.equal(report.checks["broken"]?.error, "connection refused");
  });

  it("catches a SYNCHRONOUS throw, not just a rejection", async () => {
    const registry = new impl.HealthRegistry();
    registry.register("sync", () => {
      throw new Error("sync boom");
    });
    registry.register("async", async () => {
      throw new Error("async boom");
    });
    const report = await registry.run();
    assert.equal(report.checks["sync"]?.error, "sync boom");
    assert.equal(report.checks["async"]?.error, "async boom");
  });

  it("times out a hung check instead of hanging the probe", async () => {
    const registry = new impl.HealthRegistry(100);
    registry.register("hung", () => new Promise(() => {})); // never settles

    const t0 = Date.now();
    const report = await registry.run();
    const ms = Date.now() - t0;

    assert.equal(report.status, "fail");
    assert.equal(report.checks["hung"]?.error, "timeout");
    assert.ok(ms < 1000, `should return in ~100ms, took ${ms}ms`);
  });

  it("runs checks CONCURRENTLY, not one after another", async () => {
    const registry = new impl.HealthRegistry(2000);
    for (let i = 0; i < 5; i++) registry.register(`slow${i}`, () => delay(100));

    const t0 = Date.now();
    const report = await registry.run();
    const ms = Date.now() - t0;

    assert.equal(report.status, "pass");
    // Sequential would be ~500ms; concurrent is ~100ms.
    assert.ok(ms < 350, `5 × 100ms concurrently should be ~100ms, took ${ms}ms`);
  });

  it("records a duration for every check", async () => {
    const registry = new impl.HealthRegistry();
    registry.register("quick", () => true);
    registry.register("slower", () => delay(40));
    registry.register("failing", () => {
      throw new Error("x");
    });

    const report = await registry.run();
    for (const [name, result] of Object.entries(report.checks)) {
      assert.equal(typeof result.durationMs, "number", name);
      assert.ok(result.durationMs >= 0, name);
    }
    assert.ok(
      report.checks["slower"]!.durationMs >= 30,
      `expected ~40ms, got ${report.checks["slower"]!.durationMs}`,
    );
  });

  it("does not include an error field on a passing check", async () => {
    const registry = new impl.HealthRegistry();
    registry.register("fine", () => true);
    const report = await registry.run();
    assert.equal(report.checks["fine"]?.error, undefined);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("Task 2 — Readiness", () => {
  it("starts NOT ready", () => {
    const r = new impl.Readiness();
    assert.equal(r.isReady, false);
    assert.equal(r.isShuttingDown, false);
  });

  it("flips ready after warm-up", () => {
    const r = new impl.Readiness();
    r.markReady();
    assert.equal(r.isReady, true);
  });

  it("flips back on shutdown", () => {
    const r = new impl.Readiness();
    r.markReady();
    r.markNotReady();
    assert.equal(r.isReady, false);
    assert.equal(r.isShuttingDown, true);
  });

  it("is a ONE-WAY door — a late warm-up cannot re-enter rotation", () => {
    const r = new impl.Readiness();
    r.markReady();
    r.markNotReady();
    r.markReady(); // a warm-up callback resolving after SIGTERM
    assert.equal(r.isReady, false, "a draining instance must stay out of rotation");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("Task 3 — drain", () => {
  /** A server whose handler takes `ms`, plus a keep-alive client. */
  async function scenario(handlerMs: number) {
    const server = createServer((_req, res) => setTimeout(() => res.end("ok"), handlerMs));
    server.listen(0);
    await once(server, "listening");
    const { port } = server.address() as { port: number };
    const agent = new Agent({ keepAlive: true });

    let client = "pending";
    const request = new Promise<void>((resolve) => {
      get({ port, agent }, (res) => {
        res.resume();
        res.on("end", () => {
          client = `completed ${res.statusCode}`;
          resolve();
        });
      }).on("error", (err: NodeJS.ErrnoException) => {
        client = `killed ${err.code}`;
        resolve();
      });
    });

    await delay(100); // let the request arrive and start work
    return { server, agent, request, clientResult: () => client };
  }

  it("resolves immediately for a server that is not listening", async () => {
    const server = createServer();
    const result = await impl.drain(server);
    assert.equal(result.forced, false);
    assert.ok(result.ms < 100);
  });

  it("closes the server and stops it listening", async () => {
    const { server, agent } = await scenario(10);
    await impl.drain(server);
    assert.equal(server.listening, false);
    agent.destroy();
  });

  it("finishes FAST — the sweep, not keepAliveTimeout", async () => {
    const { server, agent, request, clientResult } = await scenario(300);

    const result = await impl.drain(server, { sweepMs: 20, deadlineMs: 10_000 });
    await request;

    // Without the sweep this waits out keepAliveTimeout: ~5300ms.
    // 05-shutdown.ts measures 6814ms vs 811ms on the same shape.
    assert.ok(result.ms < 2000, `expected ~300ms, took ${result.ms}ms — is the sweep running?`);
    assert.equal(result.forced, false);
    assert.equal(clientResult(), "completed 200", "the in-flight request must NOT be severed");
    agent.destroy();
  });

  it("forces at the deadline, and says so", async () => {
    const { server, agent, request, clientResult } = await scenario(3000);

    const result = await impl.drain(server, { sweepMs: 20, deadlineMs: 200 });
    assert.equal(result.forced, true, "forced must be true when the deadline fired");
    assert.ok(result.ms < 1500, `expected ~200ms, took ${result.ms}ms`);

    await request;
    assert.notEqual(clientResult(), "completed 200", "the deadline severs in-flight requests");
    agent.destroy();
  });

  it("leaves no handle holding the event loop open", async () => {
    const { server, agent } = await scenario(10);
    await impl.drain(server, { sweepMs: 20, deadlineMs: 60_000 });
    agent.destroy();

    // A 60s deadline timer that was not unref'd (or not cleared) would keep
    // this process alive for a minute after the tests finish — the leak from
    // 03-lies.ts §4, in the very code meant to prevent it.
    const handles = (process as unknown as { _getActiveHandles(): unknown[] })._getActiveHandles();
    const timers = handles.filter((h) => h?.constructor?.name === "Timeout");
    assert.ok(timers.length < 5, `suspicious number of live timers: ${timers.length}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("Task 4 — ShutdownManager", () => {
  it("runs the steps in registration order", async () => {
    const order: string[] = [];
    const manager = new impl.ShutdownManager(5000);
    manager.add("readiness", () => void order.push("readiness"));
    manager.add("drain", async () => {
      await delay(10);
      order.push("drain");
    });
    manager.add("database", () => void order.push("database"));
    manager.add("logger", () => void order.push("logger"));

    const result = await manager.run();
    assert.deepEqual(order, ["readiness", "drain", "database", "logger"]);
    assert.equal(result.outcome, "clean");
    assert.deepEqual(result.ran, ["readiness", "drain", "database", "logger"]);
  });

  it("is idempotent — a second SIGTERM does not start a second sequence", async () => {
    let runs = 0;
    const manager = new impl.ShutdownManager(5000);
    manager.add("once", async () => {
      runs++;
      await delay(50);
    });

    const [a, b, c] = await Promise.all([manager.run(), manager.run(), manager.run()]);
    assert.equal(runs, 1, "the step must run exactly once");
    assert.deepEqual(a, b);
    assert.deepEqual(b, c);
  });

  it("exposes isShuttingDown", async () => {
    const manager = new impl.ShutdownManager(5000);
    manager.add("slow", () => delay(50));
    assert.equal(manager.isShuttingDown, false);
    const running = manager.run();
    assert.equal(manager.isShuttingDown, true);
    await running;
    assert.equal(manager.isShuttingDown, true);
  });

  it("keeps going after a failing step, and reports the FIRST error", async () => {
    const order: string[] = [];
    const manager = new impl.ShutdownManager(5000);
    manager.add("drain", () => void order.push("drain"));
    manager.add("database", () => {
      throw new Error("db close failed");
    });
    manager.add("queue", () => {
      throw new Error("queue close failed");
    });
    manager.add("logger", () => void order.push("logger"));

    const result = await manager.run();
    assert.equal(result.outcome, "failed");
    assert.equal(result.error?.message, "db close failed", "the FIRST error, not the last");
    assert.deepEqual(order, ["drain", "logger"], "the logger must still be flushed");
    assert.deepEqual(result.ran, ["drain", "logger"], "ran lists only the steps that completed");
  });

  it("handles an async rejection the same way", async () => {
    const manager = new impl.ShutdownManager(5000);
    manager.add("rejects", async () => {
      await delay(5);
      throw new Error("async failure");
    });
    manager.add("after", () => {});
    const result = await manager.run();
    assert.equal(result.outcome, "failed");
    assert.equal(result.error?.message, "async failure");
    assert.deepEqual(result.ran, ["after"]);
  });

  it("times out rather than hanging on a stuck step", async () => {
    const manager = new impl.ShutdownManager(150);
    manager.add("fine", () => {});
    manager.add("stuck", () => new Promise<void>(() => {})); // never settles
    manager.add("never reached", () => {});

    const t0 = Date.now();
    const result = await manager.run();
    const ms = Date.now() - t0;

    assert.equal(result.outcome, "timeout");
    assert.deepEqual(result.ran, ["fine"], "ran lists what completed before the deadline");
    assert.ok(ms < 1000, `expected ~150ms, took ${ms}ms`);
  });

  it("NEVER rejects", async () => {
    const manager = new impl.ShutdownManager(200);
    manager.add("throws a string", () => {
      throw "not even an Error";
    });
    manager.add("rejects with undefined", () => Promise.reject(new Error("x")));

    // A shutdown path that rejects is a shutdown path that hangs: there is
    // nothing left above it to catch (03-lies.ts §3).
    await assert.doesNotReject(() => manager.run());
    const result = await manager.run();
    assert.equal(result.outcome, "failed");
    assert.ok(result.error instanceof Error, "a thrown string must be wrapped in an Error");
  });

  it("works with no steps at all", async () => {
    const result = await new impl.ShutdownManager(1000).run();
    assert.deepEqual(result, { outcome: "clean", ran: [] });
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("all four together — the real shutdown path", () => {
  let server: Server;
  let port: number;

  before(async () => {
    server = createServer((_req, res) => setTimeout(() => res.end("ok"), 200));
    server.listen(0);
    await once(server, "listening");
    port = (server.address() as { port: number }).port;
  });

  after(() => {
    if (server.listening) server.close();
  });

  it("readiness flips first, in-flight requests survive, nothing new is accepted", async () => {
    const readiness = new impl.Readiness();
    readiness.markReady();

    const health = new impl.HealthRegistry(500);
    health.register("http", () => readiness.isReady || Promise.reject(new Error("draining")));

    assert.equal((await health.run()).status, "pass");

    // One request in flight when the signal arrives.
    const inFlight = fetch(`http://127.0.0.1:${port}/`).then((r) => r.status);
    await delay(50);

    const manager = new impl.ShutdownManager(5000);
    const order: string[] = [];
    manager.add("readiness", () => {
      readiness.markNotReady();
      order.push("readiness");
    });
    // No "wait for the load balancer" step here — in production this is
    // where the 5-15s pause goes (05-shutdown.ts §4).
    manager.add("drain", async () => {
      await impl.drain(server, { sweepMs: 20, deadlineMs: 5000 });
      order.push("drain");
    });

    const result = await manager.run();

    assert.equal(result.outcome, "clean");
    assert.deepEqual(order, ["readiness", "drain"], "readiness BEFORE drain");
    assert.equal(await inFlight, 200, "the in-flight request must complete");
    assert.equal((await health.run()).status, "fail", "and readiness now reports not-ready");
    assert.equal(server.listening, false);
    await assert.rejects(() => fetch(`http://127.0.0.1:${port}/`), "new requests are refused");
  });
});
