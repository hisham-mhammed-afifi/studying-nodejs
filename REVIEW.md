# Technical Review

**Subject:** node-study — a 15-module Node.js curriculum in TypeScript
**Date:** 2026-08-27
**Node:** v22.23.2
**Scope:** all 15 modules — READMEs, demos, exercises, solutions, tests, tooling
**Method:** static review, plus every finding below reproduced by execution unless marked *unverified*

---

## Verdict

The technical content is strong and unusually honest — measurements are real, several claims contradict conventional wisdom and are right to, and the security-critical code in module 14 survived a deliberate attempt to break it. **The defects are almost entirely in the scaffolding around the content, not the content itself.**

Three things are wrong enough to fix before anyone else uses this:

1. A **remotely-triggerable process crash** in a demo learners are told to copy.
2. **Three leak-detection tests that cannot fail** — they test the exact hazard the course warns about, and they are no-ops.
3. **`npm test` — the first command a learner runs — hangs forever** on two modules.

There is a pattern worth naming: every one of the top findings is a case where **the project violates something it correctly teaches elsewhere**. The curriculum is more rigorous than the repository that contains it.

| Severity | Count | Status |
|---|---|---|
| Critical | 1 | ✅ **fixed** |
| High | 3 | ✅ **all 3 fixed** |
| Medium | 8 | open |
| Low | 6 | open |

**All Critical and High findings are closed.** Each was verified by reproducing the defect first and re-running the identical check after — mutation testing for the test-quality findings, live execution for the rest. Three lasting guards came out of it: `--test-timeout` in the runner, `npm run check:readme` over 2,062 previously-unverified lines, and paired "…and the check above can actually fail" tests that guard the leak detectors.

---

## Critical

### ~~C1~~ — Unauthenticated remote crash via a malformed `Cookie` header · ✅ FIXED 2026-08-27

**`src/14-auth/05-cookies-csrf.ts:109`**

```ts
if (!out.has(name)) out.set(name, decodeURIComponent(value));
```

`decodeURIComponent` throws `URIError` on malformed percent-encoding. `parseCookies` is called synchronously from the request handler with no `try`/`catch` anywhere between the throw and `createServer`. One request kills the process.

**Reproduced:**

```
$ curl -H 'Cookie: csrf=100%' http://127.0.0.1:PORT/
URIError: URI malformed
    at parseCookies (05-cookies-csrf.ts:109)
    at Server.<anonymous>
Node.js v22.23.2   [process exited 1]
```

A single header, no authentication, whole process down. In a clustered deployment an attacker takes down every worker in a loop.

What makes this a Critical rather than a High: **the project already teaches the fix, twice, and doesn't apply it here.**

- `src/10-routing-middleware/README.md` §1.6 — *"`decodeURIComponent` **throws** on malformed input — an unhandled `URIError` from a URL a scanner sent is a 500 that should have been a 400."*
- `src/14-auth/solution.ts:281-289` — gets it right, with a `try`/`catch` and a comment.

The demo file is what a learner reads first and copies. The correct version is buried in the file they're told not to peek at.

**Fix** — port the guard from `solution.ts` into the demo, and add the one-line caveat this module gives for every other hostile-input case:

```ts
let value = raw;
try { value = decodeURIComponent(raw); } catch { /* a lone % — keep raw, never crash */ }
if (!out.has(name)) out.set(name, value);
```

**Resolution.** Applied at `05-cookies-csrf.ts:107-119`, matching the approach `solution.ts` already used. The crash was also turned into a lesson rather than a silent fix: §3 now prints the hostile inputs surviving, and the prose gained a fourth bullet naming the failure mode ("does not return a 500, it KILLS THE PROCESS") with an invitation to delete the `try`/`catch` and re-run.

**Verification:**

| check | result |
|---|---|
| Original repro (extracted verbatim from the demo, driven over a real socket) | `csrf=100%`, `a=%E0%A4%A`, `x=%`, `y=%zz` → **all 200, exit 0** |
| Fuzz: 672 hostile headers (truncated escapes, lone `%`, surrogates, overlongs, 5000-char values, combinatorial pairs) | **0 throws** |
| Correctness round-trips (base64 padding, `a=b=c`, `%20`, duplicate-name-first-wins, UTF-8 `café`, undecodable-keeps-raw) | **8/8 correct** |
| Demo §5 CSRF flow (6 cases: missing / mismatched / matching token, bad Origin, safe method) | unchanged |
| Repo-wide sweep for the same bug in every `decodeURI*` call site | **no other real instance** — remaining grep hits are comments, prose, or demo-controlled values |
| `tsc --noEmit` · module 14 tests · all 6 demos · full suite | clean · 48/48 · exit 0 · **564/564** |

