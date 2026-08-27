# 01 — Modules, Resolution, Globals & Paths

You know `import`/`export`. What you probably don't know is how **Node** decides what a specifier means, and where that differs from the browser and from bundlers.

---

## 1. Two module systems

Node runs CommonJS and ESM side by side. Which one a file gets is decided by:

| Extension | Result |
|---|---|
| `.mjs` / `.mts` | always ESM |
| `.cjs` / `.cts` | always CommonJS |
| `.js` / `.ts` | whatever the **nearest parent `package.json`** says |

```jsonc
// package.json
{ "type": "module" }     // .js and .ts files here are ESM
{ "type": "commonjs" }   // ...are CommonJS
{ }                      // absent → CommonJS (the legacy default)
```

This project sets `"type": "module"`, so every `.ts` file here is ESM.

> **"Nearest parent"** means Node walks up from the file until it finds a `package.json`. A `node_modules/foo/package.json` with `"type": "commonjs"` makes *that package's* `.js` files CJS regardless of your setting. Two packages in one app can use different systems — that's normal and fine.

### 1.1 Live bindings — the difference that surprises people

CommonJS copies values at export time. ESM exports **live bindings** — the importer reads the exporter's variable *every time*.

```ts
// counter.ts
export let count = 0;
export function increment() { count += 1; }
```

```ts
// esm-consumer.ts
import { count, increment } from "./counter.ts";
console.log(count);   // 0
increment();
increment();
console.log(count);   // 2   ← the binding is live
```

The CommonJS equivalent does *not* behave this way:

```js
// counter.cjs
let count = 0;
module.exports = { count, increment: () => { count += 1; } };
//                 ^^^^^ this copied the NUMBER 0 into the object, once
```

```js
const c = require("./counter.cjs");
c.increment();
c.increment();
console.log(c.count);   // 0   ← still the copy from module-load time
```

This is why CJS libraries expose getters (`get count() { return count; }`) or export mutable objects rather than primitives. In ESM you get it for free.

**But**: live bindings are **read-only in the importer**.

```ts
import { count } from "./counter.ts";
count = 99;   // ✗ TypeError: Assignment to constant variable.
```

Only the defining module may reassign. If consumers need to change state, export a function.

### 1.2 The full difference table

| | CommonJS | ESM |
|---|---|---|
| Loading | synchronous, at the `require()` call | asynchronous; the whole graph resolves before any code runs |
| Bindings | a copy of the value at export time | live bindings |
| `__dirname` / `__filename` | present | absent → `import.meta.dirname` / `.filename` (Node 20.11+) |
| `require()` | present | use `createRequire()` or dynamic `import()` |
| Top-level `await` | ✗ syntax error | ✓ |
| Extension in a specifier | optional (`./util` works) | **mandatory** (`./util.js`) |
| Directory imports | `./lib` → `./lib/index.js` | ✗ not supported |
| `this` at module top level | `module.exports` | `undefined` |
| Cyclic imports | partial exports, often `undefined` | hoisted bindings, TDZ error if read too early |
| Conditional loading | `if (x) require("y")` | `if (x) await import("y")` |

### 1.3 `import.meta` replaces `__dirname`

```ts
console.log(import.meta.url);       // file:///C:/Users/you/app/src/main.ts
console.log(import.meta.dirname);   // C:\Users\you\app\src        (Node 20.11+)
console.log(import.meta.filename);  // C:\Users\you\app\src\main.ts
```

Before Node 20.11 you had to convert manually — you'll still see this in older code:

```ts
import { fileURLToPath } from "node:url";
import path from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
```

### 1.4 Interop: importing CommonJS from ESM

`module.exports` arrives as the **default** export:

```ts
// legacy.cjs
module.exports = { greet: (n) => `hi ${n}` };
```

```ts
import legacy from "./legacy.cjs";        // ✓ always works
console.log(legacy.greet("world"));

import { greet } from "./legacy.cjs";     // ⚠ works only if Node can detect it
```

