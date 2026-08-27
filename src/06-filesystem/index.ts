/** Runs every demo in module 06.  node src/06-filesystem/index.ts */

import { spawnSync } from "node:child_process";
import path from "node:path";

const demos = [
  "01-apis.ts",
  "02-read-write.ts",
  "03-directories.ts",
  "04-races.ts",
  "05-watching.ts",
  "06-errors-limits.ts",
];

for (const demo of demos) {
  console.log(`\n${"═".repeat(72)}\n  ${demo}\n${"═".repeat(72)}`);
  const result = spawnSync(process.execPath, [path.join(import.meta.dirname, demo)], { stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`\n✖ ${demo} exited with code ${result.status}`);
    process.exitCode = 1;
  }
}
