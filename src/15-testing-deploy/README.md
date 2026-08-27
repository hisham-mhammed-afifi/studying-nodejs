# 15 — Testing, shutdown, and deployment

The last module, and the one that decides whether the previous fourteen survive contact with production. Two halves that turn out to be the same subject: **proving the thing works**, and **proving it stops working politely**.

No dependencies again — `node:test` has been stable since Node 20, and everything here ships in the runtime.

---

## 1. The runner

```bash
node --test                       # every *.test.ts under cwd
node --test src/15-*/             # a directory
node --test --watch               # re-run on change
node --test --test-name-pattern="shutdown"
node --test --experimental-test-coverage
```

**Each test file runs in its own child process.** That is the single most important fact about this runner:

- module-level state cannot leak between files (module 01 §4 — the module cache is a singleton *per process*)
- files run in parallel, capped at your CPU count
- one file that crashes the process does not take the suite with it
- and a `console.log` in a test file is buffered and re-emitted as a TAP comment, which is why it looks out of order

Within a file, tests run **sequentially** by default. `concurrency: true` opts a suite in:

```ts
describe("outer", { concurrency: true }, () => {
  test("a", async () => { await delay(30); order.push("a"); });
  test("b", async () => { await delay(10); order.push("b"); });
  test("c", () => order.push("c"));
});
// order: c, b, a   ← measured
```

### 1.1 Hook order, exactly

Measured, not remembered:

```
before
  suite:before
    beforeEach [t1] afterEach
    beforeEach [t2] afterEach
  suite:after
  beforeEach [top-level test] afterEach
after
```

Three things to read out of that:

- a **top-level `beforeEach` also runs for tests inside a `describe`** — it is not scoped to the top level
- `before` runs once, at the start of the file, before any suite's own `before`
- `after` runs last, after every suite — the right place for "close the database"

A hook that throws produces `failureType: 'hookFailed'` and **the test body never runs**. That is what you want: a broken fixture should not produce a confusing assertion failure fifty lines later.

### 1.2 `assert/strict`, always

```ts
import assert from "node:assert/strict";   // ✓
import assert from "node:assert";          // ✗ assert.equal is ==
```

`node:assert`'s `equal` uses `==`, so `assert.equal(1, "1")` passes. The `/strict` version makes `equal` mean `strictEqual` and `deepEqual` mean `deepStrictEqual`. There is no reason to use the loose one; import the strict one everywhere and never think about it again.

The three that cover most cases:

```ts
assert.equal(actual, expected);          // primitives
assert.deepEqual(actual, expected);      // structures, recursively, strictly
assert.throws(() => fn(), /pattern/);    // or .rejects for async
assert.match(string, /regex/);
```

⚠ `assert.throws(fn)` needs a **function**, not a call. `assert.throws(fn())` runs it and throws before the assertion is reached — the test fails with the real error, which looks confusing but is at least loud.

---

## 2. Mocking

### 2.1 `t.mock` cleans up; `mock` does not

```ts
test("mocked", (t) => {
  t.mock.method(service, "save", () => 999);
  assert.equal(service.save(1), 999);
  assert.equal(service.save.mock.callCount(), 1);
});

test("the next test", () => {
  service.save(1);   // → 2. Restored automatically. Verified.
});
```

`t.mock.*` — the mock tracker on the **test context** — restores everything when the test ends. The module-level `mock` import does not; you must call `mock.restoreAll()` yourself, and if you forget, the leak crosses tests inside that file.

**Use `t.mock` unless you have a reason not to.** It removes an entire category of "why does this only fail when run with the others" bugs.

### 2.2 Timers

```ts
mock.timers.enable({ apis: ["setTimeout", "Date"] });
setTimeout(() => { fired = true; }, 60_000);
mock.timers.tick(60_000);   // Date.now() also advances by 60,000
assert.equal(fired, true);
mock.timers.reset();
```

`Date` is in that list on purpose: a test for "sessions expire after 14 days" (module 14) should not choose between sleeping for 14 days and threading a `now` parameter through your API. Though — threading `now` through is often the better design anyway, and it's what module 14's exercise does. Mock the clock when you cannot change the code; parameterise it when you can.

### 2.3 What not to mock

The rule that survives contact with a real codebase: **mock what you don't own, at the edge you don't control.**

| | |
|---|---|
| ✓ mock | the payment provider's HTTP call, the clock, the filesystem when it's slow, a service you'd have to boot |
| ✗ don't mock | your own repository, the database (use SQLite in-memory — module 13, it's microseconds), the framework |

A test suite of mostly mocks tests your mocks. Module 13's tests spin up a real `:memory:` database for every case and the whole module runs in under a second; there was never a reason to fake it.

---

## 3. Four ways a test lies to you

Every one of these is measured in `03-lies.ts`. They matter because in all four the suite reports **green**.