Named exports from CJS come from **static analysis** of the file (the `cjs-module-lexer`). It handles the common shapes but gives up on anything computed:

```js
// ✓ detected
exports.foo = 1;
module.exports = { bar: 2 };
module.exports.baz = 3;

// ✗ NOT detected — named import throws SyntaxError at load time
const key = process.env.NAME;
module.exports[key] = 4;
for (const k of list) exports[k] = k;
```

When named imports fail, the fix is always the same — take the default and destructure:

```ts
import pkg from "some-cjs-package";
const { thing } = pkg;
```

### 1.5 Interop: `require()` from ESM

```ts
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const legacy = require("./legacy.cjs");
const data = require("./config.json");   // sync JSON, no await needed
```

Since **Node 22.12**, `require()` of an ESM module also works — as long as the target has no top-level `await`:

```js
// in a .cjs file
const esm = require("./modern.mjs");   // ✓ Node 22.12+
console.log(esm.default, esm.namedThing);
```

If the ESM module *does* use top-level `await`, you get `ERR_REQUIRE_ASYNC_MODULE` and must use dynamic `import()` instead.

### 1.6 Cyclic imports

A imports B, B imports A. Both systems "handle" this; both handle it badly.

```ts
// a.ts
import { b } from "./b.ts";
export const a = "A";
console.log("a.ts sees b =", b);

// b.ts
import { a } from "./a.ts";
export const b = "B";
console.log("b.ts sees a =", a);   // ✗ ReferenceError: Cannot access 'a' before initialization
```

ESM hoists the *bindings*, so the cycle resolves — but reading a value before its module has evaluated hits the temporal dead zone and throws. CommonJS gives you `undefined` instead, silently, which is worse because the bug surfaces far from its cause.

Neither is a feature. Break the cycle: extract the shared thing into a third module, or pass it as an argument.

---

## 2. Resolution

### 2.1 The four kinds of specifier

```ts
import x from "./util.ts";          // relative — resolved against import.meta.url
import x from "/abs/util.ts";       // absolute filesystem path (rarely useful)
import x from "file:///abs/util.ts";// URL — the canonical internal form
import x from "node:fs";            // builtin — never touches the disk
import x from "express";            // bare — walk node_modules/ upward
import x from "#config";            // subpath import — package.json "imports"
```

### 2.2 Always use the `node:` prefix

```ts
import fs from "fs";        // works, but…
import fs from "node:fs";   // ✓ do this
```

Three reasons:

1. It can't be shadowed by a package named `fs` on npm.
2. Some newer builtins are **prefix-only** — `node:test`, `node:sqlite`, `node:sea` have no unprefixed form.
3. A reader sees instantly that no dependency is involved.

### 2.3 How bare specifiers resolve

For `import "lodash"` from `/app/src/deep/file.ts`, Node checks in order:

```
/app/src/deep/node_modules/lodash
/app/src/node_modules/lodash
/app/node_modules/lodash          ← typically found here
/node_modules/lodash
```

First match wins. This is why two versions of the same package can coexist — and why `instanceof` sometimes fails across them (see §3.3).

### 2.4 `import.meta.resolve` — resolve without loading

Synchronous, returns the URL a specifier *would* resolve to:

```ts
console.log(import.meta.resolve("node:fs"));        // node:fs
console.log(import.meta.resolve("./util.ts"));      // file:///app/src/util.ts

try {
  import.meta.resolve("not-installed");
} catch (err) {
  console.log(err.code);   // ERR_MODULE_NOT_FOUND
}
```

Useful for locating a dependency's files, or checking whether an optional peer is installed before importing it.

### 2.5 The `exports` field is a wall, not a hint

```jsonc
// node_modules/pkg/package.json
{
  "name": "pkg",
  "exports": {
    ".": "./dist/index.js",
    "./utils": "./dist/utils.js"
  }
}
```

```ts
import "pkg";                 // ✓
import "pkg/utils";           // ✓
import "pkg/dist/utils.js";   // ✗ ERR_PACKAGE_PATH_NOT_EXPORTED
```

