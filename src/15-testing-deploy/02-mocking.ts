/**
 * 15.2 — Mocking: what node:test gives you, and when to leave it alone.
 *
 *   node src/15-testing-deploy/02-mocking.ts
 */

import { comments, resultLines, runTestFile, verdict } from "./_helpers.ts";

// ─────────────────────────────────────────────────────────────────────────────
// 1. t.mock restores itself; the module-level mock does not
// ─────────────────────────────────────────────────────────────────────────────

console.log("=== 1. Two mock trackers, one of them cleans up ===");

const restore = runTestFile(
  "restore.test.ts",
  `
import { test, mock } from "node:test";
import assert from "node:assert/strict";

const service = { save(x: number) { return x * 2; } };

test("A: t.mock — the TEST CONTEXT tracker", (t) => {
  t.mock.method(service, "save", () => 999);
  assert.equal(service.save(1), 999);
});

test("B: is it restored?", () => {
  console.log("after t.mock: save(1) =", service.save(1));
});

test("C: mock — the MODULE-LEVEL tracker", () => {
  mock.method(service, "save", () => 111);
  assert.equal(service.save(1), 111);
});

test("D: is THAT restored?", () => {
  console.log("after mock:   save(1) =", service.save(1));
});
`,
);
for (const c of comments(restore.stdout).filter((c) => c.includes("save(1)"))) console.log(`  ${c}`);
console.log(`
  t.mock.*  → restored when the test ends. Automatically. Always.
  mock.*    → survives until YOU call mock.restoreAll().

  That second line is a whole genre of flaky test: a suite that passes
  alone and fails in CI, because test C mocked something test D relies on.
  If you use the module-level tracker, pair it with:

    afterEach(() => mock.restoreAll());

  But the simpler rule is: take the context. Every test callback is handed
  one — \`test("x", (t) => …)\` — and it costs nothing.
`);

// ─────────────────────────────────────────────────────────────────────────────
// 2. What a mock records
// ─────────────────────────────────────────────────────────────────────────────

console.log("=== 2. Spies: mocks that still call through ===");

const spy = runTestFile(
  "spy.test.ts",
  `
import { test } from "node:test";
import assert from "node:assert/strict";

const mailer = {
  sent: [] as string[],
  send(to: string, subject: string) { this.sent.push(to); return "queued"; },
};

test("record calls WITHOUT replacing the behaviour", (t) => {
  // No implementation argument → the original still runs.
  const send = t.mock.method(mailer, "send");

  mailer.send("a@example.com", "Welcome");
  mailer.send("b@example.com", "Reset");

  assert.equal(send.mock.callCount(), 2);
  assert.deepEqual(send.mock.calls[0]!.arguments, ["a@example.com", "Welcome"]);
  assert.equal(send.mock.calls[1]!.result, "queued");
  assert.deepEqual(mailer.sent, ["a@example.com", "b@example.com"]);
});

test("replace the behaviour, then put it back mid-test", (t) => {
  const send = t.mock.method(mailer, "send", () => { throw new Error("SMTP down"); });
  assert.throws(() => mailer.send("c@example.com", "x"), /SMTP down/);

  send.mock.restore();                       // back to the real one
  assert.equal(mailer.send("d@example.com", "x"), "queued");
});

test("a one-off failure, then recovery — retry logic", (t) => {
  let attempt = 0;
  const send = t.mock.method(mailer, "send", () => {
    if (++attempt === 1) throw new Error("transient");
    return "queued";
  });
  assert.throws(() => mailer.send("e@example.com", "x"));
  assert.equal(mailer.send("e@example.com", "x"), "queued");
  assert.equal(send.mock.callCount(), 2);
});
`,
);
for (const line of resultLines(spy.stdout)) console.log(`  ${line}`);
console.log(`  ${verdict(spy)}`);
console.log(`
  The surface, in full:
    t.mock.method(obj, "name")             spy — original still runs
    t.mock.method(obj, "name", impl)       stub — impl replaces it
    t.mock.fn(impl?)                       a standalone mock function
    t.mock.getter / setter                 accessors
    t.mock.module("node:fs", { ... })      module mocking (experimental)

    fn.mock.callCount()
    fn.mock.calls[i].arguments / .result / .error
    fn.mock.restore()        just this one
    fn.mock.resetCalls()     keep the stub, forget the history
`);

