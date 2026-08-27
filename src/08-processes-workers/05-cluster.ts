/**
 * 05 — cluster: N processes, one port
 *
 * Run:  node src/08-processes-workers/05-cluster.ts
 *
 * This file runs a real (tiny) clustered HTTP server, sends it some
 * requests, shows which worker handled each, then shuts down.
 */

import cluster from "node:cluster";
import { createServer } from "node:http";
import { availableParallelism } from "node:os";
import { once } from "node:events";

const WORKERS = Math.min(availableParallelism(), 4);
const PORT = 0; // 0 = let the OS pick a free port

if (cluster.isPrimary) {
  console.log(`=== 1. The primary forks ${WORKERS} workers ===`);
  console.log(`  primary pid ${process.pid}, availableParallelism() = ${availableParallelism()}\n`);

  // The primary creates the listening socket; workers inherit it. That is
  // why N processes can "listen" on one port without EADDRINUSE.
  const ready: Array<{ pid: number; port: number }> = [];

  for (let i = 0; i < WORKERS; i++) cluster.fork();

  cluster.on("message", (_worker, msg: { port: number; pid: number }) => {
    ready.push(msg);
  });

  // A worker dying is normal — restart it. This is cluster's main selling
  // point, and also the part your orchestrator already does for you.
  let expectingExits = false;
  cluster.on("exit", (worker, code, signal) => {
    if (expectingExits) return;
    console.log(`  worker ${worker.process.pid} died (code ${code}, signal ${signal}) — restarting`);
    cluster.fork();
  });

  // Wait for every worker to report its port.
  while (ready.length < WORKERS) await new Promise((r) => setTimeout(r, 20));

  const port = ready[0]!.port;
  console.log(`  ${WORKERS} workers listening on port ${port}:`, ready.map((r) => r.pid).join(", "));

  console.log("\n=== 2. Connections are distributed across workers ===");
  const handled = new Map<number, number>();
  for (let i = 0; i < 12; i++) {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    const body = (await res.json()) as { pid: number };
    handled.set(body.pid, (handled.get(body.pid) ?? 0) + 1);
  }
  console.log("  requests handled per worker pid:", Object.fromEntries(handled));
  console.log(`
  On Linux the default scheduling policy is round-robin in the primary
  (SCHED_RR). On Windows the OS distributes, which in practice means one
  worker often takes most connections. Neither is load-AWARE: a worker stuck
  in a 500ms CPU loop still gets handed new connections.
`);

  console.log("=== 3. ⚠ cluster does NOT fix a blocked event loop ===");
  const t0 = performance.now();
  const [slow, fast] = await Promise.all([
    fetch(`http://127.0.0.1:${port}/block`).then((r) => r.json() as Promise<{ pid: number }>),
    (async () => {
      await new Promise((r) => setTimeout(r, 20));
      const t = performance.now();
      const body = (await fetch(`http://127.0.0.1:${port}/`).then((r) => r.json())) as { pid: number };
      return { ...body, waitedMs: performance.now() - t };
    })(),
  ]);
  console.log(`  /block was handled by pid ${slow.pid}`);
  console.log(`  the concurrent fast request waited ${(fast as { waitedMs: number }).waitedMs.toFixed(0)}ms (pid ${fast.pid})`);
  console.log(`  total wall time: ${(performance.now() - t0).toFixed(0)}ms`);
  console.log(`
  If the fast request landed on a DIFFERENT worker it was quick; if it
  landed on the blocked one it waited out the whole 300ms.

  Workers give you MORE event loops, not FASTER ones. One slow route still
  freezes its worker and everything routed to it. For CPU-bound work you
  still need worker threads (§4 of this module).
`);

  console.log("=== 4. When cluster is the wrong answer ===");
  console.log(`
  If you deploy in containers, you probably want N CONTAINERS instead:

    • Your orchestrator already does restarts, health checks, rolling
      deploys and autoscaling. cluster reimplements all of that, worse.
    • ⚠ availableParallelism() reports the HOST's cores, not your cgroup CPU
      limit. A 1-CPU container forking 16 workers thrashes.
    • One process per container makes profiling, debugging and log
      correlation dramatically simpler.
    • Memory: every worker is a full Node process with its own heap.

  cluster still earns its place on a single VM or bare metal, on a dev
  machine, or in a CLI that serves locally.

  Also note: since workers are separate PROCESSES, nothing is shared.
  In-memory sessions, caches, rate-limit counters and WebSocket state all
  need to move to Redis or similar the moment you fork.
`);

  console.log("=== 5. Graceful shutdown ===");
  console.log(`
  process.on("SIGTERM", async () => {
    expectingExits = true;                       // don't restart on purpose
    for (const w of Object.values(cluster.workers ?? {})) {
      w?.send("shutdown");                       // ask nicely
    }
    setTimeout(() => {                           // then insist
      for (const w of Object.values(cluster.workers ?? {})) w?.kill("SIGKILL");
    }, 10_000).unref();
  });

  // in the worker:
  process.on("message", (msg) => {
    if (msg === "shutdown") server.close(() => process.exit(0));
  });

  server.close() stops accepting new connections and finishes in-flight
  ones — the same pattern as module 01 §4.5, once per worker.
`);

  // Tear down.
  expectingExits = true;
  for (const worker of Object.values(cluster.workers ?? {})) worker?.kill();
  await new Promise((r) => setTimeout(r, 200));
  console.log("  (demo workers shut down)");
} else {
  // ── Worker side ───────────────────────────────────────────────────────────
  const server = createServer((req, res) => {
    if (req.url === "/block") {
      // Deliberately freeze THIS worker's event loop.
      const until = Date.now() + 300;
      while (Date.now() < until) {
        /* blocking */
      }
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ pid: process.pid, url: req.url }));
  });

  server.listen(PORT, "127.0.0.1", () => {
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    process.send?.({ pid: process.pid, port });
  });

  await once(server, "listening");
}