That last one fails **even though the file exists on disk**. This is real encapsulation, and it's why you can no longer reach into a modern package's internals. Packages without `"exports"` fall back to `"main"` and remain fully open.

**Conditional exports** map one specifier to different files depending on how it's loaded:

```jsonc
{
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.mjs",
      "require": "./dist/index.cjs",
      "default": "./dist/index.mjs"
    }
  }
}
```

Node picks the **first matching key**, top to bottom. Two rules that trip people up:

- `"types"` must come **first**, or TypeScript may resolve to the wrong declaration.
- `"default"` must come **last**, since it matches everything.

Other common conditions: `"node"`, `"browser"`, `"development"`, `"production"`.

### 2.6 Subpath imports — killing `../../../`

```jsonc
// your package.json
{
  "imports": {
    "#src/*": "./src/*",
    "#config": {
      "development": "./config/dev.ts",
      "default": "./config/prod.ts"
    }
  }
}
```

```ts
import { helper } from "#src/lib/helper.ts";   // from anywhere in the project
import config from "#config";                  // swaps by condition
```

The `#` prefix is required and marks the specifier as package-internal.

> **Why this beats a tsconfig `paths` alias:** `imports` is resolved by **Node itself** at runtime, with no build step and no loader. `tsconfig.paths` only informs the typechecker — at runtime Node has never heard of it, which is the classic "works in the IDE, `ERR_MODULE_NOT_FOUND` at runtime" trap.

### 2.7 Loading JSON — three ways

```ts
// (a) fs — explicit, async, always works. The boring correct default.
import { readFile } from "node:fs/promises";
const pkg = JSON.parse(await readFile(new URL("./package.json", import.meta.url), "utf8"));

// (b) createRequire — synchronous, and CACHED (mutating the result poisons it
//     for every other caller). Convenient, mildly dangerous.
import { createRequire } from "node:module";
const pkg2 = createRequire(import.meta.url)("./package.json");

// (c) import attributes — the modern ESM way (Node 20.10+). Static path only.
import pkg3 from "./package.json" with { type: "json" };
```

---

## 3. The module cache

### 3.1 One evaluation per resolved URL

```ts
// counter.ts
console.log("counter.ts evaluated");
export let count = 0;
export const increment = () => ++count;
```

```ts
import { count, increment } from "./counter.ts";
increment();

const again = await import("./counter.ts");        // same URL → cache hit
console.log(again.count);                          // 1 — the same instance
console.log(again === await import("./counter.ts"));  // true

// "counter.ts evaluated" printed exactly ONCE, no matter how many importers.
```

Node keys the cache on the **resolved URL string**. A relative path and an absolute `file://` URL that normalise to the same file give you one module.

### 3.2 Busting the cache

ESM has no `delete require.cache[...]`. The supported trick is a query string, which changes the URL:

```ts
const fresh = await import("./counter.ts?v=" + Date.now());
console.log(fresh.count);   // 0 — a brand new module instance
```

The old instance is **not** freed — you now have two copies in memory. This is a dev-server / debugging tool, never a production pattern.

### 3.3 Why this matters: three real bugs

**(a) Modules are accidental singletons.**

```ts
// db.ts — DON'T
export const pool = createPool(process.env.DATABASE_URL);
```

The pool is created at *import* time: before `main()` runs, before `.env` is loaded, and in every test file that transitively imports this — including ones that never touch the database. Prefer a factory:

```ts
// db.ts — DO
export function createDb(config: Config) {
  return createPool(config.databaseUrl);
}
```

```ts
// main.ts — explicit wiring, testable, ordered
const config = await loadConfig();
const db = createDb(config);
```

**(b) Duplicate packages break `instanceof`.**

```
node_modules/
  lib/              (v2)
  pkg-a/
    node_modules/
      lib/          (v1)  ← a second, separate copy
```

Two copies means two module graphs, two class definitions:

