# Node.js Study Project

TypeScript-first, topic-by-topic. Assumes you already know JavaScript and TypeScript — so this skips language basics and focuses on **what Node actually adds**: the runtime, the event loop, and the core APIs.

## Setup

Requires **Node ≥ 22.18** (native TypeScript type stripping — no build step, no `tsx`, no `ts-node`).

```bash
node -v          # must be >= 22.18
npm install      # only @types/node + typescript, for editor + typecheck
```

Run any file directly:

```bash
node src/01-modules/01-esm-vs-cjs.ts
```

Typecheck everything:

```bash
npm run typecheck      # src/ and scripts/
npm run check:readme   # the ~2,000 lines of TypeScript inside the READMEs
npm run check          # typecheck + readme + the full solution suite
```

`check:readme` exists because `tsc` does not look inside markdown, and the code in these READMEs is what you read first. It extracts every ` ```ts ` block and enforces one rule: **it has to be code Node could actually run** — no parse errors, and nothing `erasableSyntaxOnly` forbids. It does *not* demand snippets typecheck standalone, since they are deliberately fragments. A block that is illustrative rather than runnable opts out with ` ```ts ignore `.

Run the exercise tests:

```bash
npm test                          # tests YOUR exercise.ts — red until you implement it
npm run test:solutions            # tests the reference solutions — all green
node scripts/test.ts 02           # just module 02
node scripts/test.ts --solutions 02
```

> **Why no bundler?** Node 22.18+ strips types at load time. It *erases* types, it does not *transform* code — so `enum`, `namespace`, parameter properties and legacy decorators are unavailable. `tsconfig.json` enables `erasableSyntaxOnly` so TypeScript flags those for you.

## Roadmap

### Part 1 — Runtime internals

| # | Topic | Status |
|---|-------|--------|
| 01 | Modules, resolution, globals, `process` | ✅ ready |
| 02 | The event loop: phases, microtasks, `nextTick`, timers | ✅ ready |
| 03 | `EventEmitter` and typed events | ✅ ready |
| 04 | `Buffer`, encodings, binary data, text boundaries | ✅ ready |
| 05 | Streams & backpressure | ✅ ready |
| 06 | `fs`, races, symlinks, watching, `AbortSignal` | ✅ ready |
| 07 | Errors, diagnostics, `AsyncLocalStorage` | ✅ ready |
| 08 | Child processes, worker threads, `cluster` | ✅ ready |

**Part 1 is complete.** Eight modules, 46 runnable demos.

### Part 2 — Backend service

| # | Topic | Status |
|---|-------|--------|
| 09 | `node:http` from scratch — no framework | ✅ ready |
| 10 | Routing, middleware, composition (hand-rolled) | ✅ ready |
| 11 | Fastify — what a framework actually buys you | ✅ ready |
| 12 | Config, validation & structured logging | ✅ ready |
| 13 | Persistence with `node:sqlite` | ✅ ready |
| 14 | Auth: sessions vs JWT, hashing, timing safety | ✅ ready |
| 15 | Testing with `node:test`, graceful shutdown, deployment | ✅ ready |

**Part 2 is complete.** Seven modules, 42 more demos.

**The whole project is complete: 15 modules, 88 runnable demos, 564 tests.**

## A few things this project measured

Not repeated from documentation — run in `_probe` files and kept only when the number survived:

| | |
|---|---|
| `scrypt` vs `sha256` | **~19,000× slower** — the entire argument for password hashing (14 §1) |
| Graceful shutdown | **6814ms → 811ms** with a sweep, and the in-flight request still completes (15 §5) |
| SQLite transactions | **35.3s → 11ms** for 50k inserts — 3341× (13 §4) |
| ReDoS | a 28-character input stalling the loop for **1261ms** (12 §4) |
| Log redaction | a naive redactor leaked **7 of 9** planted secrets (12 §5) |
| The timing attack people fix | `Buffer.equals` leaks **1.12×** over 400k samples (14 §2) |
| The one they don't | skipping the hash for an unknown user leaks **thousands of ×** (14 §2) |

And several pieces of received wisdom that did **not** survive:

- "Compose middleware once at startup" — worth ~5%, hygiene rather than performance (10)
- `fast-json-stringify` was **slower** than `JSON.stringify` on wide objects, 0.74× (11)
- N+1 queries in in-process SQLite cost only 1.3× — the problem is the round trip, not the query count (13)
- `requestTimeout` does not bound a slow *handler*; only `server.setTimeout()` does (09 §5)
- `res instanceof stream.Writable` is `false` — `ServerResponse` extends `OutgoingMessage` (09)

## How each module is laid out

```
src/NN-topic/
  README.md        ← read this first: concepts, gotchas, mental model
  01-*.ts          ← runnable, heavily commented demos (run them, predict output first)
  exercise.ts      ← TODOs for you to implement
  exercise.test.ts ← run `node --test` here to check yourself
  solution.ts      ← don't peek until you've tried
  index.ts         ← runs all demos in the module
```

**Suggested loop per module:** read the README → *predict* each demo's output before running → run it → do the exercise → compare with the solution.

## Where to go next

The project deliberately stops at the edge of Node itself. The obvious continuations, roughly in order of how often they come up:

- **Observability** — OpenTelemetry tracing on top of module 07's `AsyncLocalStorage` context and module 12's structured logs
- **A real database** — `pg` or `mysql2`, where connection pools, network round trips, and N+1 actually hurt (module 13's SQLite hides all three)
- **Queues and background work** — the jobs that shouldn't happen inside a request
- **Caching** — Redis, and the invalidation problem that comes with it
- **WebSockets / SSE** — long-lived connections, which change every assumption in module 15's shutdown

Each of those builds on something here rather than replacing it.
