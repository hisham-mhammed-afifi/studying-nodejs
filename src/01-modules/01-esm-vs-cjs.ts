/**
 * 01 — ESM vs CommonJS
 *
 * Run:  node src/01-modules/01-esm-vs-cjs.ts
 *
 * PREDICT FIRST: write down what you think each section prints, then run it.
 */

import { createRequire } from "node:module";
// Note the `.ts` extension. In ESM the extension is MANDATORY — there is no
// extension guessing, no index.js resolution, no "it'll figure it out".
// tsconfig's `rewriteRelativeImportExtensions` keeps `tsc` happy with this.
import { count, increment } from "./_fixtures/counter.ts";

console.log("=== 1. Live bindings ===");
// `count` was imported as 0. We never re-import it. But ESM imports are
// *bindings*, not copies — reading `count` reads the exporter's variable.
console.log("count before:", count); // 0
increment();
increment();
console.log("count after:", count); // 2  <-- CJS would print 0 here

// Uncomment to see the error: imported bindings are read-only in the importer.
// count = 99; // TS2588 / TypeError: Assignment to constant variable.

console.log("\n=== 2. Top-level await ===");
// Only legal in ESM. In CJS this is a syntax error.
const tick = await new Promise<string>((r) => setTimeout(() => r("resolved"), 10));
console.log("top-level await:", tick);

console.log("\n=== 3. import.meta ===");
// ESM has no __dirname / __filename. `import.meta` replaces them.
console.log("import.meta.url:     ", import.meta.url); // a file:// URL
console.log("import.meta.dirname: ", import.meta.dirname); // Node 20.11+
console.log("import.meta.filename:", import.meta.filename);
// `this` at the top level of an ESM module is undefined (it's module.exports in CJS).
console.log("typeof this:", typeof this);

console.log("\n=== 4. Interop: importing CommonJS ===");
// Importing a CJS module from ESM gives you `module.exports` as the DEFAULT export.
// `_fixtures/legacy.d.cts` supplies the types — see that file for how you
// describe an untyped JS dependency to TypeScript.
const legacy = (await import("./_fixtures/legacy.cjs")).default;
console.log(legacy.greet("world"));
console.log("CJS __dirname basename:", legacy.dirName);
console.log("CJS `this === module.exports`:", legacy.thisIsModuleExports);

console.log("\n=== 5. Interop: require() from ESM ===");
// Sometimes you need real `require` — e.g. to read a JSON file, or to load a
// package whose named exports Node cannot statically detect.
const require = createRequire(import.meta.url);
const alsoLegacy = require("./_fixtures/legacy.cjs");
// Same resolved file → SAME cached instance. Not a second copy.
console.log("same object as the dynamic import?", alsoLegacy === legacy);

console.log("\n=== 6. Ordering ===");
// Notice where "[counter.ts] module body evaluated" appeared in the output:
// at the very TOP, before "=== 1. ===" ever printed.
//
// ESM has two phases:
//   1. resolve + fetch + parse the WHOLE graph (all static imports, recursively)
//   2. evaluate modules depth-first, deepest dependency first
//
// So every statically-imported module's body runs before ANY line of this file.
// That is why import-time side effects are dangerous: they run before you can
// configure anything. Export a factory function instead of doing work at import.
console.log("this file's body finished last, as always");
