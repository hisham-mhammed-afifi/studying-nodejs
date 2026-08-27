/**
 *   node scripts/test.ts 08
 *   node scripts/test.ts --solutions 08
 */

import { describe, it, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import {
  PoolClosedError,
  PoolQueueFullError,
  PoolTimeoutError,
  type PoolOptions,
  type PoolStats,
} from "./exercise.ts";

const useSolution = process.env["IMPL"] === "solution";
const modulePath = useSolution ? "./solution.ts" : "./exercise.ts";
const WORKER = path.join(import.meta.dirname, "_test-worker.ts");

interface Pool {
  run<T = unknown>(payload: unknown): Promise<T>;
  stats(): PoolStats;
  close(options?: { timeoutMs?: number }): Promise<void>;
}

type Impl = {
  WorkerPool: new (script: string | URL, options?: PoolOptions) => Pool;
  parallelMap<T, R>(
    pool: Pool,
    items: readonly T[],
    toPayload: (item: T, index: number) => unknown,
  ): Promise<R[]>;
};

let impl: Impl;
before(async () => {
  impl = (await import(modulePath)) as unknown as Impl;
});

// Every test registers its pool here so a failure can't leak workers and
// hang the whole test run.
let open: Pool[] = [];
const makePool = (options?: PoolOptions): Pool => {
  const pool = new impl.WorkerPool(WORKER, options);
  open.push(pool);
  return pool;
};
afterEach(async () => {
  const pools = open;
  open = [];
  await Promise.all(pools.map((p) => p.close({ timeoutMs: 500 }).catch(() => {})));
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("WorkerPool — basics", () => {
  it("runs a task and returns the reply", async () => {
    const pool = makePool({ size: 2 });
    const out = await pool.run<{ value: number }>({ op: "double", value: 21 });
    assert.equal(out.value, 42);
  });

  it("runs many tasks correctly", async () => {
    const pool = makePool({ size: 2 });
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => pool.run<{ value: number }>({ op: "double", value: i })),
    );
    assert.deepEqual(results.map((r) => r.value), Array.from({ length: 20 }, (_, i) => i * 2));
  });

  it("spawns exactly `size` workers", async () => {
    const pool = makePool({ size: 3 });
    assert.equal(pool.stats().size, 3);
  });

  it("actually uses multiple workers", async () => {
    const pool = makePool({ size: 3 });
    const results = await Promise.all(
      Array.from({ length: 9 }, () => pool.run<{ threadId: number }>({ op: "slow", ms: 30 })),
    );
    const distinct = new Set(results.map((r) => r.threadId));
    assert.ok(distinct.size > 1, `only ${distinct.size} worker(s) used — is the pool serialising?`);
  });

  it("never runs two tasks on one worker at once", async () => {
    const pool = makePool({ size: 2 });
    // 6 slow tasks over 2 workers: if a worker ever doubled up we'd see more
    // than 2 distinct threadIds finishing in the first wave.
    const started = Date.now();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => pool.run<{ threadId: number }>({ op: "slow", ms: 40 })),
    );
    const elapsed = Date.now() - started;
    assert.equal(results.length, 6);
    // 6 tasks / 2 workers × 40ms ≈ 120ms. Much less would mean overlap.
    assert.ok(elapsed >= 100, `finished in ${elapsed}ms — tasks overlapped on one worker?`);
  });

  it("queues tasks FIFO", async () => {
    const pool = makePool({ size: 1 });
    const order: number[] = [];
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        pool.run({ op: "echo", value: i }).then(() => void order.push(i)),
      ),
    );
    assert.deepEqual(order, [0, 1, 2, 3, 4], "tasks did not complete in submission order");
  });

  it("passes workerData through", async () => {
    const pool = makePool({ size: 1, workerData: { tag: "hello" } });
    const out = await pool.run<{ workerData: { tag: string } }>({ op: "whoami" });
    assert.equal(out.workerData.tag, "hello");
  });
});

describe("WorkerPool — stats", () => {
  it("reports queued and busy counts", async () => {
    const pool = makePool({ size: 1 });
    const running = Promise.all([
      pool.run({ op: "slow", ms: 60 }),
      pool.run({ op: "slow", ms: 10 }),
      pool.run({ op: "slow", ms: 10 }),
    ]);
    await sleep(20);
    const s = pool.stats();
    assert.equal(s.busy, 1, "one worker should be busy");
    assert.ok(s.queued >= 1, `expected queued tasks, got ${s.queued}`);
    await running;
  });

  it("counts completed and failed cumulatively", async () => {
    const pool = makePool({ size: 2 });
    await pool.run({ op: "echo", value: 1 });
    await pool.run({ op: "echo", value: 2 });
    await pool.run({ op: "throw" }).catch(() => {});
    const s = pool.stats();
    assert.equal(s.completed, 2);
    assert.equal(s.failed, 1);
  });

  it("is idle after the work drains", async () => {
    const pool = makePool({ size: 2 });
    await pool.run({ op: "echo", value: 1 });
    await sleep(20);
    const s = pool.stats();
    assert.equal(s.busy, 0);
    assert.equal(s.queued, 0);
    assert.equal(s.idle, 2);
  });
});