---

## High

### ~~H1~~ — Three leak-detection tests are permanently vacuous · ✅ FIXED 2026-08-27

**`src/02-event-loop/exercise.test.ts:174-182`**
**`src/08-processes-workers/exercise.test.ts:299-307`**
**`src/15-testing-deploy/exercise.test.ts:236-247`**

All three assert on `process._getActiveHandles()`. On Node 22, **timers and Worker threads never appear in that list** — only socket-type handles do.

**Reproduced:**

```
baseline           : 1  Socket
10 REF'd timers    : 2  Socket,Socket     ← ten leaking intervals, invisible
10 UNREF'd timers  : 2  Socket,Socket     ← identical
open http server   : 3  Socket,Socket,Server
```

Ten `setInterval`s that would hang the process forever produce **zero** entries. Each of these tests passes identically whether the implementation calls `.unref()` or not.

The irony is exact: these three tests exist to catch leaked handles, `src/15-testing-deploy/README.md` §3.4 is titled *"A leaked handle hangs the runner"*, and the tests guarding that lesson are no-ops. Module 02's core requirement — *"must not keep the process alive"* — is entirely untested.

**Fix** — use `process.getActiveResourcesInfo()` (public and stable since Node 17, no underscore). It counts ref'd timers and correctly excludes unref'd ones:

```
baseline Timeout count  : 0
10 REF'd    Timeout count: 10
10 UNREF'd  Timeout count: 0    ← exactly the discrimination needed
after clear              : 0
```

```ts
const timers = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
const before = timers();
const monitor = impl.createLagMonitor({ intervalMs: 1000 });
assert.equal(timers(), before, "the monitor's interval must be unref'd");
monitor.stop();
```

A child-process exit test is the stronger alternative where the resource isn't a timer (module 08's Workers): spawn the scenario and assert it exits within a deadline.

**Resolution.** Two different techniques, because one API does not cover both cases:

| module | resource | technique |
|---|---|---|
| 02, 15 | timers | `process.getActiveResourcesInfo()` — counts ref'd `Timeout`s, excludes unref'd |
| 08 | Workers | **child process must exit on its own** |

Module 08 needed the heavier approach because a live `Worker` appears in **neither** API — confirmed by probe. Process exit is the only unfakeable ground truth there: if any worker survived `close()`, its message port holds the loop open and the child hangs.

Modules 02 and 15 also gained a paired *"…and the check above can actually fail"* test that leaks a timer on purpose and asserts the detector sees it. It guards the guard: if the assertion ever silently reverts to a no-op, that test fails first.

**Verification — mutation testing.** A leak test is only worth anything if it fails when the leak exists, so each was proven both ways:

| module | mutation | before fix | after fix |
|---|---|---|---|
| 02 | remove `timer.unref()` | ✅ 24/24 pass — **leak invisible** | ❌ fails: *"the monitor's interval is ref'd and would hold the process open"* |
| 15 | remove `clearInterval`/`clearTimeout` **and** both `unref()`s | ✅ pass | ❌ fails: *"drain() left a ref'd timer pending"* |
| 08 | `close()` no longer calls `worker.terminate()` | ✅ pass | ❌ fails: *"the child had to be SIGKILLed"* (`'SIGKILL' !== null`) |

One nuance worth recording. Removing **only** the `unref()`s from `drain()` still passes — correctly. `drain()` also *clears* both timers when it resolves, and either safety net alone prevents the process being held open. The test asserts the requirement ("no timer holds the loop open"), not an implementation detail ("call these two methods"), so it fails only when both are gone. The assertion message was reworded to match what it actually detects.

Two incidental bugs were found and fixed while building the module 08 test, both worth knowing:

