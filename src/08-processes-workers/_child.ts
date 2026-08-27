/** A tiny forked child, used by 01-child-process.ts §7. */

process.on("message", (msg: unknown) => {
  const { job, n } = msg as { job: string; n: number };
  process.send?.({ job, input: n, result: job === "square" ? n * n : null, pid: process.pid });
});
