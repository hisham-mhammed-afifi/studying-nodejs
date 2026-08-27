/**
 * 04 — Races, existsSync, and symlink escapes
 *
 * Run:  node src/06-filesystem/04-races.ts
 */

import { readFile, writeFile, mkdir, rm, symlink, realpath, lstat, stat, access } from "node:fs/promises";
import { existsSync, constants } from "node:fs";
import path from "node:path";
import { withTempDir, codeOf, isErrno } from "./_helpers.ts";

/** Windows needs elevated privileges to create symlinks; skip gracefully. */
async function symlinksWork(dir: string): Promise<boolean> {
  const probe = path.join(dir, ".symlink-probe");
  try {
    await symlink(dir, probe, "dir");
    await rm(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

await withTempDir(async (dir) => {
  const canSymlink = await symlinksWork(dir);

  console.log("=== 1. Time-of-check to time-of-use ===");
  {
    const p = path.join(dir, "config.json");
    await writeFile(p, "{}");

    // ✗ Two syscalls with a window between them. In that window the file can
    //   be deleted, replaced, turned into a directory, or swapped for a
    //   symlink by anyone with write access to the directory.
    if (existsSync(p)) {
      await rm(p); // ← simulate the race: something else removed it
      const code = await codeOf(() => readFile(p));
      console.log("  existsSync said yes, then readFile →", code, "✗");
    }

    // ✓ One atomic operation. Handle the failure you actually care about.
    await writeFile(p, '{"ok":true}');
    async function readConfig(file: string): Promise<unknown> {
      try {
        return JSON.parse(await readFile(file, "utf8"));
      } catch (err) {
        if (isErrno(err) && err.code === "ENOENT") return { default: true };
        throw err;
      }
    }
    console.log("  try/catch version →", await readConfig(p));
    console.log("  on a missing file →", await readConfig(path.join(dir, "nope.json")));
    console.log(`
  Also faster: one syscall instead of two. There is no version of
  check-then-act that is both correct and shorter than just trying it.
`);
  }

  console.log("=== 2. access() has the same problem ===");
  {
    const p = path.join(dir, "config.json");
    await access(p, constants.R_OK);
    console.log("  access(p, R_OK) succeeded — and is still a race");
    console.log(`
  The Node docs say this outright:

    "Using access() to check for the accessibility of a file before calling
     open(), readFile(), or writeFile() is not recommended."

  The only sound use is DIAGNOSTICS, where a race is harmless:

      // at startup: fail fast with a good message
      try { await access(dataDir, constants.W_OK); }
      catch { throw new Error(\`Data directory not writable: \${dataDir}\`); }
`);
  }

  console.log("=== 3. Atomic alternatives ===");
  {
    const p = path.join(dir, "once.txt");

    console.log("  ✗ if (!exists) write   → ✓ writeFile(p, d, { flag: 'wx' })");
    await writeFile(p, "first", { flag: "wx" });
    console.log("     second attempt:", await codeOf(() => writeFile(p, "second", { flag: "wx" })));

    console.log("  ✗ if (exists) delete   → ✓ rm(p, { force: true })");
    await rm(path.join(dir, "never-existed"), { force: true });
    console.log("     rm force on a missing path: no error ✓");

    console.log("  ✗ if (!exists) mkdir   → ✓ mkdir(p, { recursive: true })");
    await mkdir(path.join(dir, "x/y"), { recursive: true });
    await mkdir(path.join(dir, "x/y"), { recursive: true });
    console.log("     mkdir recursive twice: no error ✓");

    console.log("  ✗ writeFile config     → ✓ temp file + rename (see 02-read-write.ts §4)");
  }

  console.log("\n=== 4. stat vs lstat ===");
  if (!canSymlink) {
    console.log("  (skipped — symlinks unavailable; Windows needs elevated privileges)");
  } else {
    const target = path.join(dir, "real.txt");
    const link = path.join(dir, "link.txt");
    await writeFile(target, "content");
    await symlink(target, link);

    console.log("  stat(link).isFile():          ", (await stat(link)).isFile(), "← FOLLOWS the link");
    console.log("  stat(link).isSymbolicLink():  ", (await stat(link)).isSymbolicLink());
    console.log("  lstat(link).isSymbolicLink(): ", (await lstat(link)).isSymbolicLink(), "← describes the LINK");
    console.log("  realpath(link):               ", path.basename(await realpath(link)));
    console.log(`
  Rule for anything walking a tree: use lstat (or Dirent, which behaves the
  same way). A stat-based walker follows a symlink pointing at an ancestor
  and recurses until the stack blows.
`);
  }

  console.log("=== 5. Symlinks defeat string-level path checks ===");
  if (!canSymlink) {
    console.log("  (skipped — symlinks unavailable on this platform)");
  } else {
    const base = path.join(dir, "uploads");
    const outside = path.join(dir, "private");
    await mkdir(base, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "secrets.txt"), "API_KEY=hunter2");

    await symlink(path.join(outside, "secrets.txt"), path.join(base, "report.pdf"));

    // The string check from module 01 §5.2 — necessary, but NOT sufficient.
    function stringCheck(b: string, userPath: string): string {
      const resolved = path.resolve(b, userPath);
      const rel = path.relative(b, resolved);
      if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("escapes base");
      return resolved;
    }

    const passed = stringCheck(base, "report.pdf");
    console.log("  string check on 'report.pdf': PASSED ✓");
    console.log("  what it actually reads:      ", JSON.stringify(await readFile(passed, "utf8")), "✗✗✗");
    console.log(`
  The path never leaves the base directory. The FILESYSTEM does. Every
  "prevent directory traversal" check written with path.relative alone has
  this hole.
`);

    // ✓ Resolve the real path, then check containment on THAT.
    async function safeResolve(b: string, userPath: string): Promise<string> {
      const realBase = await realpath(b);
      const candidate = path.resolve(realBase, userPath);
      let real: string;
      try {
        real = await realpath(candidate);
      } catch (err) {
        // realpath throws ENOENT for files that don't exist yet. Fall back to
        // the nearest existing ancestor — that still catches a symlinked
        // PARENT directory, which is the attack that matters for writes.
        if (!isErrno(err) || err.code !== "ENOENT") throw err;
        real = path.join(await realpath(path.dirname(candidate)), path.basename(candidate));
      }
      const rel = path.relative(realBase, real);
      if (rel !== "" && (rel.startsWith("..") || path.isAbsolute(rel))) {
        throw new Error(`escapes base: ${userPath}`);
      }
      return real;
    }

    try {
      await safeResolve(base, "report.pdf");
      console.log("  safeResolve('report.pdf') → allowed ✗ (unexpected!)");
    } catch (err) {
      console.log("  safeResolve('report.pdf') → rejected:", (err as Error).message, "✓");
    }

    await writeFile(path.join(base, "genuine.pdf"), "ok");
    console.log("  safeResolve('genuine.pdf') → allowed:", path.basename(await safeResolve(base, "genuine.pdf")), "✓");
    console.log("  safeResolve('new-file.pdf') (doesn't exist yet) → allowed:", path.basename(await safeResolve(base, "new-file.pdf")), "✓");

    console.log(`
  Caveats worth knowing:

  • This is STILL TOCTOU in principle — a symlink could appear between the
    realpath and the open. The airtight fix is O_NOFOLLOW or openat() against
    a directory fd, which Node does not expose.
  • The practical answer: realpath-check AND never serve files out of a
    directory that untrusted users can write to.
  • Same applies to archive extraction: a tar/zip entry named "../../etc/x"
    or containing a symlink is the "Zip Slip" vulnerability class.
`);
  }
});