- `node --input-type=module -e` fails with `ERR_INPUT_TYPE_NOT_ALLOWED` **inside the Worker** — a Worker inherits the parent's `execArgv`, and a Worker has a real file entry, so the flag poisons it. The child script is now a real `.mjs` in `os.tmpdir()`, which needs no flags.
- A first attempt wrote a scratch file into `src/08-processes-workers/`. The child now runs entirely from a temp dir, removed in a `finally`.

**Post-fix state:** `tsc --noEmit` clean · **566/566** (two new tests) · 3× repeat runs on modules 02/08/15 all green · module 08's child-process test still green under 2× CPU saturation · `git status` shows only the four intended files · all `solution.ts` files pristine · six stray `.fuse_hidden*` artifacts removed from `src/15-testing-deploy/`.

---

### ~~H2~~ — `npm test` hangs forever on the exercise path · ✅ FIXED 2026-08-27

**`src/02-event-loop/exercise.test.ts`, `src/15-testing-deploy/exercise.test.ts`, `scripts/test.ts:27`**

Against unimplemented exercises — the state every learner starts in — two modules never exit:

| module | red run | module | red run |
|---|---|---|---|
| 01 | 229ms | 09 | 260ms |
| **02** | **hang (killed at 45s)** | 10 | 246ms |
| 03–08 | 240–540ms | 11–14 | 245–261ms |
| | | **15** | **hang (killed at 45s)** |

Every test runs and fails correctly; the *process* then refuses to exit. A full `node scripts/test.ts` did not complete in 178 seconds.

Cause: fixtures that leak when the implementation throws `TODO`. In module 15 the `after` hook does `if (server.listening) server.close()`, but a keep-alive connection from the in-flight `fetch` is still open — so `close()` never completes. This is precisely the scenario `05-shutdown.ts` measures at 6814ms and fixes with a sweep.

Two fixes, both worth doing:

1. **Make the fixtures safe** — `server.closeAllConnections()` before `close()` in every `after` hook; wrap leak-prone setup in `try`/`finally`.
2. **Add the seatbelt.** `scripts/test.ts` spawns `["--test", pattern]` with no `--test-timeout`. Module 15's own deployment checklist says:

   > `□ --test-timeout set, so a leaked handle fails instead of hanging`

   The runner that ships with the course doesn't do it. Add `--test-timeout=30000`; a hang becomes a readable failure.

**Resolution.** Diagnosed by running each test file in-process and dumping `getActiveResourcesInfo()` / `_getActiveHandles()` after the suite finished, rather than guessing:

| module | what was actually holding the loop |
|---|---|
| 02 | one ref'd `Timeout` — `exercise.test.ts:249`, `const timer = setInterval(...)` where `clearInterval(timer)` sits *after* the `await` that throws, so it is never reached |
| 15 | **four listening servers** and a keep-alive socket — `scenario()` hands out a server per test and `impl.drain()` throws before any of them is closed |

Three changes:

1. **Module 02** — `try`/`finally` around the `await`, so the interval is cleared on the throwing path.
2. **Module 15** — `scenario()` now registers every server/agent it creates, and an `afterEach` tears them all down with `closeAllConnections()` before `close()`. The final suite's `after` hook got the same treatment: it previously called `server.close()` alone, which waits out the keep-alive socket the fixture deliberately opens — the 6814ms stall this module measures.
3. **`scripts/test.ts`** — now passes `--test-timeout=30000`, the checklist item the course wrote and the runner didn't follow.

**Verification:**

| check | before | after |
|---|---|---|
| Full red run (`node scripts/test.ts`) | **did not finish in 178s** | **5s**, 566 tests reported |
| Module 02 red | hang, killed at 40s | **234ms** |
| Module 15 red | hang, killed at 40s | **3.4s** |
| Slowest of the other 13 | — | 507ms — no module now exceeds 5s |
| Seatbelt, proven separately: a file that leaks a listening server | hangs indefinitely (killed at 25s) | **exits 1 in 5s** |
| Green suite | 566/566 | 566/566 |
| 3× repeat, red and green | — | byte-identical every run (`pass 3 / fail 539 / cancelled 24`, `566/566`) |
| `tsc --noEmit` · `git status` | — | clean · only the five intended files, all `solution.ts` pristine |

The three tests that pass in the red run are the two new "…and the check above can actually fail" guards (deliberately implementation-independent) and module 15's `"starts NOT ready"`, which the provided field initializer already satisfies by design.

---