### 3.1 `.only` does nothing without `--test-only`

```
$ node --test only.test.ts
ok 1 - normal
ok 2 - only this
# 'only' and 'runOnly' require the --test-only command-line option.
```

Every test ran. The warning is a TAP comment buried in the output, and the exit code is 0. The failure mode is the *other* direction too: you leave `.only` in, CI has `--test-only` set, and one test runs while 400 are silently skipped — also green.

Put `--test-only` in a **local** script and never in CI, or use `--test-name-pattern` instead.

### 3.2 `.todo` runs its body and swallows the failure

```
not ok 4 - todo body runs? # TODO
  error: 'boom'
# fail 0        ← the run still passes
```

`test.todo("x", fn)` **executes `fn`**, catches the failure, and reports it as a todo. `test.skip` does not run the body at all. If you mean "don't run this", `.skip` is the one you want.

### 3.3 A floating promise passes, then poisons the run

```ts
test("forgot to await", () => {
  new Promise((r) => setTimeout(r, 20)).then(() => assert.equal(1, 2));
});
```

```
ok 1 - forgot to await
# Error: Test "forgot to await" generated asynchronous activity after the
#   test ended. This activity created the error "AssertionError..." and would
#   have caused the test to fail, but instead triggered an unhandledRejection
```

The test passed. The run exits 1 with a message attributed to no test in particular. Return or await every promise — including `assert.rejects`, which is the one people forget:

```ts
await assert.rejects(() => thing());   // ✓
assert.rejects(() => thing());         // ✗ passes no matter what thing() does
```

Un-awaited **subtests** are the one case the runner rescues you from: it awaits pending subtests at the end of the parent and reports them properly. Do not rely on it.

### 3.4 A leaked handle hangs the runner

An open server, an un-`unref`'d interval, a database connection you never closed:

```
$ node --test leak.test.ts
(no output, forever — killed at 8s)
```

Not a failure. A **hang** — in CI, a job that burns its timeout budget and reports nothing useful.

Two flags change the symptom. `--test-timeout=5000` turns the hang into a failure (the runner counts the file as still running), which at least pages you with something readable. `--test-force-exit` makes it exit 0 in 111ms, and is the wrong fix: it hides the leak, and the leak is usually the same missing `close()` that will hang your deployment in §5.

Close what you open, in an `after` hook, and let the hang tell you when you didn't.

---

## 4. Coverage, and what it doesn't measure

```
file          | line % | branch % | funcs % | uncovered lines
cov.test.ts   | 100.00 |    88.89 |  100.00 |
```

100% of lines, 100% of functions, and a branch never taken. The untested branch shares its *lines* with a tested one, so the line column can't see it. Worse, the same file contains a function that is called but never asserted against — perfectly covered, entirely untested.

Read the **branch** column. And then don't chase it to 100 either: coverage tells you what was *executed*, never what was *asserted*. A test that calls every line and asserts nothing scores perfectly.

```bash
node --test --experimental-test-coverage \
  --test-coverage-exclude='**/*.test.ts' \
  --test-coverage-lines=80
```

The thresholds fail the run when coverage drops below them, which is the only genuinely useful thing to do with the number: use it as a **ratchet against regression**, not a target.

---

## 5. Graceful shutdown, measured

This is the finding worth the whole module.

A server with one keep-alive client and one in-flight request. `server.close()` is called 200ms into a 1000ms handler:

| | drain time | client outcome |
|---|---|---|
| `server.close()` alone | **6814ms** | completed 200 |
| `close()` + sweep | **812ms** | completed 200 |
| `close()` + `closeAllConnections()` | 0ms | **request killed** |

### 5.1 Why 6814ms

`server.close()` stops accepting new connections — immediately, and `server.listening` is `false` on the next line; a new request gets `ECONNREFUSED`. It then waits for existing connections to end.

Since Node 19, `close()` also closes connections that are **idle at that moment**. Our connection wasn't — it had a request in flight. So it survived, finished its response in 800ms, and then went back to being an idle keep-alive socket that nothing was watching. `close()` waited out `keepAliveTimeout`, which defaults to **5000ms**.

800 + 5000 + overhead = 6814. The container orchestrator's grace period is usually 30s, so this "works" — right up until `keepAliveTimeout` is tuned up, or the traffic is heavier than one request.

### 5.2 The fix is a sweep, not a bigger hammer

```ts
server.close(() => { /* fully drained */ });

// close() only closed the connections that were idle WHEN IT RAN.
// Keep closing the ones that become idle afterwards.
const sweep = setInterval(() => server.closeIdleConnections(), 50);

// And a deadline, because one slow request must not hold the deploy.
const deadline = setTimeout(() => server.closeAllConnections(), 10_000);

sweep.unref();
deadline.unref();
```

