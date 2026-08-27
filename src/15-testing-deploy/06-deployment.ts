/**
 * 15.6 — Signals, exit codes, health checks, and startup.
 *
 *   node src/15-testing-deploy/06-deployment.ts
 *
 * The parts of "it runs in production" that are actually Node's problem.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "node-study-15d-"));

function write(name: string, source: string): string {
  const file = path.join(dir, name);
  writeFileSync(file, source);
  return file;
}

function run(file: string, args: string[] = [], env: NodeJS.ProcessEnv = {}) {
  const r = spawnSync(process.execPath, ["--no-warnings", file, ...args], {
    encoding: "utf8",
    timeout: 15_000,
    env: { ...process.env, ...env },
  });
  return { status: r.status, out: ((r.stdout ?? "") + (r.stderr ?? "")).trim() };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. exitCode vs exit()
// ─────────────────────────────────────────────────────────────────────────────

console.log("=== 1. process.exitCode vs process.exit() ===");

const exitBody = (how: string) => `
process.on("exit", (code) => console.log("  exit handler ran, code " + code));
setTimeout(() => console.log("  TIMER RAN (a pending response, a log flush)"), 20);
Promise.resolve().then(() => console.log("  microtask ran"));
console.log("  end of synchronous code");
${how}
console.log("  after the exit call");
`;

const soft = run(write("soft.ts", exitBody("process.exitCode = 3;")));
const hard = run(write("hard.ts", exitBody("process.exit(3);")));

console.log(`  process.exitCode = 3   → exit ${soft.status}`);
console.log(soft.out.split("\n").map((l) => "  " + l).join("\n"));
console.log(`\n  process.exit(3)        → exit ${hard.status}`);
console.log(hard.out.split("\n").map((l) => "  " + l).join("\n"));

console.log(`
  process.exit() skipped the microtask AND the timer. In a real service
  those are: the response you were about to write, the database
  transaction you were about to commit, and the log line explaining why
  you shut down — pino's transport is asynchronous (module 12 §6), so
  process.exit() truncates your own postmortem.

  Set process.exitCode and let the loop drain. Reach for process.exit()
  only when your own deadline has ALREADY expired, and you have decided
  that losing work beats hanging.

  Exit codes worth using consistently:
    0   clean shutdown
    1   generic failure
    2   invalid configuration (§5) — a human must fix it; do not restart
    130 conventionally, killed by SIGINT
`);

// ─────────────────────────────────────────────────────────────────────────────
// 2. Signals
// ─────────────────────────────────────────────────────────────────────────────

console.log("=== 2. Signals ===");

const withHandler = write(
  "sig.ts",
  `
const keepAlive = setInterval(() => {}, 1000);
for (const s of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  process.on(s, () => {
    console.log("caught " + s + ", shutting down cleanly");
    clearInterval(keepAlive);
    process.exitCode = 0;
  });
}
console.log("ready");
`,
);
const noHandler = write("nosig.ts", `setInterval(() => {}, 1000); console.log("ready");`);
const ignoring = write(
  "ignore.ts",
  `
setInterval(() => {}, 1000);
process.on("SIGTERM", () => console.log("caught SIGTERM and... did nothing"));
console.log("ready");
`,
);

async function signalTest(file: string, signal: NodeJS.Signals, killAfterMs?: number) {
  return new Promise<string>((resolve) => {
    const child = spawn(process.execPath, ["--no-warnings", file], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const t0 = Date.now();
    child.stdout.on("data", (d: Buffer) => {
      out += d;
      if (out.includes("ready") && !out.includes("SENT")) {
        out += "SENT";
        child.kill(signal);
        // The orchestrator's grace period, in miniature.
        if (killAfterMs !== undefined) setTimeout(() => child.kill("SIGKILL"), killAfterMs);
      }
    });
    child.on("exit", (code, sig) => {
      const said = out.replace("ready\n", "").replace("SENT", "").trim().split("\n").join(" / ");
      resolve(
        `exit code ${String(code).padEnd(4)} signal ${String(sig).padEnd(8)} after ${String(Date.now() - t0).padStart(4)}ms  ${said}`,
      );
    });
  });
}

for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  console.log(`  handled   ${sig.padEnd(8)} → ${await signalTest(withHandler, sig)}`);
}
console.log(`  unhandled SIGTERM  → ${await signalTest(noHandler, "SIGTERM")}`);
console.log(`  IGNORED   SIGTERM  → ${await signalTest(ignoring, "SIGTERM", 1500)}`);

console.log(`
  Read the last two rows together.

  With NO handler, the default disposition terminates the process:
  exit code null, signal SIGTERM. Nothing gets to run.

  Installing a handler REPLACES that default entirely. The third row is a
  handler that logs and forgets to exit — the process now ignores SIGTERM
  completely and sits there until something SIGKILLs it. In Kubernetes
  that is a 30-second pause on every single pod, every deploy.

    Always end the signal path with an exit.
    SIGKILL cannot be caught. Ever. It is not a failure of your code.

  Two Docker specifics that make all of this moot when you get them wrong:

    CMD npm start                 ✗ npm is PID 1; your process is a child
                                    and never sees the signal
    CMD ["node", "src/server.ts"] ✓ exec form, your process IS PID 1

    docker run --init             adds a real init to reap zombies
`);

// ─────────────────────────────────────────────────────────────────────────────
// 3. The last-resort handlers
// ─────────────────────────────────────────────────────────────────────────────

console.log("=== 3. uncaughtException and unhandledRejection ===");

const crash = run(
  write(
    "crash.ts",
    `
setTimeout(() => console.log("  this timer would have run"), 30);
Promise.reject(new Error("nobody caught me"));
`,
  ),
);
console.log(`  unhandled rejection, no handler → exit ${crash.status}`);
console.log(`  stdout: ${JSON.stringify(crash.out.split("\n")[0]?.slice(0, 70))}`);

const handled = run(
  write(
    "handled.ts",
    `
process.on("unhandledRejection", (reason) => {
  console.log("  logged: " + (reason as Error).message);
  process.exitCode = 1;   // ← still exit. See below.
});
Promise.reject(new Error("nobody caught me"));
setTimeout(() => console.log("  the timer still ran"), 30);
`,
  ),
);
console.log(`  with a handler                  → exit ${handled.status}`);
console.log(handled.out.split("\n").map((l) => "  " + l).join("\n"));

console.log(`
  Since Node 15 an unhandled rejection is FATAL by default, and that is
  the right default: an unhandled rejection means a code path you did not
  think about, and the process state after it is unknown.

  So the handler's job is to LOG AND DIE, not to continue:

    process.on("uncaughtException", (err) => {
      log.fatal({ err }, "uncaught exception");
      // No await — the loop may be unusable. Flush synchronously if at all.
      process.exit(1);
    });

  Continuing after an uncaught exception is how you get the really
  expensive incidents: a half-finished transaction, a corrupted cache, a
  process serving wrong answers for six hours because it "recovered".

  Operational errors (module 07 §2) belong in a try/catch at the boundary.
  If it reached this handler, it was a bug — restart.
`);

// ─────────────────────────────────────────────────────────────────────────────
// 4. Readiness is not liveness
// ─────────────────────────────────────────────────────────────────────────────

console.log("=== 4. Two health checks that answer different questions ===");

const health = run(
  write(
    "health.ts",
    `
import { createServer } from "node:http";
import { once } from "node:events";
import { monitorEventLoopDelay } from "node:perf_hooks";

const loop = monitorEventLoopDelay({ resolution: 10 });
loop.enable();

let ready = false;        // flips true after warm-up, false on SIGTERM
let dbUp = true;          // pretend dependency

const server = createServer((req, res) => {
  res.setHeader("content-type", "application/json");

  if (req.url === "/livez") {
    // LIVENESS: "is this process wedged?" Check almost nothing. If a
    // RESTART would not fix it, it does not belong here.
    const lagMs = loop.mean / 1e6;
    const wedged = lagMs > 1000;
    res.statusCode = wedged ? 503 : 200;
    res.end(JSON.stringify({ status: wedged ? "wedged" : "ok", loopLagMs: +lagMs.toFixed(2) }));
    return;
  }

  if (req.url === "/readyz") {
    // READINESS: "should I get traffic RIGHT NOW?"
    const checks = { started: ready, database: dbUp };
    const ok = Object.values(checks).every(Boolean);
    res.statusCode = ok ? 200 : 503;
    res.end(JSON.stringify({ status: ok ? "ready" : "not ready", checks }));
    return;
  }

  res.statusCode = 404;
  res.end("{}");
});

server.listen(0);
await once(server, "listening");
const { port } = server.address() as { port: number };
const hit = async (p: string) => {
  const r = await fetch("http://127.0.0.1:" + port + p);
  return r.status + " " + (await r.text());
};

console.log("  during start-up:");
console.log("    /livez   " + await hit("/livez"));
console.log("    /readyz  " + await hit("/readyz") + "   ← alive but NOT ready");

ready = true;
console.log("  warmed up:");
console.log("    /readyz  " + await hit("/readyz"));

dbUp = false;
console.log("  database blip:");
console.log("    /livez   " + await hit("/livez") + "   ← still alive; do NOT restart");
console.log("    /readyz  " + await hit("/readyz"));

dbUp = true;
ready = false;   // this is step 1 of shutdown (05 §4)
console.log("  SIGTERM received:");
console.log("    /readyz  " + await hit("/readyz") + "   ← stop sending traffic");
console.log("    /livez   " + await hit("/livez") + "   ← still draining, still alive");

server.close();
process.exit(0);
`,
  ),
);
console.log(health.out);

console.log(`
                  question                     wrong answer costs you
  ─────────────   ──────────────────────────   ─────────────────────────
  liveness        is this process WEDGED?      a restart loop
  readiness       should I get traffic NOW?    502s, or a black hole

  The failure that keeps happening: a readiness probe that checks the
  database; the database hiccups for three seconds; EVERY instance reports
  unready at once; the load balancer has nowhere to send traffic. A total
  outage caused entirely by the health check.

  Mitigations, in order of how much they help:
    • never check a shared dependency in LIVENESS — a restart cannot fix
      the database, and restarting every instance makes it worse
    • in readiness, only check what THIS instance cannot serve without
    • cache the result for a few seconds; a probe every 2s × 50 pods is
      real load on the thing you are checking
    • fail readiness on a SUSTAINED failure, not the first one

  Event-loop lag is the one honest liveness signal (module 02 §7): if the
  loop is blocked, the process genuinely is wedged, and a restart genuinely
  is the fix.
`);

// ─────────────────────────────────────────────────────────────────────────────
// 5. Fail at startup, not at 3am
// ─────────────────────────────────────────────────────────────────────────────

console.log("=== 5. Validate configuration before you listen ===");

const boot = write(
  "boot.ts",
  `
import { createServer } from "node:http";

// Module 12's lesson, one line: parse the environment ONCE, at the top,
// and refuse to start if it is wrong.
function loadConfig() {
  const errors: string[] = [];
  const port = Number(process.env["PORT"] ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push("PORT must be 1-65535");

  const secret = process.env["SESSION_SECRET"] ?? "";
  if (secret.length < 32) errors.push("SESSION_SECRET must be at least 32 characters");

  const env = process.env["NODE_ENV"] ?? "development";
  if (!["development", "test", "production"].includes(env)) errors.push("NODE_ENV is invalid");

  if (errors.length > 0) {
    // stderr, not a logger — the logger may itself need config.
    console.error("configuration invalid:");
    for (const e of errors) console.error("  - " + e);
    process.exit(2);           // 2 = "a human must fix this"; do not restart
  }
  return { port, secret, env };
}

const config = loadConfig();
console.log("  started on port " + config.port + " in " + config.env);
createServer().listen(config.port).close();
`,
);

const badBoot = run(boot, [], { PORT: "99999", SESSION_SECRET: "short", NODE_ENV: "production" });
const goodBoot = run(boot, [], { PORT: "8080", SESSION_SECRET: "x".repeat(32), NODE_ENV: "production" });

console.log(`  bad config  → exit ${badBoot.status}`);
console.log(badBoot.out.split("\n").map((l) => "  " + l).join("\n"));
console.log(`  good config → exit ${goodBoot.status}`);
console.log(goodBoot.out.split("\n").map((l) => "  " + l).join("\n"));

console.log(`
  Exit code 2, before listen(). The deployment fails immediately and
  visibly, instead of rolling out a fleet of processes that will each
  throw the first time somebody hits the one route that reads that
  variable. A crash loop at deploy time is a good outcome — it is caught
  by the rollout, and it never reaches a user.

  Note the exit code choice: a restart cannot fix a missing secret, so
  distinguish it from a crash. Orchestrators can be told not to retry a 2.
`);

// ─────────────────────────────────────────────────────────────────────────────
// 6. The checklist
// ─────────────────────────────────────────────────────────────────────────────

console.log("=== 6. Before it goes out ===");
console.log(`
  Process
    □ exec-form CMD, so your process is PID 1 and gets the signal
    □ SIGTERM and SIGINT handled, once, and always ending in an exit
    □ a shutdown deadline SHORTER than the orchestrator's grace period
    □ uncaughtException / unhandledRejection: log, then die
    □ process.exitCode, not process.exit(), on the clean path

  Traffic
    □ readiness flips false FIRST, then a pause, then close (05 §4)
    □ the drain sweeps closeIdleConnections, with a deadline (05 §3)
    □ liveness checks the process, readiness checks the dependencies
    □ keepAliveTimeout LONGER than the load balancer's idle timeout,
      or the LB reuses a socket you are about to close — a 502 with no
      matching error in your logs

  Config & logs
    □ every environment variable validated at startup, exit 2 on failure
    □ no secret in a log line, an error message, or a JWT (modules 12, 14)
    □ structured JSON logs to stdout; the platform collects them
    □ a request id through AsyncLocalStorage (module 07 §5)

  Tests
    □ --test-timeout set, so a leaked handle fails instead of hanging
    □ no .only committed (grep for it in CI — it is one line)
    □ coverage as a ratchet, watching the BRANCH column
    □ a test that actually asserts the shutdown contract (04 §4)
`);

export {};