### ~~H3~~ — README code that cannot run in this project · ✅ FIXED 2026-08-27

**`src/05-streams/README.md:312`**

```ts
constructor(private max: number) {
```

A TypeScript parameter property. This project runs `.ts` files directly under Node's type stripping, which **erases** types rather than transforming them.

**Reproduced:**

```
SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]:
  TypeScript parameter property is not supported in strip-only mode
```

The root `README.md` says so explicitly (*"`enum`, `namespace`, parameter properties and legacy decorators are unavailable"*), `tsconfig.json` sets `erasableSyntaxOnly`, and modules 05 and 10 both call it out in comments. A learner copying this snippet gets a hard `SyntaxError` from the very file teaching them the API.

**Root cause — and the bigger finding:** `erasableSyntaxOnly` catches this in real source files, but **README code blocks are never compiled or executed by anything.**

| | lines of code |
|---|---|
| across the 15 module READMEs | **2,163** |
| verified by any check | **0** |

That is the single largest unverified surface in the project, and it is the surface learners read first. One `SyntaxError` slipped through; on a 2,163-line sample, it is unlikely to be alone.

**Fix** — the immediate one is two lines:

```ts
readonly #max: number;
constructor(max: number) { this.#max = max; }
```

The durable one is a `scripts/check-readme.ts` that extracts every ```` ```ts ```` block, writes it to a temp file, and runs `tsc --noEmit` over the set. Blocks that are deliberately illustrative get a ```` ```ts ignore ```` marker. The project has the tooling instincts for this everywhere else; the READMEs were simply never included.

**Resolution.** Both halves done — the checker first, so it could report the true scale rather than my fixing only the bug I already knew about.

**`scripts/check-readme.ts`**, wired up as `npm run check:readme` and folded into a new `npm run check` (typecheck + readme + full suite, 48s).

The bar it enforces is deliberately narrow: **every block must be code Node could actually run** — TS1xxx diagnostics, covering parse errors and `erasableSyntaxOnly` violations (TS1294). It does *not* require snippets to typecheck standalone; they are fragments by design, and 1,001 name-resolution diagnostics are correctly ignored. Demanding otherwise would mean padding every snippet with boilerplate that makes the teaching worse.

**The checker needed two passes, and finding out why was the whole exercise.** tsc abandons grammar checking for the *entire program* as soon as any file fails to parse. One block containing `await ???` therefore hid every `erasableSyntaxOnly` violation in all the others — so the first version of the script reported 27 pseudo-code complaints and **silently missed the actual bug**. Pass 1 now identifies unparseable blocks, pass 2 re-runs without them. Only then did `05-streams/README.md:312` appear.

That is worth stating plainly: a single-pass checker would have looked like it worked, produced a plausible report, and left the defect in place.

**Triage of the 38 findings:** 1 real bug, 8 `TS1108` ("return outside function" — an artifact of showing a handler body, now tolerated by default with the reason documented), and 12 blocks of genuine notation rather than code (`...` elision, `???`, `encoding?` signatures, `b.readInt16BE / LE` tables, `…`). Each of those 12 was read individually before being marked ```` ```ts ignore ```` — none was a disguised bug.

**Verification:**

| check | result |
|---|---|
| The bug itself | `05-streams/README.md:312` reported at exactly the right line, then fixed with `readonly #max` + explicit assignment |
| **The fixed snippet actually executes** — extracted verbatim from the README and run | `Counter(4) produced: [{"n":0},{"n":1},{"n":2},{"n":3}]`, exit 0 |
| Regression mutation: parameter property / enum / namespace / syntax error injected into a README | **all four caught**, ❌ each time |
| After restore | ✅ clean, README byte-identical (`git diff --quiet`) |
| Scratch dir cleanup | removed on exit, and `.gitignore`d for the killed-mid-run case |
| `tsc --noEmit` · `npm run check` | clean · **566/566** |

Scope now covered: **334 blocks, 2,062 lines across 16 READMEs**, previously verified by nothing.

---

## Medium

### M1 — Unbounded attacker-keyed Map in the "everything wired up" example

**`src/14-auth/06-defences.ts:162-181`**

```ts
const attempts = new Map<string, Attempts>();
function recordFailure(key: string, ...) { ... attempts.set(key, a); }
```

