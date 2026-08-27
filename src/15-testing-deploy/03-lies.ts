/**
 * 15.3 — Four ways a green test suite is lying to you.
 *
 *   node src/15-testing-deploy/03-lies.ts
 *
 * Every case below REPORTS SUCCESS. That is the point: a failing test is
 * a good day. These are the other kind.
 */

import { comments, resultLines, runTestFile, verdict } from "./_helpers.ts";

// ─────────────────────────────────────────────────────────────────────────────
// 1. .only does nothing without --test-only
// ─────────────────────────────────────────────────────────────────────────────

console.log("=== 1. test.only, silently ignored ===");

const onlySource = `
import { test } from "node:test";
test("one", () => {});
test("two", () => {});
test.only("the one I was debugging", () => {});
test("three", () => {});
`;

const withoutFlag = runTestFile("only1.test.ts", onlySource);
const withFlag = runTestFile("only2.test.ts", onlySource, ["--test-only"]);

console.log(`  node --test               ${verdict(withoutFlag)}`);
console.log(`  node --test --test-only   ${verdict(withFlag)}`);
console.log(`  the warning, in full:`);
for (const c of comments(withoutFlag.stdout).filter((c) => c.includes("only")))
  console.log(`    "${c}"`);
console.log(`
  Without the flag: ALL FOUR tests ran, exit 0, and the only signal is a
  TAP comment nobody reads. You think you narrowed the run down; you did
  not, and the noise you were trying to escape is still there.

  With the flag, the opposite failure: commit that .only, CI runs with
  --test-only, and ONE test runs while 400 are skipped. Still green.
  Still a deploy.

  Use --test-name-pattern instead (01-runner.ts §6). It leaves nothing
  behind in the file to commit.
`);

// ─────────────────────────────────────────────────────────────────────────────
// 2. .todo runs the body and eats the failure
// ─────────────────────────────────────────────────────────────────────────────

console.log("=== 2. test.todo, which is not test.skip ===");

const todo = runTestFile(
  "todo.test.ts",
  `
import { test } from "node:test";
import assert from "node:assert/strict";

test.todo("todo with a body", () => {
  console.log("TODO BODY RAN");
  assert.equal(1, 2);
});

test.skip("skip with a body", () => {
  console.log("SKIP BODY RAN");
  assert.equal(1, 2);
});
`,
);
for (const line of resultLines(todo.stdout)) console.log(`  ${line}`);
console.log(`  bodies that ran: ${comments(todo.stdout).filter((c) => c.endsWith("BODY RAN")).join(", ") || "(none)"}`);
console.log(`  ${verdict(todo)}`);
console.log(`
  test.todo EXECUTES the body, catches whatever it throws, and files it
  under "todo". The run still exits 0 with "fail 0".

  test.skip does not run the body at all.

  So: .skip means "not now". .todo means "this is expected to fail and I
  want to be reminded" — which is useful, but only if somebody reads the
  todo count. Nothing enforces it.
`);

// ─────────────────────────────────────────────────────────────────────────────
// 3. A floating promise
// ─────────────────────────────────────────────────────────────────────────────

console.log("=== 3. The un-awaited assertion ===");

const floating = runTestFile(
  "floating.test.ts",
  `
import { test } from "node:test";
import assert from "node:assert/strict";

async function findUser(id: number) {
  await new Promise((r) => setTimeout(r, 20));
  if (id < 0) throw new Error("bad id");
  return { id };
}

test("A: forgot to await the assertion", () => {
  findUser(1).then((u) => assert.equal(u.id, 999));   // never awaited
});

test("B: forgot to await assert.rejects", () => {
  // This is the sneaky one — it LOOKS like an assertion.
  assert.rejects(() => findUser(1));    // findUser(1) RESOLVES. Still passes.
});

test("C: done right", async () => {
  await assert.rejects(() => findUser(-1), /bad id/);
});
`,
);
for (const line of resultLines(floating.stdout)) console.log(`  ${line}`);
console.log(`  ${verdict(floating)}`);
const async_ = /generated asynchronous activity after the test ended/.test(floating.stdout);
console.log(`  runner noticed the stray activity: ${async_}`);
console.log(`
  Test A "passed", then the runner reported an unhandledRejection it could
  not attribute to any test, and the RUN exited non-zero with a message
  that names a test which is already marked ok. Confusing on purpose —
  there is nowhere honest to put it.

  Test B is worse: it exits clean and green forever. assert.rejects returns
  a PROMISE. Un-awaited, it asserts nothing at all.

    assert.rejects(fn)         ✗ always passes
    await assert.rejects(fn)   ✓

  The habit that prevents both: an async test function, and await in front
  of anything that could possibly be a promise. Linters catch this
  (no-floating-promises); the runner mostly does not.

  One mercy: un-awaited SUBTESTS (t.test(...)) are awaited by the parent
  before it finishes, and do fail properly. Do not build on that.
`);

