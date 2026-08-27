/**
 * 05 — Paths: the #1 source of "works on my machine"
 *
 * Run:  node src/01-modules/05-paths.ts
 * Then, from a DIFFERENT directory:  cd /tmp && node <full-path-to>/05-paths.ts
 * Watch which values change and which don't. That's the whole lesson.
 */

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { access } from "node:fs/promises";

console.log("=== cwd vs dirname ===");
console.log("process.cwd():       ", process.cwd());
console.log("import.meta.dirname: ", import.meta.dirname);
console.log(`
  process.cwd()        = where the USER ran the command. Changes constantly.
  import.meta.dirname  = where THIS FILE lives. Fixed relative to your code.

  Rule of thumb:
    Loading an asset that ships WITH your code (templates, migrations,
    fixtures, a bundled config default)?          → import.meta.dirname
    Resolving a path the USER typed on the CLI?   → process.cwd()

  Getting this backwards is why a CLI works from the project root and
  explodes from anywhere else.
`);

console.log("=== join vs resolve ===");
console.log("join('a','b','../c')      →", path.join("a", "b", "../c")); // a/c  (relative!)
console.log("resolve('a','b','../c')   →", path.resolve("a", "b", "../c")); // <cwd>/a/c
// resolve() processes right-to-left and STOPS at the first absolute segment:
console.log("resolve('/x','/y','z')    →", path.resolve("/x", "/y", "z")); // /y/z  — '/x' discarded
// So `path.resolve(base, userInput)` does NOT confine userInput to base.
// If userInput is "/etc/passwd" it escapes entirely. To confine, resolve then check:
function isInside(base: string, target: string): boolean {
  const rel = path.relative(base, target);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}
const uploads = path.resolve("/srv/uploads");
console.log("safe? ", isInside(uploads, path.resolve(uploads, "photo.jpg"))); // true
console.log("safe? ", isInside(uploads, path.resolve(uploads, "../../etc/passwd"))); // false

console.log("\n=== parsing ===");
const p = "/srv/app/reports/2026-Q1.report.csv";
console.log(path.parse(p));
console.log("extname:", path.extname(p)); // ".csv" — only the LAST dot
console.log("basename minus ext:", path.basename(p, path.extname(p)));

console.log("\n=== paths vs URLs ===");
// import.meta.url is a file:// URL, not a path. On Windows it looks like
// "file:///C:/Users/..." — passing that string to fs would fail.
console.log("import.meta.url:", import.meta.url);
console.log("as a path:      ", fileURLToPath(import.meta.url));
console.log("back to a URL:  ", pathToFileURL(import.meta.filename).href);
console.log(`
  URL paths are ALWAYS posix (forward slashes, %20 for spaces).
  Filesystem paths follow the OS. Convert with fileURLToPath / pathToFileURL —
  never with .replace("file://", "") or .slice(7).

  Handy: most fs functions accept a URL object directly, so you can skip the
  conversion entirely:  await readFile(new URL("./data.json", import.meta.url))
`);

console.log("=== a robust project-relative loader ===");
// This works no matter where the process was launched from.
const fixtures = path.join(import.meta.dirname, "_fixtures");
const target = path.join(fixtures, "counter.ts");
await access(target); // throws if missing
console.log("found:", path.relative(process.cwd(), target), "(shown relative to cwd)");

console.log("\n=== cross-platform notes ===");
console.log("path.sep:      ", JSON.stringify(path.sep)); // "/" or "\\"
console.log("path.delimiter:", JSON.stringify(path.delimiter)); // ":" or ";" — for PATH
console.log("posix join:    ", path.posix.join("a", "b")); // always "a/b"
console.log("win32 join:    ", path.win32.join("a", "b")); // always "a\\b"
console.log(`
  Use path.posix explicitly for things that are conceptually URLs (route
  paths, S3 keys, git paths). Use plain \`path\` for the local filesystem.
  Windows also: case-insensitive, no ":" or "?" in names, 260-char legacy
  limit, and "\\\\?\\" long-path prefixes. Never hand-build separators.
`);