```ts
import { Thing } from "lib";
const value = pkgA.makeThing();
value instanceof Thing;   // false — it's the OTHER Thing
```

Diagnose with `npm ls lib`. Fix with `overrides` in package.json, or by making `lib` a `peerDependency` of `pkg-a`.

**(c) Import-time side effects are ordering bugs.**

Every statically-imported module's body runs **before any line** of the importing file:

```ts
import "./sets-a-global.ts";   // this runs first
console.log("main starts");    // this runs second
```

ESM resolves and parses the whole graph, then evaluates depth-first, deepest dependency first. If module A sets a global that module B reads at import time, B wins the race — always, regardless of the order you wrote the imports.

---

## 4. Globals and `process`

Node's global object is `globalThis`, not `window`.

| Global | Notes |
|---|---|
| `process` | argv, env, cwd, exit, signals, stdio |
| `Buffer` | binary data (module 04) |
| `setImmediate` | **Node-only**; no browser equivalent |
| `queueMicrotask`, `structuredClone`, `AbortController`, `fetch`, `URL`, `TextEncoder`, `crypto` | web-standard, also present |
| `__dirname`, `__filename`, `require`, `module`, `exports` | **CJS only** — and not really globals |

Those last five are parameters of the wrapper function Node generates around every CommonJS file:

```js
(function (exports, require, module, __filename, __dirname) {
  // your .cjs file's code goes here
});
```

### 4.1 argv and `parseArgs`

```ts
process.argv;         // [nodePath, scriptPath, ...userArgs]
process.argv.slice(2) // just the user's args
```

Node has a real argument parser built in since 18.3 — no `yargs` or `commander` needed for simple CLIs:

```ts
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    verbose: { type: "boolean", short: "v", default: false },
    output:  { type: "string",  short: "o" },
    include: { type: "string",  multiple: true },   // repeatable flag
  },
  allowPositionals: true,
});

// $ node cli.ts -v --output=dist --include a --include b file.txt
// values      → { verbose: true, output: "dist", include: ["a", "b"] }
// positionals → ["file.txt"]
```

### 4.2 env — everything is `string | undefined`

There are no numbers and no booleans in `process.env`:

```ts
process.env.DEBUG = 0;
typeof process.env.DEBUG;        // "string"
process.env.DEBUG;               // "0"  ← truthy!
if (process.env.DEBUG) { }       // ✗ this branch RUNS
```

Validate at the boundary, once, into a typed frozen object — never sprinkle `process.env.X` through your codebase:

```ts
function requireEnv(key: string): string {
  const v = process.env[key];
  if (v === undefined || v === "") throw new Error(`Missing env var: ${key}`);
  return v;
}

function intEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new Error(`${key} must be an integer, got "${raw}"`);
  return n;
}

function boolEnv(key: string, fallback = false): boolean {
  const raw = process.env[key]?.toLowerCase();
  if (raw === undefined) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(`${key} must be a boolean, got "${raw}"`);
}

export const config = Object.freeze({
  port: intEnv("PORT", 3000),
  databaseUrl: requireEnv("DATABASE_URL"),
  debug: boolEnv("DEBUG"),
});
```

Node loads `.env` files natively since 20.6 — no `dotenv` package:

```bash
node --env-file=.env app.ts
node --env-file=.env --env-file=.env.local app.ts   # later files win
```

### 4.3 Exiting properly

```ts
process.exit(1);        // stops NOW. Pending I/O abandoned, buffered stdout may be LOST.
process.exitCode = 1;   // records intent; Node exits when the loop drains. ✓ PREFER THIS
```

Why the truncation risk is real: `process.stdout` is **synchronous** to a file and to a TTY on POSIX, but **asynchronous** to a pipe. So this can lose output:

```ts
console.log(hugeString);
process.exit(0);        // ✗ piping to `less` or a log collector? output truncated
```

```ts
console.log(hugeString);
process.exitCode = 0;   // ✓ Node flushes, then exits
```

### 4.4 Lifecycle events

