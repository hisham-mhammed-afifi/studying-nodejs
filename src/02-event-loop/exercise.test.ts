/**
 *   node --test "src/02-event-loop/*.test.ts"
 *   IMPL=solution node --test "src/02-event-loop/*.test.ts"
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import type { LagMonitor } from "./exercise.ts";

const modulePath = process.env["IMPL"] === "solution" ? "./solution.ts" : "./exercise.ts";

type Impl = {
  mapLimit<T, R>(items: readonly T[], limit: number, fn: (i: T, idx: number) => Promise<R>): Promise<R[]>;
  createLagMonitor(intervalMs?: number): LagMonitor;
  yieldToLoop(): Promise<void>;
  processCooperatively<T, R>(items: readonly T[], fn: (i: T, idx: number) => R, budgetMs?: number): Promise<R[]>;
};

let impl: Impl;
before(async () => {
  impl = (await import(modulePath)) as unknown as Impl;
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("mapLimit", () => {
  it("returns results in input order", async () => {
    const out = await impl.mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
      // Reverse the durations so completion order != input order.
      await sleep((6 - n) * 5);
      return n * 10;
    });
    assert.deepEqual(out, [10, 20, 30, 40, 50]);
  });

  it("passes the index", async () => {
    const out = await impl.mapLimit(["a", "b", "c"], 2, async (s, i) => `${i}:${s}`);
    assert.deepEqual(out, ["0:a", "1:b", "2:c"]);
  });

  it("never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    await impl.mapLimit(Array.from({ length: 30 }, (_, i) => i), 4, async (n) => {
      peak = Math.max(peak, ++inFlight);
      await sleep(3 + (n % 5));
      inFlight--;
      return n;
    });
    assert.ok(peak <= 4, `peak concurrency was ${peak}, expected <= 4`);
    assert.equal(peak, 4, "should actually reach the limit, not run serially");
  });

  it("refills a free slot immediately (not batch-by-batch)", async () => {
    // One very slow item; the rest are fast. A batching implementation would
    // take ~ (slow + fast + fast) because each batch waits for its slowest.
    const durations = [200, 5, 5, 5, 5, 5, 5, 5];
    const t0 = performance.now();
    await impl.mapLimit(durations, 2, async (d) => {
      await sleep(d);
      return d;
    });
    const elapsed = performance.now() - t0;
    // Correct: ~200ms (slow item runs in slot 1 while slot 2 chews the rest).
    // Batched: ~200 + 5 + 5 + 5 ≈ 215ms+ and grows with input size.
    assert.ok(elapsed < 320, `took ${elapsed.toFixed(0)}ms — slots are not refilling eagerly`);
  });

  it("resolves [] for empty input without calling fn", async () => {
    let called = false;
    const out = await impl.mapLimit([], 3, async () => {
      called = true;
      return 1;
    });
    assert.deepEqual(out, []);
    assert.equal(called, false);
  });

  it("handles limit larger than the input", async () => {
    const out = await impl.mapLimit([1, 2], 100, async (n) => n);
    assert.deepEqual(out, [1, 2]);
  });

  it("propagates a rejection", async () => {
    await assert.rejects(
      () =>
        impl.mapLimit([1, 2, 3, 4], 2, async (n) => {
          if (n === 3) throw new Error("boom");
          await sleep(5);
          return n;
        }),
      /boom/,
    );
  });

  it("stops starting new work after a failure", async () => {
    let started = 0;
    await assert.rejects(
      () =>
        impl.mapLimit(Array.from({ length: 50 }, (_, i) => i), 2, async (n) => {
          started++;
          await sleep(2);
          if (n === 1) throw new Error("boom");
          return n;
        }),
      /boom/,
    );
    await sleep(30);
    assert.ok(started < 20, `${started} items started after failure — should have stopped early`);
  });

  for (const bad of [0, -1, 1.5, Number.NaN]) {
    it(`throws RangeError for limit=${bad}`, async () => {
      await assert.rejects(() => impl.mapLimit([1], bad, async (n) => n), RangeError);
    });
  }
});

describe("createLagMonitor", () => {
  it("samples and reports near-zero lag when idle", async () => {
    const m = impl.createLagMonitor(10);
    await sleep(120);
    m.stop();
    assert.ok(m.samples > 3, `only ${m.samples} samples in 120ms`);
    assert.ok(m.maxLagMs < 60, `idle lag was ${m.maxLagMs.toFixed(1)}ms, expected small`);
    assert.ok(m.meanLagMs >= 0);
  });

  it("detects a blocked loop", async () => {
    const m = impl.createLagMonitor(10);
    await sleep(30);
    const until = Date.now() + 150;
    while (Date.now() < until) {
      /* block on purpose */
    }
    await sleep(30);
    m.stop();
    assert.ok(m.maxLagMs > 80, `max lag was ${m.maxLagMs.toFixed(1)}ms, expected > 80`);
  });

  it("never reports negative lag", async () => {
    const m = impl.createLagMonitor(5);
    await sleep(60);
    m.stop();
    assert.ok(m.maxLagMs >= 0);
    assert.ok(m.meanLagMs >= 0);
  });

  it("reset() clears the stats", async () => {
    const m = impl.createLagMonitor(5);
    const until = Date.now() + 80;
    while (Date.now() < until) {
      /* block */
    }
    await sleep(20);
    assert.ok(m.samples > 0);
    m.reset();
    assert.equal(m.samples, 0);
    assert.equal(m.maxLagMs, 0);
    assert.equal(m.meanLagMs, 0);
    m.stop();
  });

  it("stop() is idempotent and halts sampling", async () => {
    const m = impl.createLagMonitor(5);
    await sleep(40);
    m.stop();
    m.stop();
    const after = m.samples;
    await sleep(40);
    assert.equal(m.samples, after, "still sampling after stop()");
  });

  it("does not keep the process alive", async () => {
    // A monitor whose timer is not unref'd would hold the loop open. We check
    // the handle count instead of actually exiting.
    const before = (process as unknown as { _getActiveHandles(): unknown[] })._getActiveHandles().length;
    const m = impl.createLagMonitor(1000);
    const during = (process as unknown as { _getActiveHandles(): unknown[] })._getActiveHandles().length;
    m.stop();
    assert.equal(during, before, "monitor added a ref'd handle — call .unref()");
  });
});

