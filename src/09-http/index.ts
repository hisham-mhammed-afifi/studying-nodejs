/** Runs every demo in module 09.  node src/09-http/index.ts */

import { spawnSync } from "node:child_process";
import path from "node:path";

const demos = [
  "01-anatomy.ts",
  "02-request-body.ts",
  "03-responses.ts",
  "04-timeouts-keepalive.ts",
  "05-errors-shutdown.ts",
  "06-client.ts",
];

for (const demo of demos) {
  console.log(`\n${"═".repeat(72)}\n  ${demo}\n${"═".repeat(72)}`);
  const result = spawnSync(process.execPath, [path.join(import.meta.dirname, demo)], { stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`\n✖ ${demo} exited with code ${result.status}`);
    process.exitCode = 1;
  }
}
