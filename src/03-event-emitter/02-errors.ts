/**
 * 02 — Errors: the part that kills production servers
 *
 * Run:  node src/03-event-emitter/02-errors.ts
 */

import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";

console.log("=== 1. A throwing listener throws out of emit() ===");
{
  const bus = new EventEmitter();
  bus.on("go", () => {
    throw new Error("listener exploded");
  });
  bus.on("go", () => console.log("  this second listener never runs"));

  try {
    bus.emit("go");
  } catch (err) {
    console.log("  caught at the emit() call site:", (err as Error).message);
  }
  // Because dispatch is synchronous, the exception propagates up the CALLER's
  // stack — and it aborts the remaining listeners. One bad subscriber can
  // silently break every subscriber registered after it.
}

console.log("\n=== 2. The 'error' event is special-cased ===");
console.log(`
  Emitting 'error' with NO 'error' listener does not just do nothing — Node
  throws it as an uncaught exception and the process dies:

      const e = new EventEmitter();
      e.emit("error", new Error("boom"));   // ← process exits here

  Any other event name with no listeners is a silent no-op. 'error' is the
  one exception, and it is the reason "our server randomly restarts" is so
  often an unhandled socket or stream error.
`);

// Demonstrate in a child process, so this one survives.
{
  const code = `
    const { EventEmitter } = require("node:events");
    const e = new EventEmitter();
    console.log("about to emit error with no listener...");
    e.emit("error", new Error("boom"));
    console.log("UNREACHABLE");
  `;
  const r = spawnSync(process.execPath, ["-e", code], { encoding: "utf8" });
  console.log("  child stdout:", JSON.stringify(r.stdout.trim()));
  console.log("  child exit code:", r.status, "(non-zero = it crashed)");
  console.log("  first line of stderr:", r.stderr.split("\n")[0]);
}

console.log("\n=== 3. So: always attach an error listener ===");
{
  const bus = new EventEmitter();
  bus.on("error", (err: Error) => console.log("  handled safely:", err.message));
  bus.emit("error", new Error("boom"));
  console.log("  still alive ✓");
  console.log(`
  Attach it to EVERY long-lived emitter: net.Socket, http.Server, streams,
  child processes, database clients. Do it at construction time, before any
  chance of an error. A common shape:

      const server = http.createServer(handler);
      server.on("clientError", (err, socket) => socket.destroy());
      server.on("error", (err) => { log.fatal(err); process.exitCode = 1; });
`);
}

console.log("=== 4. Async listeners are NOT awaited ===");
{
  const bus = new EventEmitter();
  let finished = false;
  bus.on("save", async () => {
    await new Promise<void>((r) => setTimeout(r, 20));
    finished = true;
    console.log("  ...async listener finally finished");
  });

  bus.emit("save");
  console.log("  emit() returned immediately. finished =", finished);
  await new Promise<void>((r) => setTimeout(r, 40));
  console.log("  40ms later, finished =", finished);
  console.log(`
  emit() calls your listener, gets a Promise back, and DROPS IT. You have no
  completion signal, no ordering guarantee, and no error propagation.

  If you need to wait for handlers, an emitter is the wrong tool:

      const hooks: Array<() => Promise<void>> = [];
      hooks.push(async () => { await db.write(); });
      await Promise.all(hooks.map(h => h()));   // explicit, awaited, typed
`);
}

console.log("=== 5. A rejecting async listener = unhandled rejection ===");
{
  const code = `
    const { EventEmitter } = require("node:events");
    const e = new EventEmitter();
    e.on("go", async () => { throw new Error("async boom"); });
    e.emit("go");
    setTimeout(() => console.log("UNREACHABLE"), 50);
  `;
  const r = spawnSync(process.execPath, ["-e", code], { encoding: "utf8" });
  console.log("  exit code:", r.status, "— unhandled rejections kill the process by default");
  console.log("  stderr mentions:", r.stderr.includes("async boom") ? "'async boom' ✓" : "(not found)");
}

console.log("\n=== 6. captureRejections routes them to 'error' ===");
{
  const bus = new EventEmitter({ captureRejections: true });
  bus.on("error", (err: Error) => console.log("  rejection arrived as an error event:", err.message));
  bus.on("go", async () => {
    throw new Error("async boom");
  });
  bus.emit("go");
  await new Promise<void>((r) => setTimeout(r, 10));
  console.log(`
  captureRejections turns a silent unhandled rejection into something your
  existing 'error' handler already deals with. Cheap insurance on any emitter
  whose listeners might be async. It does NOT make emit() wait for them.

  You can flip the default process-wide:
      EventEmitter.captureRejections = true;   // before creating emitters
`);
}

console.log("=== 7. Last line of defence ===");
console.log(`
  process.on("uncaughtException", handler)
  process.on("unhandledRejection", handler)

  These are for LOGGING and then EXITING. Do not "recover": after an uncaught
  exception, some listener was interrupted midway, so your invariants may be
  broken. Log with full context, flush, set process.exitCode = 1, and let a
  supervisor restart you.

      process.on("uncaughtException", (err) => {
        log.fatal({ err }, "uncaught");
        server.close(() => process.exit(1));
        setTimeout(() => process.exit(1), 5_000).unref();  // don't hang forever
      });
`);