```ts
process.on("beforeExit", (code) => {
  // Loop is empty. You MAY schedule more async work here — which makes this
  // fire again. Does NOT fire on an explicit process.exit().
});

process.on("exit", (code) => {
  // Loop is dead. ONLY synchronous code runs. No await, no I/O, no timers.
  console.log("bye");
});

process.on("uncaughtException", (err) => {
  // Log, flush, DIE. Do not "recover" — invariants may be broken.
  logger.fatal({ err }, "uncaught");
  process.exitCode = 1;
});

process.on("unhandledRejection", (reason) => {
  logger.fatal({ reason }, "unhandled rejection");
  process.exitCode = 1;
});

process.on("warning", (w) => logger.warn({ w }));   // catches MaxListenersExceededWarning etc.
```

### 4.5 Graceful shutdown

The shape every real service needs:

```ts
const server = app.listen(config.port);

function shutdown(signal: NodeJS.Signals) {
  console.log(`${signal} received, draining...`);
  server.close(async () => {          // stop accepting; finish in-flight requests
    await db.end();
    process.exitCode = 0;
  });
  // Never hang forever. unref() so this timer doesn't itself block exit.
  setTimeout(() => {
    console.error("forced exit after 10s");
    process.exit(1);
  }, 10_000).unref();
}

process.on("SIGINT", shutdown);    // Ctrl+C
process.on("SIGTERM", shutdown);   // Docker / Kubernetes / systemd
// SIGKILL cannot be caught, by design.
```

`unref()` means "this handle should not keep the process alive". Essential for keepalives, cache sweepers, metrics flushes, and health probes.

---

## 5. Paths

Use `node:path`. Never string concatenation, never a hand-written `/`.

### 5.1 `cwd()` vs `import.meta.dirname` — the #1 script bug

```ts
process.cwd()         // where the USER ran the command. Changes constantly.
import.meta.dirname   // where THIS FILE lives. Fixed relative to your code.
```

| You are loading… | Use |
|---|---|
| An asset that ships **with your code** (templates, migrations, fixtures, defaults) | `import.meta.dirname` |
| A path the **user typed** on the CLI | `process.cwd()` |

Getting this backwards is exactly why a CLI works from the project root and explodes from anywhere else:

```ts
// ✗ breaks unless cwd happens to be the project root
const tpl = await readFile("./templates/email.html", "utf8");

// ✓ works from anywhere
const tpl = await readFile(path.join(import.meta.dirname, "templates/email.html"), "utf8");

// ✓ tidiest in ESM — fs accepts a URL directly
const tpl = await readFile(new URL("./templates/email.html", import.meta.url), "utf8");
```

### 5.2 `join` vs `resolve`

```ts
path.join("a", "b", "../c");     // "a/c"          — relative, just normalises
path.resolve("a", "b", "../c");  // "/cwd/a/c"     — always absolute

// resolve() works RIGHT-TO-LEFT and stops at the first absolute segment:
path.resolve("/x", "/y", "z");   // "/y/z"   ← "/x" was discarded entirely
```

That last behaviour is a security trap:

```ts
path.resolve(uploadsDir, userInput);
// userInput = "photo.jpg"    → /srv/uploads/photo.jpg     ✓
// userInput = "/etc/passwd"  → /etc/passwd                ✗ escaped!
// userInput = "../../etc/passwd" → /etc/passwd            ✗ escaped!
```

To actually confine a path, resolve **then verify**:

```ts
function safeJoin(base: string, userPath: string): string {
  const resolved = path.resolve(base, userPath);
  const rel = path.relative(base, resolved);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path escapes base: ${userPath}`);
  }
  return resolved;
}

