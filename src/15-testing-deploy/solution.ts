/**
 * SOLUTION 15 — reference implementation.
 */

import type { Server } from "node:http";
import {
  type Check,
  type CheckResult,
  type DrainOptions,
  type DrainResult,
  type HealthReport,
  type ShutdownResult,
  type ShutdownStep,
} from "./exercise.ts";

// --- Task 1 ------------------------------------------------------------------

export class HealthRegistry {
  readonly #checks = new Map<string, Check>();
  readonly timeoutMs: number;

  constructor(timeoutMs = 1000) {
    this.timeoutMs = timeoutMs;
  }

  get names(): string[] {
    return [...this.#checks.keys()];
  }

  register(name: string, check: Check): this {
    this.#checks.set(name, check);
    return this; // chainable: registry.register(a).register(b)
  }

  async run(): Promise<HealthReport> {
    // CONCURRENTLY. Sequentially, five 200ms checks take a second, and the
    // load balancer's probe timeout is often exactly that.
    const entries = await Promise.all(
      [...this.#checks].map(async ([name, check]) => [name, await this.#runOne(check)] as const),
    );

    const checks = Object.fromEntries(entries) as Record<string, CheckResult>;
    // every() on an empty array is true — a service with no dependencies is
    // healthy, which is the behaviour we want.
    const status = entries.every(([, r]) => r.status === "pass") ? "pass" : "fail";
    return { status, checks };
  }

  async #runOne(check: Check): Promise<CheckResult> {
    const t0 = performance.now();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        // Promise.resolve() so a SYNCHRONOUS throw is caught here too.
        Promise.resolve().then(() => check()),
        new Promise((_, reject) => {
          // NOT unref'd. This timer is the only thing that will ever settle
          // the race against a check that hangs forever — unref it and the
          // event loop empties with the probe still pending. The finally
          // block below clears it the moment the check wins instead.
          timer = setTimeout(() => reject(new Error("timeout")), this.timeoutMs);
        }),
      ]);
      return { status: "pass", durationMs: +(performance.now() - t0).toFixed(2) };
    } catch (err) {
      return {
        status: "fail",
        durationMs: +(performance.now() - t0).toFixed(2),
        // The MESSAGE only — a stack or a cause chain can carry a
        // connection string, and this object is served over HTTP.
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

// --- Task 2 ------------------------------------------------------------------

export class Readiness {
  #ready = false;
  #shuttingDown = false;

  get isReady(): boolean {
    return this.#ready;
  }

  get isShuttingDown(): boolean {
    return this.#shuttingDown;
  }

  markReady(): void {
    // A one-way door. A warm-up callback that resolves after SIGTERM must
    // not put a draining instance back into the load balancer's rotation.
    if (this.#shuttingDown) return;
    this.#ready = true;
  }

  markNotReady(): void {
    this.#ready = false;
    this.#shuttingDown = true;
  }
}

// --- Task 3 ------------------------------------------------------------------

export function drain(server: Server, options: DrainOptions = {}): Promise<DrainResult> {
  const { sweepMs = 50, deadlineMs = 10_000 } = options;

  return new Promise<DrainResult>((resolve) => {
    const t0 = Date.now();
    let forced = false;

    // Not listening: close() would still fire its callback with an
    // ERR_SERVER_NOT_RUNNING error, so short-circuit instead.
    if (!server.listening) {
      resolve({ ms: 0, forced: false });
      return;
    }

    const finish = () => {
      clearInterval(sweep);
      clearTimeout(deadline);
      resolve({ ms: Date.now() - t0, forced });
    };

    // 1. Stop accepting immediately; resolve when fully drained.
    server.close(() => finish());

    // 2. close() closed the connections that were idle AT THAT MOMENT.
    //    A connection with a request in flight was not one of them, and
    //    when it finishes nothing is watching it — so it sits out
    //    keepAliveTimeout (5s by default). Measured: 6814ms vs 811ms.
    const sweep = setInterval(() => server.closeIdleConnections(), sweepMs);

    // 3. One stuck request must not hold the deploy. This SEVERS in-flight
    //    requests, so it belongs here and nowhere else.
    const deadline = setTimeout(() => {
      forced = true;
      server.closeAllConnections();
    }, deadlineMs);

    // 4. Both are handles. Un-unref'd, they keep the event loop alive —
    //    exactly the leak this whole function exists to avoid.
    sweep.unref();
    deadline.unref();
  });
}

// --- Task 4 ------------------------------------------------------------------

export class ShutdownManager {
  readonly #steps: Array<{ name: string; step: ShutdownStep }> = [];
  readonly deadlineMs: number;
  #running: Promise<ShutdownResult> | undefined;

  constructor(deadlineMs = 30_000) {
    this.deadlineMs = deadlineMs;
  }

  get steps(): string[] {
    return this.#steps.map((s) => s.name);
  }

  add(name: string, step: ShutdownStep): this {
    this.#steps.push({ name, step });
    return this;
  }

  get isShuttingDown(): boolean {
    return this.#running !== undefined;
  }

  run(): Promise<ShutdownResult> {
    // Idempotent. The second SIGTERM — an operator hitting Ctrl-C again —
    // must not start a second sequence closing already-closed things.
    if (this.#running) return this.#running;
    this.#running = this.#execute();
    return this.#running;
  }

  async #execute(): Promise<ShutdownResult> {
    const ran: string[] = [];
    let firstError: Error | undefined;

    const sequence = (async () => {
      for (const { name, step } of this.#steps) {
        try {
          await step();
          ran.push(name);
        } catch (err) {
          // Keep going. You still want the logger flushed even when the
          // database close threw — and the FIRST error is the interesting
          // one, so don't let a later failure overwrite it.
          firstError ??= err instanceof Error ? err : new Error(String(err));
        }
      }
    })();

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      // Deliberately NOT unref'd: this timer is the only thing that will
      // settle the race if a step hangs. It is cleared the instant the
      // sequence finishes, so it can never outlive the shutdown.
      timer = setTimeout(() => resolve("timeout"), this.deadlineMs);
    });

    // Race, rather than await: a step that hangs must not hang shutdown.
    // Your deadline should be SHORTER than the orchestrator's grace period,
    // so you choose the exit code instead of collecting a SIGKILL.
    const outcome = await Promise.race([sequence.then(() => "done" as const), timeout]);
    clearTimeout(timer);

    if (outcome === "timeout") return { outcome: "timeout", ran };
    if (firstError) return { outcome: "failed", ran, error: firstError };
    return { outcome: "clean", ran };
  }
}
