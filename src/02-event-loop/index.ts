/** Runs every demo in module 02.  node src/02-event-loop/index.ts */

import { spawnSync } from "node:child_process";
import path from "node:path";

const demos = [
  "01-order.ts",
  "02-nexttick-vs-microtask.ts",
  "03-timers-vs-immediate.ts",
  "04-blocking.ts",
  "05-threadpool.ts",
  "06-yielding.ts",
];

for (const demo of demos) {
  console.log(`\n${"═".repeat(72)}\n  ${demo}\n${"═".repeat(72)}`);
  const result = spawnSync(process.execPath, [path.join(import.meta.dirname, demo)], { stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`\n✖ ${demo} exited with code ${result.status}`);
    process.exitCode = 1;
  }
}