describe("WorkerPool — worker death", () => {
  it("rejects the in-flight task when the worker throws", async () => {
    const pool = makePool({ size: 1 });
    await assert.rejects(() => pool.run({ op: "throw" }), /worker task failed/);
  });

  it("rejects EXACTLY ONCE when the worker throws (error AND exit both fire)", async () => {
    const pool = makePool({ size: 1 });
    let settlements = 0;
    await pool.run({ op: "throw" }).then(
      () => settlements++,
      () => settlements++,
    );
    await sleep(80); // let the trailing 'exit' land
    assert.equal(settlements, 1);
  });

  it("rejects when the worker exits hard", async () => {
    const pool = makePool({ size: 1 });
    await assert.rejects(() => pool.run({ op: "exit" }));
  });

  it("REPLACES a dead worker so size stays constant", async () => {
    const pool = makePool({ size: 2 });
    await pool.run({ op: "throw" }).catch(() => {});
    await sleep(120); // give the pool time to respawn
    assert.equal(pool.stats().size, 2, "the dead worker was not replaced");
  });

  it("keeps working after a worker dies", async () => {
    const pool = makePool({ size: 1 });
    await pool.run({ op: "throw" }).catch(() => {});
    await sleep(120);
    const out = await pool.run<{ value: number }>({ op: "double", value: 5 });
    assert.equal(out.value, 10, "the pool did not recover");
  });

  it("does not lose queued tasks when a worker dies", async () => {
    const pool = makePool({ size: 1 });
    const failing = pool.run({ op: "throw" }).catch(() => "failed");
    const queued = Array.from({ length: 3 }, (_, i) =>
      pool.run<{ value: number }>({ op: "double", value: i + 1 }),
    );
    await failing;
    const results = await Promise.all(queued);
    assert.deepEqual(results.map((r) => r.value), [2, 4, 6]);
  });
});

describe("WorkerPool — timeouts", () => {
  it("rejects with PoolTimeoutError", async () => {
    const pool = makePool({ size: 1, taskTimeoutMs: 60 });
    await assert.rejects(() => pool.run({ op: "slow", ms: 5000 }), PoolTimeoutError);
  });

  it("does not time out a task that finishes in time", async () => {
    const pool = makePool({ size: 1, taskTimeoutMs: 300 });
    const out = await pool.run<{ value: number }>({ op: "slow", ms: 20, value: 9 });
    assert.equal(out.value, 9);
  });

  it("recovers from a task that HANGS the worker's own loop", async () => {
    // "hang" spins forever, so the worker cannot even process a shutdown
    // message. The only recovery is terminate() + respawn.
    const pool = makePool({ size: 1, taskTimeoutMs: 80 });
    await assert.rejects(() => pool.run({ op: "hang" }), PoolTimeoutError);
    await sleep(150);
    const out = await pool.run<{ value: number }>({ op: "double", value: 4 });
    assert.equal(out.value, 8, "the pool did not recover from a hung worker");
  });

  it("a late reply from a timed-out task does not resolve anything", async () => {
    const pool = makePool({ size: 1, taskTimeoutMs: 40 });
    await assert.rejects(() => pool.run({ op: "slow", ms: 200, value: 1 }), PoolTimeoutError);
    await sleep(250);
    // The next task must get ITS OWN reply, not the stale one.
    const out = await pool.run<{ value: number }>({ op: "double", value: 3 });
    assert.equal(out.value, 6);
  });
});

describe("WorkerPool — backpressure", () => {
  it("rejects with PoolQueueFullError past maxQueue", async () => {
    const pool = makePool({ size: 1, maxQueue: 2 });
    const inflight = pool.run({ op: "slow", ms: 200 });
    await sleep(20);
    const q1 = pool.run({ op: "echo", value: 1 });
    const q2 = pool.run({ op: "echo", value: 2 });
    await assert.rejects(() => pool.run({ op: "echo", value: 3 }), PoolQueueFullError);
    await Promise.all([inflight, q1, q2]);
  });

  it("accepts again once the queue drains", async () => {
    const pool = makePool({ size: 1, maxQueue: 1 });
    const a = pool.run({ op: "slow", ms: 60 });
    await sleep(10);
    const b = pool.run({ op: "echo", value: 1 });
    await assert.rejects(() => pool.run({ op: "echo", value: 2 }), PoolQueueFullError);
    await Promise.all([a, b]);
    const out = await pool.run<{ value: number }>({ op: "double", value: 6 });
    assert.equal(out.value, 12);
  });
});

