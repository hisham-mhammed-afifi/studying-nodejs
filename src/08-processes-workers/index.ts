/** Runs every demo in module 08.  node src/08-processes-workers/index.ts */

import { spawnSync } from "node:child_process";
import path from "node:path";

const demos = [
  "01-child-process.ts",
  "02-worker-basics.ts",
  "03-messaging.ts",
  "04-worker-pool.ts",
  "05-cluster.ts",
  "06-comparison.ts",
];

for (const demo of demos) {
  console.log(`\n${"═".repeat(72)}\n  ${demo}\n${"═".repeat(72)}`);
  const result = spawnSync(process.execPath, [path.join(import.meta.dirname, demo)], { stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`\n✖ ${demo} exited with code ${result.status}`);
    process.exitCode = 1;
  }
}