6814ms → **812ms**, and the in-flight request still got its 200. `closeAllConnections()` on its own is 0ms and a **severed request** — which is exactly what you're trying to avoid, so it belongs only at the deadline.

### 5.3 The order matters

```
1. flip readiness to NOT ready        ← §6.2; do this FIRST
2. wait ~5-15s                        ← the load balancer is still sending traffic
3. server.close() + sweep + deadline  ← drain
4. close the database, the queue, the workers
5. flush the logger                   ← module 12
6. process.exitCode = 0
```

Step 2 is the one everyone omits, and it is the reason "we implemented graceful shutdown and still see 502s". Deregistration is **eventually consistent**: your pod is already terminating while the load balancer's health check is still 3 seconds from noticing. Closing the socket at that moment produces exactly the error you were trying to prevent.

Shut down in the reverse order of startup, and never close the database before the requests that are using it.

---

## 6. Signals, exit codes, and the orchestrator

### 6.1 `process.exitCode` vs `process.exit()`

```ts
process.exitCode = 3;   // "exit with 3 when you're finished"
process.exit(3);        // "exit with 3 NOW"
```

Measured, with a pending timer and a pending microtask:

| | output |
|---|---|
| `exitCode = 3` | `end of script`, `microtask`, `TIMER RAN`, `exit handler` → **exit 3** |
| `exit(3)` | `exit handler` → **exit 3** |

`process.exit()` skipped the microtask *and* the timer. In a real service that is the in-flight response never sent and the log line never flushed (module 12 §6 — pino's transport is asynchronous, and `process.exit()` truncates it).

**Set `exitCode` and let the loop drain.** Reach for `exit()` only after your own deadline has already expired.

### 6.2 Signals

| signal | default | with a handler |
|---|---|---|
| `SIGTERM` | terminate — exit code `null`, signal `SIGTERM` | your handler runs; exit code is whatever you set |
| `SIGINT` | terminate (Ctrl-C) | same |
| `SIGHUP` | terminate | same |
| `SIGKILL` | **terminate, uncatchable** | — |

Installing a handler *replaces* the default disposition entirely — so a handler that forgets to exit produces a process that ignores SIGTERM and gets SIGKILLed 30 seconds later. Always end the path with an exit.

Two more, both worth knowing:

- Handle the signal **once**. A second SIGTERM (an impatient operator hitting Ctrl-C again) should force-exit, not start a second shutdown.
- In Docker, a process started via a shell (`CMD npm start`) is often **PID 1 and not the one receiving the signal**. Use the exec form, `CMD ["node", "src/server.ts"]`, and skip the npm wrapper — otherwise every shutdown is a SIGKILL and none of this code ever runs.

### 6.3 Readiness is not liveness

| | question | wrong answer costs you |
|---|---|---|
| **liveness** | "is this process wedged?" | a restart loop |
| **readiness** | "should I get traffic right now?" | 502s, or a black hole |

The failure that keeps happening: a readiness probe that checks the database, the database has a brief hiccup, **every** instance reports unready at once, and the load balancer has nowhere to send traffic. A total outage caused by the health check.

- **liveness**: check almost nothing. Event-loop lag (module 02 §7) is a fair signal; the database is not. If a restart wouldn't fix it, it doesn't belong here.
- **readiness**: check the dependencies this instance genuinely cannot serve without — and flip it to `false` on SIGTERM, as step 1 of §5.3.

---

## 7. Files in this module

| File | What it demonstrates |
|---|---|
| `01-runner.ts` | process isolation, concurrency, hook order measured, assert/strict |
| `02-mocking.ts` | `t.mock` auto-restore, `mock.timers` with `Date`, what not to mock |
| `03-lies.ts` | the four green-but-wrong cases, and the coverage column that matters |
| `04-testing-servers.ts` | port 0, real sockets, fixtures, and testing shutdown itself |
| `05-shutdown.ts` | 6814ms → 812ms, the sweep, and what forcing costs |
| `06-deployment.ts` | signals, exit codes, readiness vs liveness, startup validation |
| `exercise.ts` | build the shutdown manager and the health-check registry |

```bash
node src/15-testing-deploy/index.ts
node scripts/test.ts 15
node scripts/test.ts --solutions 15
```

---

## 8. Check yourself

1. Two test files both `import "./db.ts"` and mutate its module state. Why don't they interfere?
2. `test.only` is in the file and CI is green with all 400 tests. What happened?
3. Your suite passes but the CI job times out with no output. What's the most likely cause, and why is `--test-force-exit` the wrong fix?
4. Line coverage 100%, branch coverage 62%. What does that tell you?
5. `server.close()` takes ~6.8 seconds with one in-flight request. Where does the time go?
6. Why must readiness flip *before* `server.close()`, and why the delay between them?
7. `process.exit(0)` at the end of a shutdown handler — what can it lose?
8. Your readiness probe checks the database. Why might that turn a 3-second blip into an outage?
