// A genuine CommonJS module. The `.cjs` extension forces CJS regardless of
// the package.json "type" field.
//
// Note what exists in here that does NOT exist in ESM:
//   __dirname, __filename, require, module, exports
// They are not globals — they are parameters of the wrapper function Node
// generates around every CJS file:
//   (function (exports, require, module, __filename, __dirname) { ... })

"use strict";

const path = require("node:path");

function greet(name) {
  return `hello ${name} (from CJS)`;
}

// `module.exports` is what importers get as the *default* export from ESM.
// Node also statically analyses this file to guess named exports — that
// analysis is best-effort. Anything computed at runtime (e.g.
// `module.exports[someVar] = ...`) will NOT be detected.
module.exports = {
  greet,
  dirName: path.basename(__dirname),
  // `this` at CJS top level === module.exports (in ESM it is `undefined`)
  thisIsModuleExports: this === module.exports,
};
