/**
 * EXERCISE 15 — The shutdown manager and the health registry
 *
 * The last exercise, and the one you would actually copy into a service.
 * Four pieces, each one of this module's measurements turned into a test.
 *
 * Check yourself:  node scripts/test.ts 15
 * Solution:        ./solution.ts   (try first!)
 */

import type { Server } from "node:http";

const TODO = (what: string): never => {
  throw new Error(`TODO: implement ${what}`);
};

// ─── Types ──────────────────────────────────────────────────────────────────

export type HealthStatus = "pass" | "fail";

export interface CheckResult {
  status: HealthStatus;
  durationMs: number;
  /** Present only when the check failed. Never contains a secret. */
  error?: string;
}

export interface HealthReport {
  status: HealthStatus;
  checks: Record<string, CheckResult>;
}

export type Check = () => Promise<unknown> | unknown;

export interface DrainOptions {
  /** How often to re-close connections that have become idle. Default 50. */
  sweepMs?: number;
  /** After this long, sever whatever is left. Default 10_000. */
  deadlineMs?: number;
}

export interface DrainResult {
  /** Wall-clock time until the server was fully closed. */
  ms: number;
  /** True when the deadline fired and connections were severed. */
  forced: boolean;
}

export type ShutdownStep = () => Promise<void> | void;

export interface ShutdownResult {
  /** "clean" — every step finished. "timeout" — the deadline fired. */
  outcome: "clean" | "timeout" | "failed";
  /** Names of the steps that ran, in order. */
  ran: string[];
  error?: Error;
}

// ─── Task 1: a health-check registry ────────────────────────────────────────
//
// Requirements:
//   • register(name, check) adds a check; checks run CONCURRENTLY
//   • a check that throws, rejects, or returns a rejected promise → "fail",
//     with `error` set to its message
//   • a check that exceeds `timeoutMs` → "fail" with error "timeout".
//     A hung dependency must not hang the probe: the whole point is to
//     answer a load balancer within its own timeout. Do NOT .unref() that
//     timer — against a check that never settles it is the only thing left
//     that can settle the race. Clear it when the check wins instead.
//   • overall status is "pass" only if EVERY check passed
//   • durationMs is recorded per check, pass or fail
//   • an empty registry reports "pass" — a service with no dependencies is
//     healthy, not broken
//
// See 06-deployment.ts §4.

export class HealthRegistry {
  readonly #checks = new Map<string, Check>();
  readonly timeoutMs: number;

  constructor(timeoutMs = 1000) {
    this.timeoutMs = timeoutMs;
  }

  get names(): string[] {
    return [...this.#checks.keys()];
  }

  register(_name: string, _check: Check): this {
    return TODO("HealthRegistry#register");
  }

  async run(): Promise<HealthReport> {
    return TODO("HealthRegistry#run");
  }
}

// ─── Task 2: readiness state ────────────────────────────────────────────────
//
// A tiny thing that is the FIRST step of every shutdown (05-shutdown.ts §4).
//
// Requirements:
//   • starts NOT ready — a process that has not warmed up must not be sent
//     traffic
//   • markReady() / markNotReady() flip it
//   • once markNotReady() has been called, markReady() must NOT work again:
//     shutdown is a one-way door, and a late warm-up callback must not put
//     a draining instance back into rotation
//   • isReady is a getter

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
    return TODO("Readiness#markReady");
  }

  markNotReady(): void {
    return TODO("Readiness#markNotReady");
  }
}

// ─── Task 3: draining an http server ────────────────────────────────────────
//
// The measured fix from 05-shutdown.ts §2-3.
//
// Requirements:
//   • resolve when the server is FULLY closed (the close callback fired)
//   • sweep server.closeIdleConnections() on an interval, because close()
//     only closed the connections that were idle at the moment it ran —
//     this is the difference between 6814ms and 811ms
//   • at deadlineMs, call server.closeAllConnections() and set forced:true.
//     In-flight requests are severed; that is the deliberate trade.
//   • .unref() BOTH timers, or they keep the process alive and you have
//     recreated the bug you are fixing
//   • clear both timers when the drain finishes
//   • draining a server that is not listening resolves immediately rather
//     than hanging or throwing

export function drain(_server: Server, _options: DrainOptions = {}): Promise<DrainResult> {
  return TODO("drain");
}

// ─── Task 4: the shutdown sequence ──────────────────────────────────────────
//
// Requirements:
//   • steps run IN THE ORDER REGISTERED — reverse order of startup is the
//     caller's job, but the manager must not reorder them
//   • run() is idempotent: a second call while shutting down returns the
//     SAME promise, it does not start a second sequence (05-shutdown.ts §5)
//   • if a step throws, remaining steps still run (you still want the
//     logger flushed even if the database close failed), and the outcome
//     is "failed" with the FIRST error
//   • if the whole sequence exceeds deadlineMs, resolve with outcome
//     "timeout" — do NOT hang. `ran` lists the steps that completed.
//   • clear the deadline timer once the sequence finishes. Unlike drain()'s
//     timers, do NOT unref this one: it is what rescues you from a step
//     that never settles.
//   • run() NEVER rejects. A shutdown path that throws is a shutdown path
//     that hangs, because nothing is left to catch it (03-lies.ts §3).

export class ShutdownManager {
  readonly #steps: Array<{ name: string; step: ShutdownStep }> = [];
  readonly deadlineMs: number;

  constructor(deadlineMs = 30_000) {
    this.deadlineMs = deadlineMs;
  }

  get steps(): string[] {
    return this.#steps.map((s) => s.name);
  }

  /** Registered steps run in this order. */
  add(_name: string, _step: ShutdownStep): this {
    return TODO("ShutdownManager#add");
  }

  get isShuttingDown(): boolean {
    return TODO("ShutdownManager#isShuttingDown");
  }

  run(): Promise<ShutdownResult> {
    return TODO("ShutdownManager#run");
  }
}
