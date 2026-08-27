/** Runs every demo in module 11.  node src/11-fastify/index.ts */

import { spawnSync } from "node:child_process";
import path from "node:path";

const demos = [
  "01-vs-handrolled.ts",
  "02-validation.ts",
  "03-serialization.ts",
  "04-plugins.ts",
  "05-hooks.ts",
  "06-errors-testing.ts",
];

for (const demo of demos) {
  console.log(`\n${"═".repeat(72)}\n  ${demo}\n${"═".repeat(72)}`);
  const result = spawnSync(process.execPath, [path.join(import.meta.dirname, demo)], { stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`\n✖ ${demo} exited with code ${result.status}`);
    process.exitCode = 1;
  }
}