`key` is the submitted email — attacker-controlled, never validated against a real account, never evicted. POST a fresh bogus address per request and the Map grows without bound.

Forty lines earlier the same file gets this right for `SlidingWindow`, with a `sweep()` method and a comment:

> *"Any per-key limiter keyed on ATTACKER-CONTROLLED input — an IP, an email, an API key — is a memory leak the attacker can drive."*

`attempts` gets neither, and it appears in §6 "One login function, all defences on" — the block most likely to be copied verbatim.

**Fix** — give `attempts` the same sweep, or fold lockout into the bounded structure.

---

### M2 — Eleven broken or mismatched cross-references

Every one spot-checked against the target file.

**Broken — target section does not exist:**

| Location | Reference | Reality |
|---|---|---|
| `10-routing-middleware/06-pitfalls.ts:198` | module 06 §5.5 | §5 stops at 5.3; case-sensitivity is never discussed in module 06 |
| `10-routing-middleware/06-pitfalls.ts:213` | module 09 §6.3 | §6 has only 6.1 |
| `11-fastify/solution.ts:201` | module 09 §3.6 | §3 stops at 3.4 (content is in the *demo* `03-responses.ts` §6) |
| `12-config-logging/exercise.ts:91`, `solution.ts:151` | §6.4 | §6 has only 6.1, 6.2 |
| `13-persistence/README.md:124`, `03-types.ts:60` | §6 (row mapping) | §6 is "Migrations"; no section covers this |

**Mismatched — section exists, wrong topic:**

| Location | Reference | Actually is |
|---|---|---|
| `09-http/04-timeouts-keepalive.ts:21` | module 05 §5.4 | "`finished` and `compose`" — unrelated to `@types/node` lag |
| `10-routing-middleware/05-common.ts:12` | module 05 §6.1 | "Readable" — unrelated to type stripping (and §6.1 is the snippet in H3) |
| `13-persistence/01-basics.ts:128` | `06-queries.ts` §3 | §3 is "Grouping JOIN results"; indexing is §1 |
| `13-persistence/exercise.ts:78` | `05-migrations.ts` §5 | transaction-per-migration is §2 |
| `14-auth/06-defences.ts:232` | module 09 §3 | §3 is "Writing the response"; this is about *request* headers (`X-Forwarded-For`). §1.1 or §9 fit |
| `12-config-logging/solution.ts:161` | §6.2 | "exact-path matching" is in the §6 intro; §6.2 is "Volume" |

These matter more than typos would: cross-references are load-bearing in a curriculum built on "this connects to what you learned in module N".

---

### M3 — Module 02's flagship concurrency test cannot detect the bug it documents

**`src/02-event-loop/exercise.test.ts:54-67`** — *"refills a free slot immediately"*

```ts
const durations = [200, 5, 5, 5, 5, 5, 5, 5];
assert.ok(elapsed < 320, ...);
```

Hand-computing both schedules:

- **Correct** (eager refill): ~**200ms**
- **Buggy** (batched `mapLimit`, the anti-pattern this test exists to catch): ~**215ms**

The real signal is **~15ms**, inside ordinary `setTimeout` jitter. The threshold is 320ms — over 20× too loose. A batched implementation passes comfortably.

**Fix** — instrument concurrency directly, as the sibling test at `:41-52` already does correctly (`peak <= 4`). Timing is the wrong instrument when the correct and buggy schedules differ by 7%.

---

### M4 — `copyTree`'s concurrency limit is never verified, and the test says so

**`src/06-filesystem/exercise.test.ts:410-423`**

```ts
// Count concurrent copyFile calls ... is awkward; instead assert the whole
// thing completes and is correct
const n = await impl.copyTree(src, dst, { concurrency: 4 });
assert.equal(n, 60);
```

The stated requirement is *"At most `concurrency` copies in flight — an unbounded `Promise.all` over 50k files is an EMFILE waiting to happen."* An implementation that ignores `concurrency` entirely passes. The peak-counter technique the comment calls "awkward" is already working in module 02.

---

### M5 — Abort tests only cover the pre-aborted case

**`src/06-filesystem/exercise.test.ts:122-126` and `:443-456`**

Both pass `AbortSignal.abort()` — already aborted before the call begins. An implementation that checks `signal.aborted` once at entry and then ignores the signal passes both. The interesting behaviour (cancel *mid-write*, stop starting new copies *mid-flight*) is untested.