describe("WorkerPool — close", () => {
  it("waits for in-flight tasks", async () => {
    const pool = makePool({ size: 2 });
    const running = pool.run<{ value: number }>({ op: "slow", ms: 60, value: 5 });
    await pool.close({ timeoutMs: 1000 });
    assert.equal((await running).value, 5, "close() did not let the in-flight task finish");
  });

  it("rejects new tasks with PoolClosedError", async () => {
    const pool = makePool({ size: 1 });
    await pool.close();
    await assert.rejects(() => pool.run({ op: "echo", value: 1 }), PoolClosedError);
  });

  it("fails tasks still queued at close time", async () => {
    const pool = makePool({ size: 1 });
    const inflight = pool.run({ op: "slow", ms: 40 });
    const queued = pool.run({ op: "echo", value: 1 });
    const closing = pool.close({ timeoutMs: 1000 });
    await assert.rejects(() => queued, PoolClosedError);
    await inflight.catch(() => {});
    await closing;
  });

  it("is idempotent", async () => {
    const pool = makePool({ size: 1 });
    await Promise.all([pool.close(), pool.close()]);
    await pool.close();
  });

  it("terminates anyway after timeoutMs", async () => {
    const pool = makePool({ size: 1 });
    const hung = pool.run({ op: "hang" }).catch((e: unknown) => e);
    await sleep(20);
    const t0 = Date.now();
    await pool.close({ timeoutMs: 100 });
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 600, `close() took ${elapsed}ms — it should give up after ~100ms`);
    assert.ok((await hung) instanceof Error, "the hung task should have been rejected");
  });

  it("leaves no live handles — a child process actually EXITS after close()", async () => {
    // The honest way to ask "does this keep the process alive?" is to run it
    // in a real process and see whether that process exits.
    //
    // The obvious shortcut does NOT work: a live Worker appears in neither
    // process._getActiveHandles() nor process.getActiveResourcesInfo(), so a
    // test built on either passes whether or not close() terminated anything.
    // (Module 02 can use getActiveResourcesInfo because TIMERS do show up
    // there. Workers do not. Verified on Node 22.)
    //
    // A child that exits on its own is unfakeable: if any worker survived
    // close(), its message port holds the loop open and the child hangs.
    // A real .mjs file in the OS temp dir, NOT `node --input-type=module -e`:
    // a Worker inherits the parent's execArgv, and --input-type=module makes
    // the worker's own file entry fail with ERR_INPUT_TYPE_NOT_ALLOWED. A
    // plain file needs no flags. (Absolute file:// URL for the same reason
    // the temp dir is outside the project — no relative resolution to get
    // wrong, and nothing written into the repo.)
    const implUrl = pathToFileURL(path.join(import.meta.dirname, modulePath)).href;
    const dir = await mkdtemp(path.join(tmpdir(), "pool-exit-"));
    const scriptPath = path.join(dir, "child.mjs");
    await writeFile(
      scriptPath,
      `const { WorkerPool } = await import(${JSON.stringify(implUrl)});
       const pool = new WorkerPool(${JSON.stringify(WORKER)}, { size: 2 });
       await pool.run({ op: "echo", value: 1 });
       await pool.close();
       console.log("CLOSED");
       // No process.exit() — exiting naturally IS the assertion.
      `,
    );

    try {
      const child = spawn(process.execPath, ["--no-warnings", scriptPath], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let out = "";
      child.stdout.on("data", (c: Buffer) => (out += c));
      child.stderr.on("data", (c: Buffer) => (out += c));

      // Generous: we distinguish "exits" from "never exits", not timing.
      const killer = setTimeout(() => child.kill("SIGKILL"), 15_000);
      const [code, signal] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
      clearTimeout(killer);

      assert.match(out, /CLOSED/, `the pool never finished closing. Output:\n${out}`);
      assert.equal(
        signal,
        null,
        "the child had to be SIGKILLed — close() left a worker alive, so the " +
          `process could never exit. Output:\n${out}`,
      );
      assert.equal(code, 0, `child exited with ${code}. Output:\n${out}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("parallelMap", () => {
  it("preserves input order", async () => {
    const pool = makePool({ size: 3 });
    // Reverse the durations so completion order differs from input order.
    const items = [50, 40, 30, 20, 10];
    const out = await impl.parallelMap<number, { value: number }>(pool, items, (ms, i) => ({
      op: "slow",
      ms,
      value: i,
    }));
    assert.deepEqual(out.map((r) => r.value), [0, 1, 2, 3, 4]);
  });

  it("handles an empty input", async () => {
    const pool = makePool({ size: 2 });
    assert.deepEqual(await impl.parallelMap(pool, [], () => ({ op: "echo" })), []);
  });

  it("maps a large batch correctly", async () => {
    const pool = makePool({ size: 2 });
    const items = Array.from({ length: 40 }, (_, i) => i);
    const out = await impl.parallelMap<number, { value: number }>(pool, items, (n) => ({
      op: "double",
      value: n,
    }));
    assert.deepEqual(out.map((r) => r.value), items.map((n) => n * 2));
  });

  it("rejects if any task fails", async () => {
    const pool = makePool({ size: 2 });
    await assert.rejects(() =>
      impl.parallelMap(pool, [1, 2, 3], (n) => (n === 2 ? { op: "throw" } : { op: "echo", value: n })),
    );
  });
});
