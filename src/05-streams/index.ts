/** Runs every demo in module 05.  node src/05-streams/index.ts */

import { spawnSync } from "node:child_process";
import path from "node:path";

const demos = [
  "01-why-streams.ts",
  "02-reading.ts",
  "03-backpressure.ts",
  "04-pipeline.ts",
  "05-transforms.ts",
  "06-web-streams.ts",
];

for (const demo of demos) {
  console.log(`\n${"═".repeat(72)}\n  ${demo}\n${"═".repeat(72)}`);
  const result = spawnSync(process.execPath, [path.join(import.meta.dirname, demo)], { stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`\n✖ ${demo} exited with code ${result.status}`);
    process.exitCode = 1;
  }
}
