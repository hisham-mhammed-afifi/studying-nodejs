// Hand-written types for a JS-only CommonJS module.
//
// This is exactly what `@types/*` packages on npm are: declaration files that
// describe a JavaScript library TypeScript cannot otherwise understand.
// The `.d.cts` extension pairs with `legacy.cjs` (`.d.mts` ↔ `.mjs`, `.d.ts` ↔ `.js`).
//
// `export =` is the CJS-shaped export: it says "module.exports IS this value",
// which is why ESM importers receive it as the default export.

declare const legacy: {
  greet(name: string): string;
  dirName: string;
  thisIsModuleExports: boolean;
};

export = legacy;