Module 07 sets the right standard, with both an already-aborted test **and** `"stops retrying when aborted mid-flight"` (`07-errors-diagnostics/exercise.test.ts:429-458`).

---

### M6 — Skipped tests report as passed on Windows

**`src/06-filesystem/exercise.test.ts:218, 229, 285, 296, 305, 315`**

Credit where due: there *is* a `canSymlink` probe (`:34-39`), and all six symlink tests are guarded. But the guard is a silent `return`:

```ts
it("rejects a symlink pointing outside the base", async () => {
  if (!canSymlink) return;
```

Windows without Developer Mode or Administrator cannot create symlinks. Those six tests then print **`ok`** having asserted nothing — including the three that verify `safeResolve` blocks a symlink escape, a security control.

This is exactly `15-testing-deploy/README.md` §3 — *"Four ways a green test suite is lying to you"* — reproduced in the project's own suite.

**Fix** — `t.skip()` so they report `# SKIP` and the count is honest:

```ts
it("rejects a symlink pointing outside the base", async (t) => {
  if (!canSymlink) return t.skip("symlinks need Developer Mode on Windows");
```

Relevant here specifically: this repo lives on a Windows machine.

---

### M7 — Cookie name is never validated

**`src/14-auth/05-cookies-csrf.ts:32` and `src/14-auth/solution.ts:259`**

```ts
const parts = [`${name}=${encodeURIComponent(value)}`];
```

`value` is encoded; `name` is not. RFC 6265 restricts cookie names to a token set precisely because `;` and `=` break the attribute grammar. A name containing `;` injects attributes — `"a; HttpOnly=false; Domain=evil"` corrupts the header. Node blocks raw `\r\n`, so classic response-splitting is not available, but this surface is real for any caller building a name from configuration or tenant data.

The reference solution has the same gap, so completing the exercise "correctly" reproduces it.

**Fix** — validate against the RFC token set in both files:

```ts
if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) throw new Error("invalid cookie name");
```

---

### M8 — CSRF cookie ships `secure: false`, and the subdomain attack goes unmentioned

**`src/14-auth/05-cookies-csrf.ts:213`**

```ts
serializeCookie("csrf", csrf, { maxAge: 86400, httpOnly: false, secure: false }),
```