describe("yieldToLoop", () => {
  it("actually lets a timer fire", async () => {
    let fired = false;
    setTimeout(() => {
      fired = true;
    }, 0);
    // A microtask-based implementation leaves this false.
    for (let i = 0; i < 3 && !fired; i++) await impl.yieldToLoop();
    assert.equal(fired, true, "yieldToLoop did not advance the event loop (microtask, not macrotask?)");
  });

  it("resolves to undefined", async () => {
    assert.equal(await impl.yieldToLoop(), undefined);
  });
});

describe("processCooperatively", () => {
  it("returns mapped results in order", async () => {
    const out = await impl.processCooperatively([1, 2, 3], (n, i) => n * 100 + i);
    assert.deepEqual(out, [100, 201, 302]);
  });

  it("handles empty input", async () => {
    assert.deepEqual(await impl.processCooperatively([], (n) => n), []);
  });

  // Per-item work heavy enough that the whole run takes ~150ms+. With trivial
  // work the run finishes before a timer could ever have fired, and the test
  // would pass or fail on machine speed rather than on the implementation.
  const heavy = (n: number): number => {
    let acc = 0;
    for (let k = 1; k <= 24; k++) acc += Math.sin(n * k) / k;
    return acc;
  };
  const bigInput = Array.from({ length: 200_000 }, (_, i) => i);

  it("lets timers fire during a long run", async () => {
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    await impl.processCooperatively(bigInput, heavy, 5);
    clearInterval(timer);
    assert.ok(ticks > 3, `timer only ticked ${ticks} times — the loop was starved`);
  });

  it("keeps loop lag bounded", async () => {
    const m = impl.createLagMonitor(10);
    await impl.processCooperatively(bigInput, heavy, 8);
    m.stop();
    assert.ok(m.maxLagMs < 120, `max lag ${m.maxLagMs.toFixed(0)}ms — budget is not being respected`);
  });
});