safeJoin("/srv/uploads", "photo.jpg");        // ✓ /srv/uploads/photo.jpg
safeJoin("/srv/uploads", "a/../b.txt");       // ✓ /srv/uploads/b.txt
safeJoin("/srv/uploads", "../../etc/passwd"); // ✗ throws
safeJoin("/srv/uploads", "/etc/passwd");      // ✗ throws
```

Checking the raw string for `".."` does **not** work — it's defeated by encodings, by backslashes on Windows, and by absolute paths that contain no `..` at all. `path.relative()` normalises all of it.

> Still not enough for fully untrusted input: a **symlink** inside `base` can point outside it. Follow up with `fs.realpath()` and re-check.

### 5.3 Parsing

```ts
const p = "/srv/app/reports/2026-Q1.report.csv";

path.parse(p);
// { root: "/", dir: "/srv/app/reports", base: "2026-Q1.report.csv",
//   ext: ".csv", name: "2026-Q1.report" }

path.extname(p);                      // ".csv"  — only the LAST dot
path.basename(p);                     // "2026-Q1.report.csv"
path.basename(p, path.extname(p));    // "2026-Q1.report"
path.dirname(p);                      // "/srv/app/reports"
```

### 5.4 Paths vs URLs

`import.meta.url` is a URL, not a path. On Windows it looks like `file:///C:/Users/...` — passing that string to `fs` fails.

```ts
import { fileURLToPath, pathToFileURL } from "node:url";

fileURLToPath(import.meta.url);            // C:\Users\you\app\main.ts
pathToFileURL("C:\\Users\\you\\a b.txt");  // file:///C:/Users/you/a%20b.txt
```

Never do `url.replace("file://", "")` or `.slice(7)` — they break on Windows drive letters and on any path containing a space (`%20`).

URL paths are always POSIX (forward slashes, percent-encoded). Filesystem paths follow the OS.

### 5.5 Cross-platform

```ts
path.sep;         // "/" on POSIX, "\\" on Windows
path.delimiter;   // ":" on POSIX, ";" on Windows — for splitting PATH

path.posix.join("a", "b");   // always "a/b"   — use for URLs, S3 keys, git paths
path.win32.join("a", "b");   // always "a\\b"
```

Use `path.posix` explicitly for things that are conceptually URLs. Use plain `path` for the local filesystem.

Other Windows realities: case-insensitive filenames, no `:` `?` `*` `<` `>` `|` in names, a legacy 260-character limit, and `\\?\` long-path prefixes.

---

## 6. Files in this module

| File | What it demonstrates |
|---|---|
| `01-esm-vs-cjs.ts` | live bindings, top-level await, `createRequire`, CJS interop, evaluation order |
| `02-resolution.ts` | specifier kinds, `node:` prefix, `import.meta.resolve`, JSON loading |
| `03-module-cache.ts` | one-evaluation-per-URL, cache busting, the singleton traps |
| `04-process-globals.ts` | argv, `parseArgs`, env validation, signals, exit codes |
| `05-paths.ts` | `cwd` vs `dirname`, join vs resolve, containment, URL conversion |
| `exercise.ts` | build a config loader — defaults + env overlay + validation + safe paths |
| `solution.ts` | reference implementation, commented with the *why* |

```bash
node src/01-modules/index.ts                  # run all five demos
node src/01-modules/01-esm-vs-cjs.ts          # run one
node scripts/test.ts 01                       # test your exercise
node scripts/test.ts --solutions 01           # test the reference
```

---

## 7. Check yourself

1. Why does `import { x } from "./cjs-file.cjs"` sometimes fail while `import cjs from "./cjs-file.cjs"` works?
2. A package has `"exports": { ".": "./dist/index.js" }`. A user writes `import "pkg/dist/utils.js"`. What happens, and why is that the *intended* behaviour?
3. A module has `console.log("loaded")` at the top and is imported by three different files. How many times does it print, and *when*?
4. Your CLI reads `./config.json`. It works from the project root and breaks from anywhere else. What's the one-line fix?
5. Why is `path.resolve(uploadsDir, userInput)` not sufficient to keep a user inside `uploadsDir`?
6. `process.env.FEATURE_ENABLED = "false"`. What does `if (process.env.FEATURE_ENABLED)` do?
7. When would you reach for `process.exit()` instead of `process.exitCode`?
