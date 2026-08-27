/** Runs every demo in module 10.  node src/10-routing-middleware/index.ts */

import { spawnSync } from "node:child_process";
import path from "node:path";

const demos = [
  "01-routing.ts",
  "02-matchers.ts",
  "03-middleware.ts",
  "04-compose.ts",
  "05-common.ts",
  "06-pitfalls.ts",
];

for (const demo of demos) {
  console.log(`\n${"═".repeat(72)}\n  ${demo}\n${"═".repeat(72)}`);
  const result = spawnSync(process.execPath, [path.join(import.meta.dirname, demo)], { stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`\n✖ ${demo} exited with code ${result.status}`);
    process.exitCode = 1;
  }
}
