/**
 * EXERCISE 06 — A safe filesystem toolkit
 *
 * Five utilities you will reuse in every project, each teaching one hazard
 * from this module.
 *
 * Check yourself:  node scripts/test.ts 06
 * Solution:        ./solution.ts   (try first!)
 */

const TODO = (what: string): never => {
  throw new Error(`TODO: implement ${what}`);
};

export class PathEscapeError extends Error {
  override readonly name = "PathEscapeError";
}

export class FileTooLargeError extends Error {
  override readonly name = "FileTooLargeError";
}

/** Narrow `unknown` to a Node errno error, so `.code` is typed. */
export function isErrno(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

/**
 * TASK 1 — `atomicWrite`
 *
 * Write `data` to `target` so a reader NEVER sees a partial file.
 *
 * Requirements:
 *   - Write a temp file, then `rename` it over the target.
 *   - The temp file MUST be in the same directory as the target — `rename`
 *     is only atomic within one filesystem, and os.tmpdir() is frequently a
 *     different mount (→ EXDEV).
 *   - Use a name that can't collide with a concurrent call.
 *   - On ANY failure, remove the temp file and rethrow. No litter.
 *   - Create the parent directory if it's missing.
 *   - Honour `mode` (default 0o600) and `signal`.
 */
export interface AtomicWriteOptions {
  mode?: number;
  signal?: AbortSignal;
}

export function atomicWrite(
  _target: string,
  _data: string | Buffer,
  _options?: AtomicWriteOptions,
): Promise<void> {
  return TODO("atomicWrite");
}

/**
 * TASK 2 — `walk`
 *
 * An async generator over every FILE under `root`, as absolute paths.
 *
 * Requirements:
 *   - A GENERATOR, so callers can `break` early and memory stays flat.
 *   - `skip(name)` prunes a subtree BEFORE descending into it — that's the
 *     difference between fast and "walked all of node_modules".
 *   - `maxDepth`: 0 = only files directly in `root`. Default Infinity.
 *   - Does NOT follow symlinks (use Dirent / lstat semantics). A symlink
 *     pointing at an ancestor must not cause infinite recursion.
 *   - Yields files only, never directories or symlinks.
 *   - A missing `root` throws ENOENT; an unreadable SUBdirectory is skipped
 *     (EACCES) rather than aborting the whole walk.
 *   - Deterministic order: sort entries by name within each directory.
 */
export interface WalkOptions {
  skip?: (name: string) => boolean;
  maxDepth?: number;
}

export function walk(_root: string, _options?: WalkOptions): AsyncGenerator<string> {
  return TODO("walk");
}

/**
 * TASK 3 — `safeResolve`
 *
 * Resolve `userPath` inside `base`, defeating BOTH `../` traversal and
 * symlink escapes (see 04-races.ts §5).
 *
 * Requirements:
 *   - Returns an absolute, real path inside `base`.
 *   - Rejects `..` escapes, absolute paths, and symlinks pointing outside.
 *   - Must work for files that don't exist yet — `realpath` throws ENOENT
 *     for those, so fall back to the nearest existing ancestor. A symlinked
 *     PARENT must still be caught.
 *   - Rejects `""` and `"."` (they resolve to `base` itself).
 *   - Throws PathEscapeError on any escape.
 */
export function safeResolve(_base: string, _userPath: string): Promise<string> {
  return TODO("safeResolve");
}

/**
 * TASK 4 — `readJsonCapped`
 *
 * Read and parse a JSON file, refusing to load more than `maxBytes`.
 *
 * Requirements:
 *   - Check the SIZE FIRST (stat) so a 2GB file is never read into memory.
 *   - Throw FileTooLargeError when it's too big.
 *   - Return `fallback` on ENOENT — but only if a fallback was given;
 *     otherwise let ENOENT propagate.
 *   - Do NOT swallow other errno errors (EACCES must still throw).
 *   - Invalid JSON throws a SyntaxError mentioning the path.
 *   - ⚠ Apply the cap only to actual FILES. A directory reports a non-zero
 *     size (4096 on ext4), so an unconditional size check reports "too large"
 *     for a directory instead of the real EISDIR.
 */
export function readJsonCapped<T>(_file: string, _maxBytes: number, _fallback?: T): Promise<T> {
  return TODO("readJsonCapped");
}

/**
 * TASK 5 — `copyTree`
 *
 * Copy every file from `src` into `dst`, with BOUNDED concurrency.
 *
 * Requirements:
 *   - Preserves the directory structure.
 *   - At most `concurrency` copies in flight (default 32). An unbounded
 *     Promise.all over 50k files is an EMFILE waiting to happen.
 *   - Creates destination directories as needed.
 *   - Honours `skip` (same semantics as `walk`).
 *   - Returns the number of files copied.
 *   - Honours `signal`: aborting stops starting new copies and rejects.
 *
 * Build it on `walk`. Yes, `fs.cp({ recursive: true })` exists — the point
 * is the concurrency control it doesn't give you.
 */
export interface CopyTreeOptions {
  concurrency?: number;
  skip?: (name: string) => boolean;
  signal?: AbortSignal;
}

export function copyTree(_src: string, _dst: string, _options?: CopyTreeOptions): Promise<number> {
  return TODO("copyTree");
}
