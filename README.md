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
npm run typecheck
```

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

**Part 1 is complete.** Eight modules, 48 runnable demos, 309 tests.

### Part 2 — Backend service

| # | Topic | Status |
|---|-------|--------|
| 09 | `node:http` from scratch — no framework | ✅ ready |
| 10 | Routing, middleware, composition (hand-rolled) | ✅ ready |
| 11 | Fastify — what a framework actually buys you | ✅ ready |
| 12 | Config, validation & structured logging | ✅ ready |
| 13 | Persistence with `node:sqlite` | ✅ ready |
| 14 | Auth: sessions vs JWT, hashing, timing safety | ✅ ready |
| 15 | Testing with `node:test`, graceful shutdown, deployment | ⬜ next |

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
