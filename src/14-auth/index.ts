/** Runs every demo in module 14.  node src/14-auth/index.ts */

import { spawnSync } from "node:child_process";
import path from "node:path";

const demos = [
  "01-hashing.ts",
  "02-timing.ts",
  "03-sessions.ts",
  "04-jwt.ts",
  "05-cookies-csrf.ts",
  "06-defences.ts",
];

for (const demo of demos) {
  console.log(`\n${"═".repeat(72)}\n  ${demo}\n${"═".repeat(72)}`);
  // --no-warnings suppresses the node:sqlite ExperimentalWarning in 03.
  const result = spawnSync(
    process.execPath,
    ["--no-warnings", path.join(import.meta.dirname, demo)],
    { stdio: "inherit" },
  );
  if (result.status !== 0) {
    console.error(`\n✖ ${demo} exited with code ${result.status}`);
    process.exitCode = 1;
  }
}
