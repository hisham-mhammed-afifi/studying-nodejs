/**
 * 03 — Directories: readdir, Dirent, opendir, glob, walking
 *
 * Run:  node src/06-filesystem/03-directories.ts
 */

import { readdir, mkdir, writeFile, opendir, stat, glob, symlink } from "node:fs/promises";
import path from "node:path";
import { withTempDir, codeOf } from "./_helpers.ts";

await withTempDir(async (dir) => {
  // Build a small tree to explore.
  await mkdir(path.join(dir, "src/lib"), { recursive: true });
  await mkdir(path.join(dir, "node_modules/pkg"), { recursive: true });
  for (const f of ["README.md", "src/index.ts", "src/util.ts", "src/lib/deep.ts", "node_modules/pkg/i.js"]) {
    await writeFile(path.join(dir, f), "x");
  }

  console.log("=== 1. readdir returns NAMES, not paths ===");
  {
    const names = await readdir(path.join(dir, "src"));
    console.log("  readdir('src') →", names);
    console.log("  stat on a bare name →", await codeOf(() => stat(names[0] as string)), "← resolved against cwd, not the listed dir");
    console.log("  stat on the joined path →", await codeOf(() => stat(path.join(dir, "src", names[0] as string))));
    console.log(`
  The single most common readdir bug. Names are relative to the directory
  you listed, not to your cwd. Always path.join(dir, name).
`);
  }

  console.log("=== 2. withFileTypes saves a syscall per entry ===");
  {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const kind = e.isDirectory() ? "dir " : e.isSymbolicLink() ? "link" : "file";
      console.log(`  ${kind}  ${e.name}`);
    }
    console.log(`
  Without withFileTypes you need a stat() per entry just to know what things
  are. On a directory with 10,000 files that's 10,000 extra trips through
  the 4-thread pool. readdir already knew — ask it.

  ⚠ Dirent does NOT follow symlinks: for a link, isFile() is false and
  isSymbolicLink() is true. Usually what you want; occasionally a surprise.
`);
  }

  console.log("=== 3. recursive readdir (Node 20.1+) ===");
  {
    const all = await readdir(dir, { recursive: true, withFileTypes: true });
    const files = all
      .filter((e) => e.isFile())
      // parentPath is Node 21+; older versions used dirent.path.
      .map((e) => path.relative(dir, path.join(e.parentPath, e.name)))
      .sort();
    console.log("  all files:", files);
    console.log(`
  Convenient, but note what it CANNOT do: prune. It descends into
  node_modules, .git, and every other tree you didn't want, THEN hands you
  the list. On a real repo that's most of the work wasted.

  When you need to skip subtrees, walk it yourself (§5) or use glob (§4).
`);
  }

  console.log("=== 4. glob is built in (Node 22+) ===");
  {
    const found: string[] = [];
    for await (const p of glob("**/*.ts", { cwd: dir })) found.push(p);
    console.log("  glob('**/*.ts'):", found.sort());

    const pruned: string[] = [];
    for await (const p of glob("**/*", { cwd: dir, exclude: (name) => name === "node_modules" })) {
      pruned.push(p);
    }
    console.log("  with exclude:   ", pruned.sort().slice(0, 6), "…");
    console.log(`
  exclude() is called per ENTRY NAME and prunes the subtree — so unlike
  recursive readdir, node_modules is never descended into. That's the
  difference between "fast" and "walks 40,000 files".

  No fast-glob dependency needed for ordinary patterns.
`);
  }

  console.log("=== 5. Walking it yourself, with pruning ===");
  {
    // The shape you'll write over and over: an async generator, lstat-based
    // (so symlinks don't send you in circles), with a prune predicate.
    async function* walk(
      root: string,
      opts: { skip?: (name: string) => boolean; maxDepth?: number } = {},
      depth = 0,
    ): AsyncGenerator<string> {
      const { skip = () => false, maxDepth = Infinity } = opts;
      if (depth > maxDepth) return;

      const entries = await readdir(root, { withFileTypes: true });
      for (const entry of entries) {
        if (skip(entry.name)) continue; // ← prune BEFORE descending
        const full = path.join(root, entry.name);
        if (entry.isDirectory()) {
          yield* walk(full, opts, depth + 1);
        } else if (entry.isFile()) {
          yield full;
        }
        // Symlinks fall through: neither yielded nor followed. Deliberate —
        // following them without cycle detection can loop forever.
      }
    }

    const out: string[] = [];
    for await (const f of walk(dir, { skip: (n) => n === "node_modules" })) {
      out.push(path.relative(dir, f));
    }
    console.log("  walk (pruned):", out.sort());

    const shallow: string[] = [];
    for await (const f of walk(dir, { skip: (n) => n === "node_modules", maxDepth: 1 })) {
      shallow.push(path.relative(dir, f));
    }
    console.log("  maxDepth 1:   ", shallow.sort());
    console.log(`
  Why a GENERATOR rather than returning an array: the caller can stop early
  (break), and memory stays flat on a million-file tree. You build a
  production version of this in the exercise.
`);
  }

  console.log("=== 6. opendir for very large directories ===");
  {
    const d = await opendir(path.join(dir, "src"));
    const names: string[] = [];
    // Streams one Dirent at a time instead of building the whole array.
    for await (const entry of d) names.push(entry.name);
    console.log("  opendir streamed:", names.sort());
    console.log(`
  readdir builds the entire array in memory first. opendir yields entries as
  it reads them. Worth switching past ~100k entries, or whenever you might
  break out early.
`);
  }

  console.log("=== 7. Symlinks in listings ===");
  {
    const linkPath = path.join(dir, "link-to-src");
    try {
      await symlink(path.join(dir, "src"), linkPath, "dir");
      const entries = await readdir(dir, { withFileTypes: true });
      const link = entries.find((e) => e.name === "link-to-src");
      console.log("  Dirent.isSymbolicLink():", link?.isSymbolicLink());
      console.log("  Dirent.isDirectory():   ", link?.isDirectory(), "← false, even though the TARGET is a dir");
      console.log("  stat() follows:         ", (await stat(linkPath)).isDirectory());
      console.log(`
  This is why a naive recursive walk can loop forever: create a symlink
  pointing at an ancestor and a stat()-based walker recurses until the stack
  blows. Use lstat/Dirent (which don't follow), or track visited inodes
  (stat().ino + .dev) if you deliberately want to follow links.
`);
    } catch {
      console.log("  (symlinks unavailable on this platform — Windows needs privileges)");
    }
  }

  console.log("=== 8. Cheat sheet ===");
  console.log(`
  readdir(p)                          string[] of names
  readdir(p, { withFileTypes: true }) Dirent[] — type info, no extra stat
  readdir(p, { recursive: true })     whole tree, but cannot prune
  opendir(p)                          streaming, for huge directories
  glob(pattern, { cwd, exclude })     pattern matching WITH pruning
  mkdir(p, { recursive: true })       idempotent "ensure it exists"
  rm(p, { recursive: true, force: true })  delete, don't care if missing
  cp(src, dst, { recursive: true })   copy a tree
`);
});
