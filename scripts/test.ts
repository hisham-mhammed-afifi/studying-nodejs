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

// --test-timeout is the seatbelt, not a nicety. A test file that leaks a
// handle — an unclosed server, an interval nobody cleared — does not fail:
// the PROCESS never exits and the run hangs with no output (module 15 §3.4).
// This turns "CI hung for 20 minutes" into "CI failed, here is the file",
// which are very different pages at 3am.
//
// 30s is far above the slowest legitimate file (module 08's worker pool, ~4s)
// and far below any human's patience.
const TEST_TIMEOUT_MS = 30_000;

const result = spawnSync(
  process.execPath,
  ["--test", `--test-timeout=${TEST_TIMEOUT_MS}`, pattern],
  {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ...(useSolutions ? { IMPL: "solution" } : {}) },
  },
);

if (!useSolutions && result.status !== 0) {
  console.log("\n↑ Failures are expected until you implement the exercises.");
  console.log("  Compare against the reference with:  npm run test:solutions");
}

process.exitCode = result.status ?? 1;
