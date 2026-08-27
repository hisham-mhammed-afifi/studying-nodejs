/** Runs every demo in module 12.  node src/12-config-logging/index.ts */

import { spawnSync } from "node:child_process";
import path from "node:path";

const demos = [
  "01-config.ts",
  "02-typebox.ts",
  "03-layering.ts",
  "04-pino.ts",
  "05-request-logging.ts",
  "06-redaction.ts",
];

for (const demo of demos) {
  console.log(`\n${"═".repeat(72)}\n  ${demo}\n${"═".repeat(72)}`);
  const result = spawnSync(process.execPath, [path.join(import.meta.dirname, demo)], { stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`\n✖ ${demo} exited with code ${result.status}`);
    process.exitCode = 1;
  }
}
