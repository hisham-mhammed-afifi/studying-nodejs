/**
 * 02 — How Node resolves a specifier
 *
 * Run:  node src/01-modules/02-resolution.ts
 */

import { builtinModules, createRequire } from "node:module";
import { readFile } from "node:fs/promises";

console.log("=== Specifier kinds ===");
console.log(`
  "./x.ts"        relative  → resolved against import.meta.url; extension REQUIRED
  "/abs/x.ts"     absolute  → filesystem root (rarely what you want)
  "file:///x.ts"  URL       → the canonical internal form; all of the above become this
  "node:fs"       builtin   → straight to the runtime, never touches disk
  "express"       bare      → walk node_modules/ upward from this file
  "#config"       internal  → package.json "imports" field of the nearest package
`);

console.log("=== The node: prefix ===");
// Both of these work for builtins, but ALWAYS use the `node:` prefix:
//   1. It cannot be shadowed by a package on npm named e.g. "fs" or "path".
//      (Unprefixed builtins win over node_modules, but the prefix makes it explicit.)
//   2. Some newer builtins (node:test, node:sqlite, node:sea) are prefix-ONLY.
//   3. It's an instant signal to a reader that no dependency is involved.
console.log("total builtin modules:", builtinModules.length);
console.log("prefix-only examples:", builtinModules.filter((m) => m.startsWith("node:")));

console.log("\n=== import.meta.resolve ===");
// Synchronous. Returns the URL a specifier WOULD resolve to, without loading it.
// Useful for locating a dependency's files, or checking existence.
console.log("node:fs        →", import.meta.resolve("node:fs"));
console.log("./_fixtures/counter.ts →", import.meta.resolve("./_fixtures/counter.ts"));

// Bare specifiers that aren't installed throw ERR_MODULE_NOT_FOUND:
try {
  import.meta.resolve("some-package-that-does-not-exist");
} catch (err) {
  console.log("missing package →", (err as NodeJS.ErrnoException).code);
}

console.log("\n=== The 'exports' field is a wall, not a hint ===");
console.log(`
  A package.json with:
      "exports": { ".": "./dist/index.js", "./utils": "./dist/utils.js" }
  allows:
      import "pkg"            ✓
      import "pkg/utils"      ✓
  and REJECTS, with ERR_PACKAGE_PATH_NOT_EXPORTED:
      import "pkg/dist/utils.js"    ✗  even though the file exists on disk

  This is real encapsulation — the reason you can no longer reach into a
  modern package's internals. "main" is the legacy fallback for packages
  without "exports".

  Conditions let one specifier map to several files:
      "exports": { ".": { "types": "./d.ts", "import": "./esm.js", "require": "./cjs.js" } }
  Order matters — Node picks the FIRST matching key. "types" must come first.
`);

console.log("=== JSON: three ways ===");
const require = createRequire(import.meta.url);
const pkgPath = new URL("../../package.json", import.meta.url);

// (a) fs — always works, explicit, async. The boring correct default.
const viaFs = JSON.parse(await readFile(pkgPath, "utf8")) as { name: string };

// (b) createRequire — sync, and CACHED (mutating the result poisons it for
//     everyone else who requires the same file). Convenient, mildly dangerous.
const viaRequire = require("../../package.json") as { name: string };

// (c) import attributes — the modern ESM way, Node 20.10+:
//        import pkg from "../../package.json" with { type: "json" };
//     Static, so it must be a literal path. Frozen-ish and cached.

console.log("fs:     ", viaFs.name);
console.log("require:", viaRequire.name);

console.log("\n=== Subpath imports: killing ../../../ ===");
console.log(`
  In package.json:
      "imports": { "#src/*": "./src/*" }
  Then from anywhere in the project:
      import { thing } from "#src/01-modules/_fixtures/counter.ts";

  Advantages over a tsconfig "paths" alias: this is resolved by NODE itself,
  so it works at runtime with zero build step or loader. tsconfig "paths" only
  informs the typechecker — it does not change what Node does at runtime.
`);
