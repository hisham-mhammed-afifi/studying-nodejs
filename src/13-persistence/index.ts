/** Runs every demo in module 13.  node src/13-persistence/index.ts */

import { spawnSync } from "node:child_process";
import path from "node:path";

const demos = [
  "01-basics.ts",
  "02-binding.ts",
  "03-types.ts",
  "04-transactions.ts",
  "05-migrations.ts",
  "06-queries.ts",
];

for (const demo of demos) {
  console.log(`\n${"═".repeat(72)}\n  ${demo}\n${"═".repeat(72)}`);
  // --no-warnings suppresses the ExperimentalWarning that node:sqlite emits
  // on every process start; it would otherwise drown the output.
  const result = spawnSync(process.execPath, ["--no-warnings", path.join(import.meta.dirname, demo)], {
    stdio: "inherit",
  });
  if (result.status !== 0) {
    console.error(`\n✖ ${demo} exited with code ${result.status}`);
    process.exitCode = 1;
  }
}
