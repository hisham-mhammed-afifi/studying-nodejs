/**
 * 15.1 — The runner: isolation, ordering, hooks.
 *
 *   node src/15-testing-deploy/01-runner.ts
 *
 * Every claim below is made by RUNNING a throwaway test file and reading
 * what `node --test` actually printed.
 */

import { comments, resultLines, runTestFile, verdict } from "./_helpers.ts";

// ─────────────────────────────────────────────────────────────────────────────
// 1. One process per FILE
// ─────────────────────────────────────────────────────────────────────────────

console.log("=== 1. Test files are isolated processes ===");

const isolation = runTestFile(
  "isolation.test.ts",
  `
import { test } from "node:test";
import assert from "node:assert/strict";

// Module-level state. In one process this would leak between files.
const seen = new Set<number>();

test("first", () => { seen.add(1); assert.equal(seen.size, 1); });
test("second", () => { seen.add(2); assert.equal(seen.size, 2); });
test("pid", () => { console.log("pid", process.pid, "argv", process.argv.length); });
`,
);
console.log(`  ${verdict(isolation)}`);
console.log(`
  The runner spawns a CHILD PROCESS PER FILE. That single design choice
  buys you:
    • module-level state cannot leak across files — the module cache is a
      singleton per PROCESS, not per run (module 01 §4)
    • files run in parallel, capped at your CPU count
    • a file that hard-crashes takes down only itself

  It also explains the confusing bit: console.log inside a test is captured
  and re-emitted as a TAP comment, so it appears grouped, not interleaved.
`);

// ─────────────────────────────────────────────────────────────────────────────
// 2. Ordering inside a file
// ─────────────────────────────────────────────────────────────────────────────

console.log("=== 2. Sequential by default, concurrent on request ===");

const source = (opts: string) => `
import { test, describe } from "node:test";
const order: string[] = [];
describe("suite", ${opts}, () => {
  test("slow (30ms)", async () => { await new Promise(r => setTimeout(r, 30)); order.push("slow"); });
  test("medium (10ms)", async () => { await new Promise(r => setTimeout(r, 10)); order.push("medium"); });
  test("instant", () => { order.push("instant"); });
});
process.on("exit", () => console.log("FINISHED IN:", order.join(" → ")));
`;

const sequential = runTestFile("seq.test.ts", source("{}"));
const concurrent = runTestFile("conc.test.ts", source("{ concurrency: true }"));

console.log(`  default            ${comments(sequential.stdout).find((c) => c.startsWith("FINISHED"))}`);
console.log(`  concurrency: true  ${comments(concurrent.stdout).find((c) => c.startsWith("FINISHED"))}`);
console.log(`
  Sequential is the right default: shared fixtures, a shared database, a
  shared port. Turn concurrency on per-suite when the tests genuinely do
  not touch each other — and notice that when you do, "finished in order"
  stops being true, which breaks any test that relied on it accidentally.
`);

// ─────────────────────────────────────────────────────────────────────────────
// 3. Hooks, in the order they really run
// ─────────────────────────────────────────────────────────────────────────────

console.log("=== 3. Hook order ===");

const hooks = runTestFile(
  "hooks.test.ts",
  `
import { test, describe, before, after, beforeEach, afterEach } from "node:test";
const log: string[] = [];
before(() => log.push("before"));
after(() => { log.push("after"); console.log("ORDER: " + log.join(" | ")); });
beforeEach(() => log.push("beforeEach"));
afterEach(() => log.push("afterEach"));

describe("suite", () => {
  before(() => log.push("suite:before"));
  after(() => log.push("suite:after"));
  test("t1", () => log.push("[t1]"));
  test("t2", () => log.push("[t2]"));
});

test("top-level test", () => log.push("[top]"));
`,
);
const order = comments(hooks.stdout).find((c) => c.startsWith("ORDER:")) ?? "(not found)";
console.log(`  ${order.replace("ORDER: ", "")}`);
console.log(`
  Three things to take from that line:
    • the TOP-LEVEL beforeEach also runs for tests inside the describe.
      It is not scoped to the top level — a surprise the first time a
      global fixture rebuilds itself for every nested test.
    • before/after run ONCE per file. after is where you close the
      database, the server, the pool.
    • the suite's own before runs after the file's before, as you'd hope.
`);

