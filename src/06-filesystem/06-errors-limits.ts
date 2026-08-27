/**
 * 06 — Error codes, and concurrency limits
 *
 * Run:  node src/06-filesystem/06-errors-limits.ts
 */

import { readFile, writeFile, mkdir, rmdir, unlink, readdir, rename, open } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { withTempDir, codeOf, isErrno } from "./_helpers.ts";

await withTempDir(async (dir) => {
  console.log("=== 1. Error codes you will actually meet ===");
  {
    await mkdir(path.join(dir, "adir/child"), { recursive: true });
    await writeFile(path.join(dir, "afile.txt"), "x");

    const cases: Array<[string, () => Promise<unknown>]> = [
      ["readFile on a missing path", () => readFile(path.join(dir, "nope"))],
      ["readFile on a directory", () => readFile(path.join(dir, "adir"))],
      ["mkdir on an existing dir", () => mkdir(path.join(dir, "adir"))],
      ["rmdir on a non-empty dir", () => rmdir(path.join(dir, "adir"))],
      ["writeFile flag 'wx', exists", () => writeFile(path.join(dir, "afile.txt"), "y", { flag: "wx" })],
      ["unlink on a directory", () => unlink(path.join(dir, "adir"))],
      ["readdir on a file", () => readdir(path.join(dir, "afile.txt"))],
      ["writeFile into a missing dir", () => writeFile(path.join(dir, "gone/x.txt"), "y")],
    ];

    for (const [label, fn] of cases) {
      console.log(`  ${label.padEnd(32)} → ${await codeOf(fn)}`);
    }
  }

  console.log(`
  ENOENT     no such file OR DIRECTORY — note the last case: the FILE was
             fine, the missing thing was its parent directory.
  EEXIST     already exists (mkdir without recursive, or 'wx')
  EACCES     permission denied
  EPERM      operation not permitted (Windows read-only, locked file)
  EISDIR     it's a directory and you treated it as a file
  ENOTDIR    a path COMPONENT is a file, not a directory
  ENOTEMPTY  rmdir on a non-empty directory
  EMFILE     too many open files — fd leak, or unbounded concurrency
  ENOSPC     no space left (disk full, OR inodes exhausted, OR inotify watches)
  EXDEV      cross-device link — rename across filesystems
  EBUSY      resource busy (Windows: file open elsewhere)
`);

  console.log("=== 2. Branch on .code, never on the message ===");
  {
    const err = await readFile(path.join(dir, "missing")).catch((e: unknown) => e);
    if (isErrno(err)) {
      console.log("  code:   ", err.code);
      console.log("  errno:  ", err.errno);
      console.log("  syscall:", err.syscall);
      console.log("  path:   ", path.basename(err.path ?? ""));
      console.log("  message:", err.message);
    }
    console.log(`
  Messages are unstable across Node versions and can be localised by the OS.
  The .code string is the contract. Also note .path — always include it when
  you rewrap, because "ENOENT: no such file or directory" with no filename
  is the least useful error message in Node.

  A typed guard, since fs errors arrive as \`unknown\`:

      function isErrno(err: unknown): err is NodeJS.ErrnoException {
        return err instanceof Error && "code" in err;
      }
`);
  }

  console.log("=== 3. Handling patterns ===");
  console.log(`
  // Missing file → a default, everything else → rethrow
  try {
    return JSON.parse(await readFile(p, "utf8"));
  } catch (err) {
    if (isErrno(err) && err.code === "ENOENT") return defaults;
    throw err;                       // ← don't swallow EACCES as "missing"
  }

  // Rewrap with context, preserving the cause
  catch (err) {
    throw new Error(\`Failed to load config from \${p}\`, { cause: err });
  }

  // Retry only what's retryable
  const RETRYABLE = new Set(["EBUSY", "EMFILE", "ENFILE", "EAGAIN"]);
  if (isErrno(err) && RETRYABLE.has(err.code!)) return retryWithBackoff();
`);

  console.log("=== 4. EXDEV: the atomic-write trap ===");
  {
    const src = path.join(tmpdir(), `xdev-probe-${process.pid}`);
    await writeFile(src, "x");
    const code = await codeOf(() => rename(src, path.join(dir, "moved")));
    console.log(`  rename(os.tmpdir() → temp dir): ${code}`);
    console.log(`
  Here they're on the same filesystem, so it worked. In production /tmp is
  very often a separate mount (tmpfs, or a container's overlay), and you get
  EXDEV. That breaks the atomic-write pattern from 02-read-write.ts §4.

  → Always stage the temp file in the SAME DIRECTORY as the target, never
    in os.tmpdir(). That is the whole reason for the ".target.pid.tmp"
    naming convention.
`);
    await unlink(src).catch(() => {});
  }

  console.log("=== 5. Unbounded concurrency ===");
  {
    // Build a pile of files to read.
    const N = 2_000;
    const files: string[] = [];
    const filesDir = path.join(dir, "many");
    await mkdir(filesDir, { recursive: true });
    await Promise.all(
      Array.from({ length: N }, async (_, i) => {
        const p = path.join(filesDir, `f${i}.txt`);
        await writeFile(p, `content ${i}`);
        files.push(p);
      }),
    );

    // How many file descriptors are open right now?
    const openFds = () =>
      (process as unknown as { _getActiveHandles(): unknown[] })._getActiveHandles().length;

    console.log(`  ${N} files created. active handles: ${openFds()}`);

    // ✗ Promise.all opens every file at once.
    const t0 = performance.now();
    const all = await Promise.all(files.map((f) => readFile(f, "utf8")));
    console.log(`  Promise.all over ${N} files: ${(performance.now() - t0).toFixed(0)}ms, ${all.length} read`);

    // ✓ Bounded — this is mapLimit from module 02's exercise.
    async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
      const results = new Array<R>(items.length);
      let next = 0;
      async function worker() {
        for (;;) {
          const i = next++;
          if (i >= items.length) return;
          results[i] = await fn(items[i] as T);
        }
      }
      await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
      return results;
    }

    const t1 = performance.now();
    const bounded = await mapLimit(files, 64, (f) => readFile(f, "utf8"));
    console.log(`  mapLimit(64) over ${N} files: ${(performance.now() - t1).toFixed(0)}ms, ${bounded.length} read`);

    console.log(`
  Both finish, and at this scale the timings are similar. The difference is
  what happens at 50,000 files on a box with \`ulimit -n\` of 1024:

      Promise.all  → EMFILE, and every OTHER fs/net operation in the process
                     starts failing too, because fds are process-wide
      mapLimit(64) → completes

  ⚠ Raising UV_THREADPOOL_SIZE does NOT help. The pool limits how many reads
  run in parallel, but Promise.all has already OPENED all 50,000 fds — the
  constraint is file descriptors, not threads.

  Rule of thumb: any time you map an unbounded, externally-sized list to an
  fs or network call, bound the concurrency. 32-128 is usually right.
`);
  }

  console.log("=== 6. Finding an fd leak ===");
  {
    // Deliberately leak, then clean up — to show what the diagnostics see.
    const handles = await Promise.all(
      Array.from({ length: 10 }, () => open(path.join(dir, "afile.txt"), "r")),
    );
    const report = process.report?.getReport() as { libuv?: Array<{ type: string }> } | undefined;
    const fileHandles = report?.libuv?.filter((h) => h.type === "file").length ?? 0;
    console.log(`  10 handles held open. libuv 'file' handles in report: ${fileHandles}`);
    for (const h of handles) await h.close();
    console.log("  closed ✓");

    console.log(`
  Symptoms of a leak: EMFILE after hours of uptime, not at startup.

  Diagnostics:
    lsof -p <pid> | wc -l              open fds, live
    ls /proc/<pid>/fd | wc -l          same, Linux, no lsof needed
    ulimit -n                          the current limit
    process.report.getReport().libuv   from inside Node
    node --report-on-signal app.ts     then: kill -USR2 <pid>

  Cause is almost always an open() without a try/finally close(), or a
  stream that errored and was never destroyed (module 05 §5.1 — this is
  exactly what .pipe() leaks and pipeline() doesn't).
`);
  }
});