The comment explains `httpOnly: false` (the page's JS must read it) but says nothing about `secure: false`, which is there only so the demo works over plain `http://127.0.0.1`. No callout that production must flip it back.

More substantively: the cookie has no `__Host-` prefix. Double-submit's security rests entirely on the attacker being unable to *set* a matching cookie — and without `__Host-`, a compromised sibling subdomain can set `csrf` with `Domain=parent.com`, pair it with a matching header, and defeat the check. The file's closing note covers the XSS collapse but not this one, even though §2 of the same file explains at length why `__Host-` exists for exactly this attack on the *session* cookie.

**Fix** — use `__Host-csrf`, or lead with the HMAC-signed variant currently mentioned as an afterthought. Either way, note the subdomain case explicitly.

---

## Low

- **L1 — CORS wildcard with no caveat.** `src/10-routing-middleware/05-common.ts:165` sets `access-control-allow-origin: *` with no allowlist, no `Vary: Origin`, and no note about credentials. It is the only security-relevant default in either module that ships without a "in production you must…" comment.
- **L2 — No CI.** No `.github/`. Nothing runs `npm run typecheck` or `npm run test:solutions` automatically. Module 15 devotes a section to CI hygiene; the repo has none. A ~40-line workflow closes it.
- **L3 — Error identity not asserted.** `src/02-event-loop/exercise.test.ts:84-110` requires *"reject with **that** error"* but asserts only `/boom/`. An implementation that rewraps in a new `Error` — losing the stack and custom properties — passes.
- **L4 — Test asserts unspecified behaviour.** `src/03-event-emitter/exercise.test.ts:402-405` requires `RangeError` on a self-pipe; `exercise.ts` only asks the rhetorical question *"what should happen…?"*. The test locks in `solution.ts`'s choice as if it were the spec.
- **L5 — Heap assertions without forced GC.** `06-filesystem/exercise.test.ts:352-361` (`< 4MB`) and `05-streams/exercise.test.ts:358-370` (`< 120MB`) diff `heapUsed` with no `global.gc()`. They measure V8's allocator as much as the code. The 4MB threshold is the tighter risk.
- **L6 — Citation style drift.** `13-persistence/exercise.ts` and `solution.ts` use bare `(§4)`, `(§3.2)`, `(04 §4)` meaning *demo-file* sections, while every other module uses bare `(§N)` for the module's own README. Read by the project's own convention, most of module 13's are wrong. Also `15-testing-deploy/03-lies.ts:174` writes `(§05)` — the only zero-padded reference in the corpus.

---

## What held up

Stated as findings, because each was an attempt to break something that failed:

- **The JWT verifier is sound.** I walked `alg:none`, RS256→HS256 confusion, signature-vs-claims ordering, and `exp` unit handling looking for a bypass. Algorithm is pinned before dispatch, signature is checked with `timingSafeEqual` behind a length guard *before* the payload is parsed, `exp` is scaled correctly. No bypass found. The two attack demos correctly do **not** work against `verifyJWT`/`verifyToken`.
- **SQL is parameterized throughout module 13.** No user input reaches SQL unparameterized. The one legitimate interpolation builds an `IN (?,?,?)` placeholder *count*, not data, and says so.
- **Timing tests survive CPU contention.** The static review flagged several wall-clock assertions as CI-flaky. I ran modules 02, 08 and 15 four times each idle, then again under 2× core saturation on a 2-core box: **26/26, 24/24, 32/32 passing every time, no flakes.** The margins are proportionate. Reported here so nobody "fixes" a non-problem — M3 is a real defect for a different reason (too *loose*, not too tight).
- **Password hashing is correct.** scrypt parameters, the `maxmem` trap, params-stored-with-hash, rehash-on-login, NFC normalization — all match current practice.
- **Session handling is correct.** 256-bit CSPRNG tokens, SHA-256 (not scrypt) at rest, and a correct explanation of why `timingSafeEqual` isn't needed on a primary-key lookup.
- **Log redaction is honest about itself** — the 7-of-9 leak measurement and the recommendation to allowlist rather than denylist.
- **Modules 03, 04, 07, 09–14 have genuinely strong tests.** Module 07 is the best in the suite (cause-chain cycles, numerically-verified backoff, `AsyncLocalStorage` leak and nesting). Module 13's `Proxy`-around-`db.prepare` to detect N+1 is a technique worth stealing.
- **Clean bill on tooling basics:** `tsc --noEmit` passes, 564/564 solution tests green, `npm audit` reports 0 vulnerabilities, `.gitignore` present.

---

## Recommended order of work

| # | Finding | Effort |
|---|---|---|
| ~~1~~ | ~~C1 — cookie parser crash~~ | ✅ **done** |
| ~~2~~ | ~~H2 — fix the two hanging fixtures + add `--test-timeout`~~ | ✅ **done** |
| ~~3~~ | ~~H1 — give the three leak tests teeth~~ | ✅ **done** |
| ~~4~~ | ~~H3 — fix `05-streams/README.md:312`~~ | ✅ **done** |
| 5 | M1 — bound the `attempts` Map | ~10 lines |
| 6 | M6 — `t.skip()` in six Windows-guarded tests | 6 lines |
| 7 | M2 — correct eleven cross-references | ~30 min |
| 8 | M3, M4, M5 — give three tests real teeth | ~1 hr |
| 9 | M7, M8, L1 — cookie name validation, `__Host-csrf`, CORS caveat | ~30 min |
| ~~10~~ | ~~H3 (durable) — `scripts/check-readme.ts`~~ | ✅ **done** |
| 11 | L2 — CI workflow | ~40 lines |

Items 1–6 are a single sitting and clear everything Critical and High.

---

## Closing note

The measured-not-assumed method is the best thing about this project, and it is worth applying to the project itself. The findings above were found the same way it teaches: by running the thing and reading what actually happened. Every top defect is a place where a lesson was written down correctly and then not applied to the repository — the cookie crash (module 10 warns about it), the hanging tests (module 15 measures the exact failure), the vacuous leak checks (module 15 §3 is titled "ways a test lies"), the Windows silent-pass (same section).

Turning those lessons into executable checks — README compilation, `--test-timeout`, CI — would close the gap permanently, and would make the repository the strongest example of its own curriculum.