// ─────────────────────────────────────────────────────────────────────────────
// 4. A leaked handle hangs the runner
// ─────────────────────────────────────────────────────────────────────────────

console.log("=== 4. The test that never ends ===");

const leakSource = `
import { test } from "node:test";
import { createServer } from "node:http";
test("starts a server and forgets to close it", () => {
  createServer().listen(0);
});
`;

const hang = runTestFile("leak1.test.ts", leakSource, [], 6000);
const forced = runTestFile("leak2.test.ts", leakSource, ["--test-force-exit"], 6000);
const timedOut = runTestFile("leak3.test.ts", leakSource, ["--test-timeout=1000"], 6000);

console.log(`  plain                    exit ${hang.status}, signal ${hang.signal}, after ${hang.ms}ms  ← killed by OUR timeout`);
console.log(`  --test-force-exit        exit ${forced.status} after ${forced.ms}ms`);
console.log(`  --test-timeout=1000      exit ${timedOut.status} after ${timedOut.ms}ms  ← bounds it, at least`);
console.log(`
  The test passed in a millisecond. The PROCESS then sat there holding an
  open listening socket, because an open handle keeps the event loop alive
  (module 02 §4). No output, no failure, no exit — in CI, a job that eats
  its whole timeout and reports nothing.

  Note the third line: --test-timeout DOES cut it off — the runner counts
  the file as still running even though the test itself finished in a
  millisecond. So you get a failure instead of a hang, which is better,
  but it points at the test rather than at the handle. Set it anyway; it
  turns "CI hung" into "CI failed", and those are very different pages.

  --test-force-exit also works, and is the wrong fix. It hides the leak, and the
  leak is the same missing close() that will hang your DEPLOYMENT (§05).
  A hanging test suite is your first warning that shutdown is broken.

  The fix is the boring one:

    let server;
    before(() => { server = createServer().listen(0); });
    after(() => server.close());        // and .unref() every interval

  Then let the hang tell you when you forgot.
`);

// ─────────────────────────────────────────────────────────────────────────────
// 5. Coverage: read the second column
// ─────────────────────────────────────────────────────────────────────────────

console.log("=== 5. 100% coverage, untested code ===");

const coverage = runTestFile(
  "cov.test.ts",
  `
import { test } from "node:test";
import assert from "node:assert/strict";

export function priceFor(qty: number, member: boolean): number {
  const base = qty * 10;
  const discount = member ? 0.2 : qty >= 10 ? 0.1 : 0;
  return base * (1 - discount);
}

export function nothingAssertsThis(x: number): string {
  return x > 100 ? "big" : "small";
}

test("prices", () => {
  assert.equal(priceFor(1, true), 8);
  assert.equal(priceFor(1, false), 10);
  // qty >= 10 for a non-member: never tested.
  nothingAssertsThis(1);   // executed, asserted: nothing
  nothingAssertsThis(200);
});
`,
  ["--experimental-test-coverage"],
);
const covLines = coverage.stdout
  .split("\n")
  .filter((l) => /cov\.test\.ts|all files|line %/.test(l))
  .map((l) => l.replace(/^# /, "").trim());
for (const l of covLines) console.log(`  ${l}`);
console.log(`
  Every line executed. Every function called. And:
    • the "non-member buying 10+" branch is never taken
    • nothingAssertsThis is fully covered and completely untested — it is
      CALLED, and no assertion says what it should return

  Which is the whole limitation, in one function: coverage measures
  EXECUTION, never ASSERTION. A test that calls everything and asserts
  nothing scores 100%.

  So use the number as a ratchet, not a target:

    node --test --experimental-test-coverage \\
      --test-coverage-exclude='**/*.test.ts' \\
      --test-coverage-branches=70

  It fails the run when coverage DROPS. That catches the pull request that
  adds a hundred untested lines, which is the only thing the number is
  reliably good for. Read the branch column; ignore the line column.
`);

export {};
