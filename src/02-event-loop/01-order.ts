/**
 * 01 — The ordering puzzle
 *
 * BEFORE RUNNING: write down the order you expect. Seriously. The gap between
 * your prediction and the output is the entire lesson — and there is a trap
 * here that catches almost everyone.
 *
 * Run:  node src/02-event-loop/01-order.ts
 */

import { readFile } from "node:fs";

console.log("1  sync: start");

setTimeout(() => console.log("6  timers phase: setTimeout 0"), 0);

setImmediate(() => console.log("7  check phase: setImmediate"));

Promise.resolve().then(() => console.log("3  microtask: promise.then"));

queueMicrotask(() => console.log("4  microtask: queueMicrotask"));

process.nextTick(() => console.log("5  nextTick — LAST?! see the note below"));

readFile(import.meta.filename, () => {
  // We are now inside the POLL phase, in a plain callback. Everything scheduled
  // from here follows the classic rules, with no ESM weirdness.
  console.log("8  poll phase: fs callback fired");

  process.nextTick(() => console.log("9  ...its nextTick   (nextTick FIRST here)"));
  Promise.resolve().then(() => console.log("10 ...its microtask"));
  setImmediate(() => console.log("11 ...its setImmediate (check is the NEXT phase)"));
  setTimeout(() => console.log("12 ...its setTimeout 0 (timers = NEXT lap)"), 0);
});

console.log("2  sync: end");

/*
ACTUAL OUTPUT
─────────────
1  sync: start
2  sync: end
3  microtask: promise.then
4  microtask: queueMicrotask
5  nextTick — LAST?!            ← the trap
6  timers phase: setTimeout 0       ← 6 and 7 may SWAP; see 03-timers-vs-immediate.ts
7  check phase: setImmediate
8  poll phase: fs callback fired
9  ...its nextTick               ← here nextTick wins, as advertised
10 ...its microtask
11 ...its setImmediate
12 ...its setTimeout 0

THE TRAP: "nextTick always beats promises" is only true INSIDE the loop
──────────────────────────────────────────────────────────────────────────
Look at 3-4-5 versus 9-10. Same two mechanisms, opposite order.

At the TOP LEVEL OF AN ESM MODULE, promises win. Why: ESM evaluation is itself
driven by promises — Node evaluates the module graph from inside a microtask.
So the promise callbacks you queue are drained as part of that same microtask
checkpoint, before control ever returns to the layer that processes nextTick.

In a CommonJS file, or anywhere inside the loop (an I/O callback, a timer),
the module body is plain synchronous code and nextTick wins as documented.

Verify it yourself:

    # CJS: nextTick first
    node -e 'Promise.resolve().then(()=>console.log("promise")); process.nextTick(()=>console.log("nextTick"))'

    # ESM top level: promise first
    node --input-type=module -e 'Promise.resolve().then(()=>console.log("promise")); process.nextTick(()=>console.log("nextTick"))'

    # ESM but inside a timer: nextTick first again
    node --input-type=module -e 'setTimeout(()=>{Promise.resolve().then(()=>console.log("promise")); process.nextTick(()=>console.log("nextTick"))},0)'

The real lesson is not the trivia. It is: **if your correctness depends on
nextTick-vs-promise ordering, your code is broken.** That ordering is an
implementation detail that changed with ESM and could change again. Use
explicit sequencing (await, callbacks, a queue) instead.

THE PARTS THAT *ARE* RELIABLE
─────────────────────────────
• All synchronous code runs before any callback. Always.
• Both microtask queues drain COMPLETELY before the loop advances a phase.
  That is why 9 and 10 both run before 11.
• Within one loop iteration the phase order is fixed:
      timers → pending → poll → check → close
  So from inside an I/O (poll) callback, setImmediate (check, same lap) always
  beats setTimeout 0 (timers, next lap). That guarantee is worth relying on.

TRY THIS
────────
Copy this file to 01-order.cjs, convert the imports to require(), and re-run.
Watch line 5 move to the top.
*/
