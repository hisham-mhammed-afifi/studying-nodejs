/**
 * 04 — `process` and Node's globals
 *
 * Run:  node src/01-modules/04-process-globals.ts
 * Then: node src/01-modules/04-process-globals.ts --verbose foo bar
 * Then: node src/01-modules/04-process-globals.ts --slow   (and hit Ctrl+C)
 */

console.log("=== argv ===");
// argv[0] = the node binary, argv[1] = this script, the rest is the user's.
console.log("execPath:", process.argv[0]);
console.log("script:  ", process.argv[1]);
console.log("userArgs:", process.argv.slice(2));

// Node 18.3+ has a real parser built in — no yargs/commander for simple CLIs.
const { parseArgs } = await import("node:util");
const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    verbose: { type: "boolean", short: "v", default: false },
    slow: { type: "boolean", default: false },
  },
  allowPositionals: true,
  strict: false, // don't throw on unknown flags, so this demo is easy to play with
});
console.log("parsed flags:", values, "positionals:", positionals);

console.log("\n=== env ===");
// EVERY value is `string | undefined`. There are no numbers and no booleans.
// process.env.DEBUG = 0  actually stores the STRING "0", which is truthy.
console.log("typeof process.env.PATH:", typeof process.env.PATH);
console.log("missing key:", process.env.DEFINITELY_NOT_SET); // undefined

// Validate at the boundary, once, into a typed object. Never sprinkle
// `process.env.X` through your codebase.
function requireEnv(key: string): string {
  const v = process.env[key];
  if (v === undefined || v === "") throw new Error(`Missing required env var: ${key}`);
  return v;
}
function intEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new Error(`Env ${key} must be an integer, got ${raw}`);
  return n;
}
console.log("PORT (with fallback):", intEnv("PORT", 3000));
try {
  requireEnv("SECRET_KEY");
} catch (err) {
  console.log("validation works:", (err as Error).message);
}
// Node 20.6+ can load .env natively:  node --env-file=.env script.ts

console.log("\n=== platform & runtime info ===");
console.log({
  version: process.version,
  platform: process.platform, // "linux" | "darwin" | "win32" | ...
  arch: process.arch,
  pid: process.pid,
  uptimeSec: Number(process.uptime().toFixed(3)),
  rssMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
});

console.log("\n=== stdout is not always console.log ===");
// console.log adds a newline and formats objects. process.stdout.write is raw.
process.stdout.write("no newline...");
process.stdout.write(" ...same line\n");
// Important async gotcha: stdout is SYNCHRONOUS to a file and to a TTY on
// POSIX, but ASYNCHRONOUS to a pipe. So `process.exit()` right after a large
// write to a pipe can TRUNCATE your output. This is why you should prefer
// setting process.exitCode over calling process.exit().

console.log("\n=== exiting properly ===");
console.log(`
  process.exit(1)      stops the process immediately. Pending I/O is abandoned,
                       'beforeExit' does not fire, buffered stdout may be lost.
  process.exitCode = 1 records the intent. Node exits when the event loop has
                       nothing left to do, flushing everything. PREFER THIS.
`);

console.log("=== lifecycle events ===");
process.on("beforeExit", (code) => {
  // Fires when the loop empties. You may schedule more async work here, which
  // makes it fire AGAIN. Does NOT fire on explicit process.exit().
  console.log("[beforeExit]", code);
});
process.on("exit", (code) => {
  // The loop is already dead: only SYNCHRONOUS code runs here. No await, no I/O.
  console.log("[exit]", code);
});
process.on("uncaughtException", (err) => {
  // Log, flush, and DIE. The process is in an unknown state — "recovering"
  // means running on corrupt invariants. Same for 'unhandledRejection'.
  console.error("[uncaughtException]", err.message);
  process.exitCode = 1;
});

if (values.slow) {
  console.log("\nRunning for 30s. Press Ctrl+C to test graceful shutdown.");
  const timer = setInterval(() => process.stdout.write("."), 500);
  const shutdown = (signal: NodeJS.Signals) => {
    console.log(`\nGot ${signal}. Cleaning up...`);
    clearInterval(timer); // releases the loop → Node exits on its own
    process.exitCode = 0;
  };
  // SIGINT = Ctrl+C. SIGTERM = what Docker/Kubernetes/systemd send.
  // Handle BOTH. SIGKILL cannot be caught, by design.
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  setTimeout(() => shutdown("SIGTERM"), 30_000).unref();
  //                                            ^^^^^^^
  // unref() = "this timer should not keep the process alive". Essential for
  // background keepalives, health pings, and cache sweepers.
}