// ─────────────────────────────────────────────────────────────────────────────
// 4. A failing hook does not run the body
// ─────────────────────────────────────────────────────────────────────────────

console.log("=== 4. When a fixture explodes ===");

const hookFail = runTestFile(
  "hookfail.test.ts",
  `
import { test, beforeEach } from "node:test";
beforeEach(() => { throw new Error("could not connect to the database"); });
test("the body", () => { console.log("BODY RAN"); });
`,
);
console.log(`  ${verdict(hookFail)}`);
console.log(`  body ran? ${comments(hookFail.stdout).includes("BODY RAN")}`);
console.log(`  failureType: ${/failureType: '(\w+)'/.exec(hookFail.stdout)?.[1]}`);
console.log(`
  'hookFailed', not 'testCodeFailure' — the runner tells you the fixture
  broke, not the code. That distinction is worth a lot at 3am: without it
  a broken fixture shows up as forty unrelated assertion failures.
`);

// ─────────────────────────────────────────────────────────────────────────────
// 5. assert vs assert/strict
// ─────────────────────────────────────────────────────────────────────────────

console.log("=== 5. There is only one assert worth importing ===");

const asserts = runTestFile(
  "assert.test.ts",
  `
import { test } from "node:test";
import loose from "node:assert";
import strict from "node:assert/strict";

test("loose equal", () => { loose.equal(1, "1"); loose.equal(0, false); });
test("strict equal", () => { strict.equal(1, "1" as unknown as number); });
test("loose deepEqual", () => { loose.deepEqual({ a: 1 }, { a: "1" }); });
`,
);
for (const line of resultLines(asserts.stdout)) console.log(`  ${line}`);
console.log(`
  node:assert         → equal is ==      1 == "1"  passes
  node:assert/strict  → equal is ===     1 === "1" fails

  Import the strict one everywhere and stop thinking about it:

    import assert from "node:assert/strict";

  The four that cover almost everything:
    assert.equal(a, b)              primitives
    assert.deepEqual(a, b)          structures, recursive, strict
    assert.match(str, /re/)         strings
    await assert.rejects(fn, /re/)  async throwing — note the AWAIT (03 §3)

  assert.throws takes a FUNCTION, not a call:
    assert.throws(() => parse(x))   ✓
    assert.throws(parse(x))         ✗ runs it, throws before asserting
`);

// ─────────────────────────────────────────────────────────────────────────────
// 6. Selecting what runs
// ─────────────────────────────────────────────────────────────────────────────

console.log("=== 6. Running a subset ===");

const subset = `
import { test, describe } from "node:test";
describe("shutdown", () => {
  test("drains connections", () => {});
  test("has a deadline", () => {});
});
describe("health", () => {
  test("readiness flips on SIGTERM", () => {});
});
`;

const all = runTestFile("subset1.test.ts", subset);
const byName = runTestFile("subset2.test.ts", subset, ["--test-name-pattern=drain"]);
const bySuite = runTestFile("subset3.test.ts", subset, ["--test-name-pattern=shutdown"]);

console.log(`  no filter                        ${verdict(all)}`);
console.log(`  --test-name-pattern=drain        ${verdict(byName)}`);
console.log(`  --test-name-pattern=shutdown     ${verdict(bySuite)}`);
console.log(`
  --test-name-pattern matches the test name OR any ancestor suite name, so
  a describe name filters the whole group. Prefer it to test.only: it
  leaves no trace in the file to accidentally commit (03-lies.ts §1).

  The rest of the flags worth knowing:
    --watch                       re-run on change
    --test-concurrency=1          serialise FILES (a shared port, a shared db)
    --test-reporter=spec          human-readable instead of TAP
    --test-timeout=5000           fail rather than hang
    --experimental-test-coverage  see 03-lies.ts §5
`);

export {};
