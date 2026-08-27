/**
 * 03 — The module cache (and why modules are accidental singletons)
 *
 * Run:  node src/01-modules/03-module-cache.ts
 */

import { count, increment } from "./_fixtures/counter.ts";

console.log("\n=== 1. One evaluation per resolved URL ===");
// The counter module already printed "[counter.ts] module body evaluated"
// exactly once, above — even though we're about to import it several more times.
increment();
console.log("count is now:", count); // 1

console.log("\n=== 2. Dynamic import hits the same cache ===");
const again = await import("./_fixtures/counter.ts");
console.log("same count:", again.count); // 1 — same module instance, not a fresh one
again.increment();
console.log("mutation is shared:", count); // 2 — our static binding sees it too

console.log("\n=== 3. Different specifier, same URL → still one instance ===");
// A relative path and an absolute file:// URL that normalize to the same file
// produce ONE module. Node keys the cache on the resolved URL string.
const viaUrl = await import(import.meta.resolve("./_fixtures/counter.ts"));
console.log("identical namespace object:", viaUrl === again); // true

console.log("\n=== 4. Busting the cache ===");
// There is no `delete require.cache[...]` for ESM. The supported trick is a
// query string: it changes the URL, so it's a cache MISS and re-evaluates.
// (The old instance is NOT freed — you now have two copies in memory. This is
// a debugging/dev-server tool, never a production pattern.)
// Note: the specifier is in a variable. A string literal would make TypeScript
// try to resolve "counter.ts?v=2" as a file and fail — the query string is a
// runtime-only concept that the typechecker doesn't model.
const bustedSpecifier = "./_fixtures/counter.ts?v=2";
const fresh = (await import(bustedSpecifier)) as typeof import("./_fixtures/counter.ts");
console.log("fresh copy count:", fresh.count); // 0 — a brand new module instance
console.log("original untouched:", count); // 2

console.log(`
=== 5. Why this matters in the real world ===

  a) Modules are the simplest singleton you have:
         // db.ts
         export const pool = createPool(process.env.DATABASE_URL);
     Every importer shares one pool. Convenient — but the pool is created at
     IMPORT time, before main() runs, before you've loaded .env, and it happens
     even in tests that never touch the database. Prefer:
         export function createDb(cfg: Config) { ... }
     and wire it up explicitly in your entry point.

  b) Duplicate packages break identity. If two dependencies each ship their own
     copy of "lib@1" and "lib@2", npm may install BOTH. You then have two
     module graphs, two class definitions, and:
         value instanceof Lib.Thing   // false, even though it "is" one
     Diagnose with \`npm ls <pkg>\`. Fix with \`overrides\` or a peerDependency.

  c) Import-time side effects are ordering bugs waiting to happen. If A imports
     B and B reads a global that A sets, B wins the race — B's body runs first.

  d) Circular imports: ESM hoists the bindings, so the cycle resolves, but
     reading an imported value during the cycle's evaluation throws
     "Cannot access 'x' before initialization" (TDZ). CJS quietly gives you
     \`undefined\` instead, which is worse. Neither is a feature — break the cycle.
`);
