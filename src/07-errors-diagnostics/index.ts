/** Runs every demo in module 07.  node src/07-errors-diagnostics/index.ts */

import { spawnSync } from "node:child_process";
import path from "node:path";

const demos = [
  "01-errors.ts",
  "02-async-stacks.ts",
  "03-strategy.ts",
  "04-async-context.ts",
  "05-diagnostics.ts",
  "06-logging.ts",
];

for (const demo of demos) {
  console.log(`\n${"═".repeat(72)}\n  ${demo}\n${"═".repeat(72)}`);
  const result = spawnSync(process.execPath, [path.join(import.meta.dirname, demo)], { stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`\n✖ ${demo} exited with code ${result.status}`);
    process.exitCode = 1;
  }
}
