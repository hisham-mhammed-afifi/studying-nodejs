/** Runs every demo in module 04.  node src/04-buffers/index.ts */

import { spawnSync } from "node:child_process";
import path from "node:path";

const demos = [
  "01-creating.ts",
  "02-encodings.ts",
  "03-numbers.ts",
  "04-views.ts",
  "05-text-boundaries.ts",
  "06-performance.ts",
];

for (const demo of demos) {
  console.log(`\n${"═".repeat(72)}\n  ${demo}\n${"═".repeat(72)}`);
  const result = spawnSync(process.execPath, [path.join(import.meta.dirname, demo)], { stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`\n✖ ${demo} exited with code ${result.status}`);
    process.exitCode = 1;
  }
}
