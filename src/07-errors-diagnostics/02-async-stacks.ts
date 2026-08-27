/**
 * 02 — Async stack traces: what survives, what doesn't
 *
 * Run:  node src/07-errors-diagnostics/02-async-stacks.ts
 */

import { setTimeout as sleep } from "node:timers/promises";
import { EventEmitter } from "node:events";

const frames = (err: unknown, n = 6) =>
  ((err as Error).stack ?? "")
    .split("\n")
    .slice(0, n)
    .map((l) => "    " + l.trim())
    .join("\n");

function deep(): never {
  throw new Error("from deep");
}

console.log("=== 1. Across await: the stack SURVIVES ===");
{
  async function middle() {
    await sleep(1);
    deep();
  }
  async function outer() {
    await middle();
  }

  try {
    await outer();
  } catch (err) {
    console.log(frames(err));
  }
  console.log(`
  Both async callers are there. V8 stitches the async frames back together,
  so await costs you nothing in debuggability. This is the single best
  argument for async/await over callbacks.
`);
}

console.log("=== 2. Across a callback boundary: the stack is GONE ===");
{
  await new Promise<void>((resolve) => {
    setTimeout(() => {
      try {
        deep();
      } catch (err) {
        console.log(frames(err));
        resolve();
      }
    }, 0);
  });
  console.log(`
  Everything above the timer is Node internals. The code that SCHEDULED the
  timer — the request handler, the route, the caller — is nowhere.

  Same for EventEmitter listeners, setImmediate, fs callbacks, and any
  callback-based library. The async resource that queued the callback is a
  fresh stack root.
`);
}

console.log("=== 3. The same problem in an EventEmitter ===");
{
  const bus = new EventEmitter();
  bus.on("go", () => {
    try {
      deep();
    } catch (err) {
      console.log(frames(err, 5));
    }
  });

  function requestHandler() {
    bus.emit("go");
  }
  requestHandler();

  console.log(`
  Here emit() IS synchronous (module 03 §1), so requestHandler does appear.
  But the moment a listener does async work, or the emit is scheduled, the
  connection to the request is lost.
`);
}

console.log("=== 4. Recovering context with cause ===");
{
  // When you must cross a callback boundary, capture an error AT the
  // boundary — where the useful stack still exists — and attach the
  // low-level failure as the cause.
  function legacyApi(cb: (err: Error | null) => void) {
    setTimeout(() => cb(new Error("ETIMEDOUT")), 0);
  }

  function promisified(): Promise<void> {
    // Constructed HERE, on the caller's stack, before we lose it.
    const callSite = new Error("legacyApi failed");
    return new Promise((resolve, reject) => {
      legacyApi((err) => {
        if (err) {
          callSite.cause = err;
          reject(callSite); // ← keeps OUR stack, carries THEIR error
        } else resolve();
      });
    });
  }

  async function handler() {
    await promisified();
  }

  try {
    await handler();
  } catch (err) {
    console.log("  our stack (useful):");
    console.log(frames(err, 4));
    console.log("  cause (the real failure):", ((err as Error).cause as Error).message);
  }
  console.log(`
  This is what util.promisify and most modern wrappers do internally. If you
  wrap a callback API by hand, do it too — otherwise every failure points at
  node:internal/timers.
`);
}

console.log("=== 5. stackTraceLimit ===");
{
  console.log("  default Error.stackTraceLimit:", Error.stackTraceLimit);

  function recurse(n: number): never {
    if (n === 0) throw new Error("bottom");
    return recurse(n - 1);
  }

  try {
    recurse(30);
  } catch (err) {
    console.log("  frames captured at default:", ((err as Error).stack ?? "").split("\n").length - 1);
  }

  const original = Error.stackTraceLimit;
  Error.stackTraceLimit = 50;
  try {
    recurse(30);
  } catch (err) {
    console.log("  frames captured at 50:      ", ((err as Error).stack ?? "").split("\n").length - 1);
  }
  Error.stackTraceLimit = original;

  console.log(`
  10 frames is often not enough to see past framework middleware. Raise it
  while debugging:

      Error.stackTraceLimit = 50;          // in code
      node --stack-trace-limit=50 app.ts   // at launch

  Capturing stacks is not free — it's the reason creating millions of errors
  in a hot loop is slow. Set it back (or leave it at the default) in prod
  unless you've measured that you can afford more.
`);
}

console.log("=== 6. captureStackTrace: hide your own frames ===");
{
  class NoisyError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "NoisyError";
    }
  }

  class CleanError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "CleanError";
      // Drop every frame from this constructor upward.
      Error.captureStackTrace?.(this, CleanError);
    }
  }

  function throwNoisy() {
    throw new NoisyError("x");
  }
  function throwClean() {
    throw new CleanError("x");
  }

  try {
    throwNoisy();
  } catch (err) {
    console.log("  NoisyError top frame:", ((err as Error).stack ?? "").split("\n")[1]?.trim());
  }
  try {
    throwClean();
  } catch (err) {
    console.log("  CleanError top frame:", ((err as Error).stack ?? "").split("\n")[1]?.trim());
  }
  console.log(`
  Both point at throwNoisy/throwClean here because the constructor is a
  single frame. The difference matters with a deeper factory chain —
  a validation library that builds errors through three helper functions
  otherwise shows you three frames of ITS code before yours.

  Note: captureStackTrace is V8-only. The ?. keeps you portable.
`);
}

console.log("=== 7. Stacks are captured at CONSTRUCTION ===");
{
  const preMade = new Error("created early");
  await sleep(1);

  function throwLater() {
    throw preMade; // stack still points at where it was CREATED
  }

  try {
    throwLater();
  } catch (err) {
    const top = ((err as Error).stack ?? "").split("\n")[1]?.trim();
    console.log("  top frame:", top);
    console.log("  → points at the construction site, NOT throwLater()");
  }
  console.log(`
  So: never hoist errors to module scope, never reuse a singleton error
  object, and never build an error before you know you need it. Construct
  at the failure site.
`);
}

console.log("=== 8. Practical rules ===");
console.log(`
  ✓ Prefer async/await — stacks survive.
  ✓ Construct errors at the failure site.
  ✓ When wrapping a callback API, capture the call site first and attach
    the real failure via cause.
  ✓ Raise stackTraceLimit while debugging.
  ✗ Never throw strings or plain objects — no stack at all.
  ✗ Never reuse an error instance.
`);
