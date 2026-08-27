/** Runs every demo in module 03.  node src/03-event-emitter/index.ts */

import { spawnSync } from "node:child_process";
import path from "node:path";

const demos = ["01-basics.ts", "02-errors.ts", "03-typed-emitter.ts", "04-async-bridge.ts", "05-leaks.ts"];

for (const demo of demos) {
  console.log(`\n${"═".repeat(72)}\n  ${demo}\n${"═".repeat(72)}`);
  const result = spawnSync(process.execPath, [path.join(import.meta.dirname, demo)], { stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`\n✖ ${demo} exited with code ${result.status}`);
    process.exitCode = 1;
  }
}
