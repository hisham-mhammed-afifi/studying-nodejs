/**
 * Cross-platform test runner.
 *
 * `IMPL=solution node --test ...` is a POSIX-ism — it doesn't work in Windows
 * cmd or PowerShell. This wrapper sets the env var in-process and spawns the
 * real runner, so `npm run test:solutions` behaves identically everywhere.
 *
 *   node scripts/test.ts                    # your exercises
 *   node scripts/test.ts --solutions        # the reference solutions
 *   node scripts/test.ts --solutions 02     # just module 02
 */

import { spawnSync } from "node:child_process";
import path from "node:path";

const args = process.argv.slice(2);
const useSolutions = args.includes("--solutions");
const filter = args.find((a) => !a.startsWith("--"));

// Node's --test accepts glob patterns directly (v21+). Quoting is handled for
// us because we're passing an argv array, not a shell string.
const pattern = filter ? `src/${filter}*/**/*.test.ts` : "src/**/*.test.ts";

const root = path.join(import.meta.dirname, "..");
console.log(`Running ${useSolutions ? "SOLUTIONS" : "YOUR EXERCISES"} — ${pattern}\n`);

const result = spawnSync(process.execPath, ["--test", pattern], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, ...(useSolutions ? { IMPL: "solution" } : {}) },
});

if (!useSolutions && result.status !== 0) {
  console.log("\n↑ Failures are expected until you implement the exercises.");
  console.log("  Compare against the reference with:  npm run test:solutions");
}

process.exitCode = result.status ?? 1;
