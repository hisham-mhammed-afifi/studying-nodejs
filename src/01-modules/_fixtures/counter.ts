// A module with mutable state, to demonstrate ESM *live bindings*.
//
// In CommonJS, `exports.count = count` copies the value once. Importers would
// be frozen at 0 forever. In ESM, `count` is a live binding: importers see the
// current value every time they read it — but they may NOT write to it.

export let count = 0;

export function increment(): number {
  count += 1;
  return count;
}

// Side effect at import time. This runs exactly once, the first time any
// module imports this file — before the importing module's own body continues.
console.log("  [counter.ts] module body evaluated");