// ─────────────────────────────────────────────────────────────────────────────
// 3. Faking time
// ─────────────────────────────────────────────────────────────────────────────

console.log("=== 3. mock.timers — and it moves Date too ===");

const timers = runTestFile(
  "timers.test.ts",
  `
import { test, mock } from "node:test";
import assert from "node:assert/strict";

test("14 days pass in a millisecond", () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });

  const start = Date.now();
  let expired = false;
  setTimeout(() => { expired = true; }, 14 * 24 * 3600_000);

  let ticks = 0;
  const iv = setInterval(() => ticks++, 60_000);

  mock.timers.tick(14 * 24 * 3600_000);

  console.log("Date moved by:", Date.now() - start, "ms");
  console.log("interval fired:", ticks, "times");
  console.log("timeout fired:", expired);

  clearInterval(iv);
  mock.timers.reset();
});

test("real clock is back", () => {
  console.log("Date is real again:", Math.abs(Date.now() - new Date().getTime()) < 5);
});
`,
);
for (const c of comments(timers.stdout).filter((c) => /:/.test(c) && !c.startsWith("Subtest")))
  console.log(`  ${c}`);
console.log(`
  Including "Date" in the api list is the point: a test for "the session
  expires after 14 days" (module 14 §3) otherwise has to choose between
  sleeping for two weeks and not testing it.

  mock.timers.tick(ms)     advance, firing everything scheduled
  mock.timers.runAll()     fire every pending timer immediately
  mock.timers.reset()      real time again — CALL THIS, or the file's
                           later tests run on a frozen clock

  But: module 14's exercise takes \`now\` as a parameter and does not need
  any of this. If you own the code, parameterising the clock is a better
  design than mocking it — it is explicit, it survives a refactor, and it
  works outside a test. Mock the clock when you CAN'T change the code.
`);

// ─────────────────────────────────────────────────────────────────────────────
// 4. Where mocking earns its place — and where it doesn't
// ─────────────────────────────────────────────────────────────────────────────

console.log("=== 4. What to mock ===");

const real = runTestFile(
  "real.test.ts",
  `
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

let db: DatabaseSync;
before(() => {
  db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE)");
});
after(() => db.close());

test("a REAL database, not a mock of one", () => {
  const t0 = performance.now();
  const insert = db.prepare("INSERT INTO users (email) VALUES (?)");
  for (let i = 0; i < 1000; i++) insert.run("user" + i + "@example.com");
  const n = (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
  console.log("1000 real inserts + a count:", (performance.now() - t0).toFixed(1) + "ms");
  assert.equal(n, 1000);
});

test("and it catches what a mock never would", () => {
  // A hand-written fake repository would happily accept this.
  assert.throws(
    () => db.prepare("INSERT INTO users (email) VALUES (?)").run("user1@example.com"),
    /UNIQUE/,
  );
});
`,
);
for (const c of comments(real.stdout).filter((c) => c.includes("ms"))) console.log(`  ${c}`);
console.log(`  ${verdict(real)}`);
console.log(`
                    mock it                     don't mock it
  ─────────────────────────────────────────────────────────────────────────
  a payment API     yes — you can't charge a    your own repository
                    card in CI
  the clock         yes, if you can't inject    the framework
  the filesystem    if it's slow or dangerous   an in-memory database
  a whole service   yes                         pure functions
  an email sender   yes                         your own validation

  The line above shows why: 1000 real inserts and a UNIQUE violation, in
  the time a mock would have taken to be written. A suite made mostly of
  mocks tests the mocks — and its most confident assertion is that your
  fake behaves the way you assumed the real thing does.

  Module 13's entire test suite runs against a real :memory: database.
  There was never a reason to fake it.
`);

export {};
