/**
 * SOLUTION 06 — reference implementation.
 */

import { copyFile, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  type AtomicWriteOptions,
  type CopyTreeOptions,
  FileTooLargeError,
  isErrno,
  PathEscapeError,
  type WalkOptions,
} from "./exercise.ts";

// --- Task 1 ------------------------------------------------------------------

export async function atomicWrite(
  target: string,
  data: string | Buffer,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const { mode = 0o600, signal } = options;
  const dir = path.dirname(target);

  // Idempotent and race-free — no "if (!exists) mkdir".
  await mkdir(dir, { recursive: true });

  // The temp file MUST live in the target's directory. rename() is only
  // atomic within one filesystem; staging in os.tmpdir() gives you EXDEV on
  // any box where /tmp is a separate mount (i.e. most containers).
  //
  // Random suffix, not just the PID: two async calls in ONE process would
  // otherwise collide and silently clobber each other.
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);

  try {
    await writeFile(tmp, data, { mode, signal });
    await rename(tmp, target);
  } catch (err) {
    // Clean up on EVERY failure path, including abort. force:true so a
    // failure before the file existed doesn't mask the real error.
    await rm(tmp, { force: true });
    throw err;
  }
}

// --- Task 2 ------------------------------------------------------------------

export async function* walk(root: string, options: WalkOptions = {}): AsyncGenerator<string> {
  const { skip = () => false, maxDepth = Infinity } = options;

  async function* recurse(dir: string, depth: number): AsyncGenerator<string> {
    let entries;
    try {
      // withFileTypes: no stat() per entry. Dirent also does NOT follow
      // symlinks, which is exactly what we want — a link pointing at an
      // ancestor reports isSymbolicLink(), not isDirectory(), so we can't
      // recurse into it and loop forever.
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      // An unreadable SUBdirectory shouldn't abort the whole walk — but a
      // bad root should surface, so only swallow below the top level.
      if (depth > 0 && isErrno(err) && (err.code === "EACCES" || err.code === "EPERM")) return;
      throw err;
    }

    // Deterministic output. readdir order is filesystem-dependent, which
    // makes tests flaky and diffs noisy.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const entry of entries) {
      if (skip(entry.name)) continue; // prune BEFORE descending

      const full = path.join(dir, entry.name);
      if (entry.isFile()) {
        yield full;
      } else if (entry.isDirectory() && depth < maxDepth) {
        yield* recurse(full, depth + 1);
      }
      // Symlinks: neither yielded nor followed.
    }
  }

  yield* recurse(root, 0);
}

// --- Task 3 ------------------------------------------------------------------

export async function safeResolve(base: string, userPath: string): Promise<string> {
  // Resolve the BASE too — it may itself sit behind a symlink (/tmp is a
  // link to /private/tmp on macOS), and comparing a real path against a
  // symlinked base would reject everything.
  const realBase = await realpath(base);
  const candidate = path.resolve(realBase, userPath);

  let real: string;
  try {
    real = await realpath(candidate);
  } catch (err) {
    if (!isErrno(err) || err.code !== "ENOENT") throw err;
    // The file doesn't exist yet (a write target). Resolve its PARENT
    // instead — that still catches the dangerous case, a symlinked parent
    // directory pointing outside the base.
    const parent = await realpath(path.dirname(candidate)).catch(() => {
      throw new PathEscapeError(`cannot resolve parent of ${userPath}`);
    });
    real = path.join(parent, path.basename(candidate));
  }

  const rel = path.relative(realBase, real);
  // rel === "" means the path IS the base — reject, since "" and "." are
  // never a legitimate file request.
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new PathEscapeError(`path escapes base: ${JSON.stringify(userPath)}`);
  }
  return real;
}

// --- Task 4 ------------------------------------------------------------------

export async function readJsonCapped<T>(file: string, maxBytes: number, fallback?: T): Promise<T> {
  let info;
  try {
    // stat FIRST. Reading then checking length would already have pulled a
    // 2GB file into memory — the check has to happen before the read.
    info = await stat(file);
  } catch (err) {
    if (isErrno(err) && err.code === "ENOENT" && fallback !== undefined) return fallback;
    throw err; // EACCES, EISDIR, … must NOT be swallowed as "missing"
  }

  // Apply the size cap only to actual FILES. A directory has a non-zero
  // st_size (4096 on ext4), so an unconditional check reports "too large"
  // for a directory — a confusing error that hides the real problem. Let
  // readFile below produce the genuine EISDIR instead.
  if (info.isFile() && info.size > maxBytes) {
    throw new FileTooLargeError(`${file} is ${info.size} bytes, limit is ${maxBytes}`);
  }

  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    // TOCTOU: the file could have been deleted between the stat and the read.
    if (isErrno(err) && err.code === "ENOENT" && fallback !== undefined) return fallback;
    throw err;
  }

  try {
    return JSON.parse(text) as T;
  } catch (err) {
    // Always name the file. "Unexpected token } in JSON at position 42" with
    // no filename is a miserable thing to debug.
    throw new SyntaxError(`Invalid JSON in ${file}: ${(err as Error).message}`, { cause: err });
  }
}

// --- Task 5 ------------------------------------------------------------------

export async function copyTree(src: string, dst: string, options: CopyTreeOptions = {}): Promise<number> {
  const { concurrency = 32, skip, signal } = options;

  const files: string[] = [];
  for await (const file of walk(src, skip ? { skip } : {})) {
    signal?.throwIfAborted();
    files.push(file);
  }

  let copied = 0;
  let next = 0;
  let failed = false;

  // Bounded workers pulling from a shared cursor — the mapLimit pattern from
  // module 02. Promise.all(files.map(copyFile)) would open every file at
  // once: EMFILE at scale, and it starves every other fs/net op in the
  // process because file descriptors are a PROCESS-wide resource.
  async function worker(): Promise<void> {
    for (;;) {
      if (failed) return;
      signal?.throwIfAborted();

      const i = next++;
      if (i >= files.length) return;

      const from = files[i] as string;
      const to = path.join(dst, path.relative(src, from));
      await mkdir(path.dirname(to), { recursive: true });
      await copyFile(from, to);
      copied += 1;
    }
  }

  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));
  } catch (err) {
    failed = true;
    throw err;
  }

  return copied;
}
