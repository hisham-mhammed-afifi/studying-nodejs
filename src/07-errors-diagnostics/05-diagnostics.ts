/**
 * 05 — diagnostics_channel, perf_hooks, process.report
 *
 * Run:  node src/07-errors-diagnostics/05-diagnostics.ts
 */

import dc from "node:diagnostics_channel";
import { performance, PerformanceObserver, monitorEventLoopDelay } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";

console.log("=== 1. diagnostics_channel: free when nobody is listening ===");
{
  const channel = dc.channel("app:query");
  console.log("  hasSubscribers before subscribing:", channel.hasSubscribers);

  // The guard is the point: publishing to a channel with no subscribers is
  // cheap, but BUILDING the message object isn't. Guard the construction.
  function query(sql: string, ms: number) {
    if (channel.hasSubscribers) {
      channel.publish({ sql, durationMs: ms, timestamp: Date.now() });
    }
  }

  query("SELECT 1", 3); // nobody listening — nothing happens, nothing allocated

  const seen: Array<{ sql: string; durationMs: number }> = [];
  dc.subscribe("app:query", (msg) => seen.push(msg as { sql: string; durationMs: number }));

  console.log("  hasSubscribers after: ", channel.hasSubscribers);
  query("SELECT * FROM users WHERE id = $1", 42);
  query("UPDATE orders SET status = $1", 7);
  console.log("  observed:", seen);

  console.log(`
  This is how APM agents instrument Node without monkey-patching. Your
  library publishes; the observer is somebody else's problem.

  Node core publishes its own channels too — http.client.request.start,
  http.server.request.start, net.client.socket, dns.lookup.start, and more.
`);
}

console.log("=== 2. tracingChannel: start / end / error, for free ===");
{
  const trace = dc.tracingChannel("app:handler");

  const timings: Array<{ name: string; ms: number }> = [];
  const errors: string[] = [];

  trace.subscribe({
    start(msg) {
      (msg as { _t0?: number })._t0 = performance.now();
    },
    end(msg) {
      const m = msg as { _t0?: number; route?: string };
      timings.push({ name: m.route ?? "?", ms: performance.now() - (m._t0 ?? 0) });
    },
    error(msg) {
      errors.push(((msg as { error?: Error }).error ?? new Error("?")).message);
    },
    asyncStart() {},
    asyncEnd() {},
  });

  await trace.tracePromise(
    async () => {
      await sleep(15);
      return "ok";
    },
    { route: "GET /users" },
  );

  await trace
    .tracePromise(
      async () => {
        await sleep(5);
        throw new Error("upstream 503");
      },
      { route: "GET /orders" },
    )
    .catch(() => {});

  console.log("  timings:", timings.map((t) => `${t.name} ${t.ms.toFixed(0)}ms`));
  console.log("  errors: ", errors);

  console.log(`
  tracingChannel wraps ONE operation and emits start / end / asyncStart /
  asyncEnd / error. traceSync, tracePromise, and traceCallback cover the
  three shapes. You get timing and error rates for every instrumented
  operation without touching the operation's own code.
`);
}

console.log("=== 3. perf_hooks: marks and measures ===");
{
  const durations: Array<[string, number]> = [];
  const obs = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) durations.push([entry.name, entry.duration]);
  });
  obs.observe({ entryTypes: ["measure"] });

  performance.mark("db:start");
  await sleep(20);
  performance.mark("db:end");
  performance.measure("db-query", "db:start", "db:end");

  performance.mark("render:start");
  await sleep(10);
  performance.mark("render:end");
  performance.measure("render", "render:start", "render:end");

  await sleep(20); // let the observer flush
  obs.disconnect();

  for (const [name, ms] of durations) console.log(`  ${name}: ${ms.toFixed(1)}ms`);

  // Housekeeping: marks accumulate. Clear them, or a long-running process
  // slowly grows a list of every mark it ever made.
  performance.clearMarks();
  performance.clearMeasures();

  console.log(`
  Marks/measures are observable by profilers and by --cpu-prof, so they show
  up in the flame chart as named regions. Useful for annotating phases of a
  request that would otherwise be an anonymous blob of frames.
`);
}

console.log("=== 4. Event loop lag (the metric that predicts outages) ===");
{
  const h = monitorEventLoopDelay({ resolution: 10 });
  h.enable();

  // Some honest work, then a deliberate block.
  await sleep(50);
  const until = Date.now() + 120;
  while (Date.now() < until) {
    /* blocking on purpose */
  }
  await sleep(50);

  h.disable();
  console.log(`  mean ${(h.mean / 1e6).toFixed(1)}ms   max ${(h.max / 1e6).toFixed(1)}ms   p99 ${(h.percentile(99) / 1e6).toFixed(1)}ms`);
  console.log(`
  Export p99 lag as a gauge and alert on it. It is the earliest signal that
  something is blocking the loop — it moves before latency does, and long
  before health checks fail. (Module 02 §6.)
`);
}

console.log("=== 5. process.report: a full snapshot ===");
{
  const report = process.report?.getReport() as
    | {
        header?: { nodejsVersion?: string; cpus?: unknown[] };
        libuv?: Array<{ type: string; is_active?: boolean }>;
        javascriptHeap?: { totalMemory?: number; usedMemory?: number };
      }
    | undefined;

  const handles = report?.libuv ?? [];
  const byType = new Map<string, number>();
  for (const h of handles) byType.set(h.type, (byType.get(h.type) ?? 0) + 1);

  console.log("  node version:", report?.header?.nodejsVersion);
  console.log("  heap used:   ", ((report?.javascriptHeap?.usedMemory ?? 0) / 1024 / 1024).toFixed(1), "MB");
  console.log("  libuv handles by type:", Object.fromEntries(byType));

  console.log(`
  The report includes: stacks for every thread, the full heap summary, every
  libuv handle (files, sockets, timers), resource limits, environment, and
  the loaded shared libraries.

  Count the 'file' handles to find an fd leak (module 06 §9). Count 'tcp' to
  find leaked sockets.

  Capture one from a LIVE, possibly hung process:

      node --report-on-signal app.ts
      kill -USR2 <pid>            # writes a JSON report to cwd

      node --report-uncaught-exception app.ts    # auto-report on crash
`);
}

console.log("=== 6. Which tool for which symptom ===");
console.log(`
  high CPU                  node --cpu-prof app.ts   → open the .cpuprofile
                            in Chrome DevTools → Performance
  growing RSS               node --inspect, DevTools Memory tab, take TWO
                            heap snapshots minutes apart and diff them
  high p99 but low CPU      event loop lag histogram (§4) — something is
                            blocking, or you're waiting on a slow dependency
  EMFILE after hours        process.report libuv 'file' handles; lsof -p
  "which query was slow?"   diagnostics_channel + a histogram (§1, §2)
  hung / unresponsive       kill -USR2 with --report-on-signal, read the
                            stacks
  mysterious warning        node --trace-warnings app.ts (adds a stack)
  accidental sync I/O       node --trace-sync-io app.ts

  Start from the symptom, not from the tool. The most common mistake is
  reaching for a CPU profile when the problem is that you're blocked on I/O.
`);
