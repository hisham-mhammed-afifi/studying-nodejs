/**
 * Runs every demo in module 01, in order, in a child process each so that the
 * output stays clean and one crash doesn't hide the rest.
 *
 * Run:  node src/01-modules/index.ts
 */

import { spawnSync } from "node:child_process";
import path from "node:path";

const demos = [
  "01-esm-vs-cjs.ts",
  "02-resolution.ts",
  "03-module-cache.ts",
  "04-process-globals.ts",
  "05-paths.ts",
];

for (const demo of demos) {
  console.log(`\n${"═".repeat(72)}\n  ${demo}\n${"═".repeat(72)}`);
  const result = spawnSync(process.execPath, [path.join(import.meta.dirname, demo)], {
    stdio: "inherit",
  });
  if (result.status !== 0) {
    console.error(`\n✖ ${demo} exited with code ${result.status}`);
    process.exitCode = 1;
  }
}
