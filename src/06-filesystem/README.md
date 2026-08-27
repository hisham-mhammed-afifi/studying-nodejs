# 06 — Filesystem & Async Patterns

`fs` is the API you'll touch most often, and the one with the most sharp edges: three parallel APIs, a thread pool behind every call (module 02 §5), races that only show up under load, symlinks that defeat your security checks, and error codes you have to know by heart.

---

## 1. Three APIs, one default

```ts
import { readFile } from "node:fs/promises";      // ✓ promises — use this
import { readFile } from "node:fs";               //   callbacks — legacy
import { readFileSync } from "node:fs";           //   sync — startup only
```

```ts
// promises
const data = await readFile("a.txt", "utf8");

// callbacks
readFile("a.txt", "utf8", (err, data) => { if (err) throw err; });

// sync — BLOCKS THE EVENT LOOP
const data = readFileSync("a.txt", "utf8");
```

| API | Use when |
|---|---|
| `node:fs/promises` | **Everything.** Default choice. |
| `node:fs` callbacks | Interop with callback code; the tiny hot path where a promise allocation matters |
| `node:fs` sync | Process startup, CLI scripts, build tools — before you're serving traffic |
| `fs.createReadStream` | Files too large to hold in memory (module 05) |

### 1.1 Sync is a real trap

Every sync call blocks the **entire process**: no requests accepted, no responses written, no health checks answered (module 02 §6).

```ts
// ✗ in a request handler — 40ms of total process freeze per call
app.get("/config", (req, res) => res.json(JSON.parse(readFileSync("config.json", "utf8"))));

// ✓ startup only, once, before listen()
const config = JSON.parse(readFileSync("config.json", "utf8"));
app.get("/config", (req, res) => res.json(config));
```

Node can warn you about accidental sync I/O after the first tick:

```bash
node --trace-sync-io app.ts
```

`existsSync` deserves its own warning — see §5.2.

### 1.2 Async fs is not "free"

Every `fs` call runs on the **libuv thread pool** — 4 threads by default. Filesystem work is not kernel-async the way sockets are, so 100 concurrent `readFile`s queue 4 at a time, and they contend with `crypto.pbkdf2` and `dns.lookup` for the same threads (module 02 §5).

```bash
UV_THREADPOOL_SIZE=16 node app.ts   # must be set at LAUNCH, not in code
```

---

## 2. Reading and writing

```ts
await readFile(p);                    // Buffer
await readFile(p, "utf8");            // string  ⚠ ~512MB V8 ceiling
await readFile(new URL("./x", import.meta.url));   // URLs work everywhere

await writeFile(p, data);             // create or TRUNCATE
await writeFile(p, data, { mode: 0o600, flag: "wx" });
await appendFile(p, line);
```

### 2.1 Flags

| Flag | Meaning |
|---|---|
| `w` | create or truncate (the `writeFile` default) |
| `wx` | create, **fail with EEXIST if it exists** |
| `a` | append, create if missing |
| `ax` | append, fail if it exists |
| `r+` | read/write, fail if missing, don't truncate |

`wx` is how you claim a lock or a unique name **atomically** — no check-then-act race:

```ts
// ✗ racy: another process can create it between the two calls
if (!existsSync(lock)) await writeFile(lock, pid);

// ✓ atomic: the OS decides, exactly one winner
try {
  await writeFile(lock, String(process.pid), { flag: "wx" });
} catch (err) {
  if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new Error("already locked");
  throw err;
}
```

### 2.2 `writeFile` is not atomic

It truncates first, then writes. A crash, a full disk, or a concurrent reader mid-write leaves a **truncated or empty file**. For anything that matters — config, state, caches — write to a temp file in the *same directory* and `rename`:

```ts
async function atomicWrite(target: string, data: string | Buffer): Promise<void> {
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.tmp`);
  try {
    await writeFile(tmp, data, { mode: 0o600 });
    await rename(tmp, target);       // atomic on POSIX, near-atomic on Windows
  } catch (err) {
    await rm(tmp, { force: true });  // don't litter on failure
    throw err;
  }
}
```

Two details that matter:

- **Same directory**, because `rename` is only atomic *within a filesystem*. Across devices it becomes copy-then-delete, and you're back to a torn write (`EXDEV`).
- For crash-durability you also need `fsync` on the file *and* its directory before the rename. Most applications don't need this; databases do.

### 2.3 File handles leak

```ts
// ✗ if anything between open and close throws, the fd leaks forever
const handle = await open(p, "r");
const data = await handle.readFile();
await handle.close();

// ✓ try/finally
const handle = await open(p, "r");
try {
  const data = await handle.readFile();
} finally {
  await handle.close();
}
```

`FileHandle` implements `Symbol.asyncDispose`, so on **Node 24+** you can write:

```ts
await using handle = await open(p, "r");   // closes automatically at scope exit
```

That syntax is not available in Node 22 — `try`/`finally` until you upgrade.

Most of the time you don't need a handle at all: `readFile`/`writeFile` open and close for you. Reach for `open` when you need positional reads, a shared fd across operations, or `wx` semantics with follow-up writes.

---

## 3. Directories

```ts
await mkdir(p, { recursive: true });        // no EEXIST when it already exists
await readdir(p);                           // string[] of names — NOT paths
await readdir(p, { withFileTypes: true });  // Dirent[] — type info, no extra stat
await readdir(p, { recursive: true });      // walks subdirectories (Node 20.1+)
await rm(p, { recursive: true, force: true });
await cp(src, dst, { recursive: true });
```

### 3.1 `readdir` returns names, not paths

```ts
// ✗ these are bare names — "a.txt", not "/dir/a.txt"
for (const name of await readdir(dir)) await stat(name);   // ENOENT

// ✓
for (const name of await readdir(dir)) await stat(path.join(dir, name));
```

With `withFileTypes` each `Dirent` carries its own directory in `parentPath` (Node 21+; `dirent.path` in older versions):

```ts
for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
  const full = path.join(entry.parentPath, entry.name);
  if (entry.isFile()) console.log(full);
}
```

### 3.2 `withFileTypes` saves a syscall per entry

Without it you need a `stat` call per entry to know what anything is — on a directory with 10,000 files that's 10,000 extra round trips through the thread pool. `Dirent` gives you `isFile()`, `isDirectory()`, `isSymbolicLink()` for free, because `readdir` already knew.

⚠ One caveat: for a symlink, `Dirent.isFile()` is `false` and `isSymbolicLink()` is `true` — it does **not** follow. That's usually what you want, but it surprises people whose files are symlinks.

### 3.3 `opendir` for very large directories

`readdir` builds the whole array in memory. `opendir` streams:

```ts
const dir = await opendir(p);
for await (const entry of dir) {          // one Dirent at a time
  if (entry.isFile()) process(entry.name);
}
```

Use it past ~100k entries, or when you might exit early.

### 3.4 `glob` is built in (Node 22+)

```ts
import { glob } from "node:fs/promises";

for await (const file of glob("**/*.ts", { cwd: root, exclude: (n) => n === "node_modules" })) {
  console.log(file);   // paths relative to cwd
}
```

No `fast-glob` dependency needed for ordinary patterns.

---

## 4. Metadata

```ts
const s = await stat(p);       // follows symlinks
const s = await lstat(p);      // does NOT follow — describes the link itself

s.isFile(); s.isDirectory(); s.isSymbolicLink();
s.size;                        // bytes
s.mtime; s.mtimeMs;            // modified; also atime, ctime, birthtime
s.mode & 0o777;                // permission bits
s.ino; s.dev;                  // inode + device — identity, for dedupe/loop detection
```

`stat` vs `lstat` is the distinction that matters for anything walking a tree: use `lstat` so a symlink loop doesn't make you recurse forever.

---

## 5. Races, and why `existsSync` is a lie

### 5.1 TOCTOU

Every "check then act" has a window where reality changes:

```ts
// ✗ time-of-check to time-of-use race
if (existsSync(p)) {
  const data = await readFile(p);   // ← file may be gone. Or created. Or now a directory.
}
```

The file can be deleted, replaced, or swapped for a symlink between the two lines. Under load this *will* happen.

### 5.2 Just try it

```ts
// ✓ one atomic operation; handle the failure
try {
  const data = await readFile(p, "utf8");
  return JSON.parse(data);
} catch (err) {
  if ((err as NodeJS.ErrnoException).code === "ENOENT") return defaultConfig;
  throw err;
}
```

This is faster too — one syscall instead of two.

`access()` has the same problem and the docs say so explicitly: *"do not use `access` to check for accessibility before calling `open`, `readFile`, or `writeFile`."* The only legitimate use is diagnostics — "your config directory isn't writable" at startup, where a race is harmless.

### 5.3 Prefer atomic primitives

| Instead of | Use |
|---|---|
| `if (!exists) write` | `writeFile(p, d, { flag: "wx" })` |
| `if (exists) delete` | `rm(p, { force: true })` |
| `if (!exists) mkdir` | `mkdir(p, { recursive: true })` |
| `write config` | temp + `rename` (§2.2) |

---

## 6. Symlinks defeat naive path checks

Module 01 §5.2 gave you a string-level containment check. It is necessary but **not sufficient**:

```ts
// /srv/uploads/link.txt  →  /etc/passwd
const resolved = path.resolve(base, "link.txt");
path.relative(base, resolved);       // "link.txt" — looks contained ✓
await readFile(resolved);            // reads /etc/passwd ✗
```

The string never leaves the base directory; the *filesystem* does. For untrusted input you must resolve the real path:

```ts
async function safeResolve(base: string, userPath: string): Promise<string> {
  const realBase = await realpath(base);
  const candidate = path.resolve(realBase, userPath);

  // realpath throws ENOENT for files that don't exist yet, so fall back to
  // the nearest existing ancestor — you still catch a symlinked parent.
  let real: string;
  try {
    real = await realpath(candidate);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    real = path.join(await realpath(path.dirname(candidate)), path.basename(candidate));
  }

  const rel = path.relative(realBase, real);
  if (rel !== "" && (rel.startsWith("..") || path.isAbsolute(rel))) {
    throw new Error(`path escapes base: ${userPath}`);
  }
  return real;
}
```

Note this is still TOCTOU-vulnerable in principle — a symlink could be created between the check and the open. The airtight fix is opening with `O_NOFOLLOW` or using `openat` relative to a directory fd, which Node doesn't expose. For most applications, `realpath` + never serving from user-writable directories is the practical answer.

---

## 7. Cancellation with `AbortSignal`

Most `fs/promises` functions accept a signal:

```ts
await readFile(p, { signal });
await writeFile(p, data, { signal });
await cp(src, dst, { recursive: true, signal });
```

```ts
try {
  await readFile(huge, { signal: AbortSignal.timeout(5_000) });
} catch (err) {
  if ((err as Error).name === "AbortError") { /* … */ }
}
```

⚠ Aborting an in-flight `writeFile` does **not** roll it back — you're left with a partial file. Combine cancellation with the temp-file pattern (§2.2) so a cancelled write never becomes the real file.

The same signal composes across everything: `fetch`, streams (`pipeline(..., { signal })`), timers from `node:timers/promises`, and event listeners (module 03 §6.4). One `AbortController` per request tears down the lot.

---

## 8. Error codes

`fs` rejects with a `NodeJS.ErrnoException` carrying `.code`, `.errno`, `.syscall`, `.path`. **Always branch on `.code`, never on the message** — messages are localised and unstable.

| Code | Meaning | Common cause |
|---|---|---|
| `ENOENT` | no such file or directory | missing file, or a missing **parent** dir |
| `EEXIST` | already exists | `mkdir` without `recursive`, or `wx` |
| `EACCES` | permission denied | wrong user/mode |
| `EPERM` | operation not permitted | Windows read-only, or file locked |
| `EISDIR` | is a directory | `readFile` on a directory |
| `ENOTDIR` | not a directory | a path component is a file |
| `ENOTEMPTY` | directory not empty | `rmdir` without `recursive` |
| `EMFILE` | too many open files | fd leak, or unbounded concurrency |
| `ENOSPC` | no space left | full disk — or inode exhaustion |
| `EXDEV` | cross-device link | `rename` across filesystems |
| `EBUSY` | resource busy | Windows, file open elsewhere |

```ts
function isErrno(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

try {
  await readFile(p);
} catch (err) {
  if (!isErrno(err)) throw err;
  switch (err.code) {
    case "ENOENT": return null;
    case "EACCES": throw new Error(`Permission denied: ${err.path}`, { cause: err });
    default: throw err;
  }
}
```

---

## 9. Concurrency limits

`Promise.all` over a large file list opens every file at once:

```ts
// ✗ 50,000 concurrent opens → EMFILE, and it thrashes the thread pool
const contents = await Promise.all(files.map((f) => readFile(f)));

// ✓ bounded — this is mapLimit from module 02's exercise
const contents = await mapLimit(files, 64, (f) => readFile(f));
```

The limit that bites is the OS's per-process fd limit (`ulimit -n`; often 1024 on older Linux, 256 on macOS). Raising `UV_THREADPOOL_SIZE` does not help — the fds are the constraint, not the threads.

Signs you have an fd leak: `EMFILE` after hours of uptime, `lsof -p <pid> | wc -l` climbing, or `process.report.getReport().libuv` full of open handles.

---

## 10. Watching files

```ts
import { watch } from "node:fs/promises";

const ac = new AbortController();
for await (const event of watch(dir, { recursive: true, signal: ac.signal })) {
  console.log(event.eventType, event.filename);   // "rename" | "change"
}
```

`fs.watch` uses OS notifications (inotify / FSEvents / ReadDirectoryChangesW) and is efficient — but it is **genuinely unreliable in ways you must design around**:

- **Duplicate events.** One save often fires 2–4 times. Debounce.
- **`eventType` is nearly useless.** `"rename"` means created *or* deleted *or* renamed. Re-`stat` to find out what actually happened.
- **`filename` can be `null`** on some platforms.
- **`recursive` support varies** — solid on macOS and Windows, requires Linux ≥ 4.x with per-directory watches (and hits inotify limits on large trees).
- **Editors don't "save"** — many write a temp file and rename over the target, so you see a delete plus a create, not a change.
- **Network filesystems** (NFS, SMB, some Docker bind mounts) often deliver nothing at all. Fall back to polling with `watchFile` there.

Minimum viable debounce:

```ts
const pending = new Map<string, NodeJS.Timeout>();
for await (const event of watch(dir, { recursive: true, signal })) {
  if (!event.filename) continue;
  clearTimeout(pending.get(event.filename));
  pending.set(event.filename, setTimeout(() => {
    pending.delete(event.filename!);
    onStableChange(event.filename!);
  }, 50));
}
```

For anything user-facing, use `chokidar` — it exists because getting this right across platforms is genuinely hard.

---

## 11. Temp files

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const dir = await mkdtemp(path.join(tmpdir(), "myapp-"));
try {
  // ... work in `dir` ...
} finally {
  await rm(dir, { recursive: true, force: true });
}
```

`mkdtemp` creates the directory atomically with a random suffix — no name collision, no race. Never build a temp path yourself from `Math.random()` or a PID: that's a classic symlink-attack vector.

---

## 12. Files in this module

| File | What it demonstrates |
|---|---|
| `01-apis.ts` | promises vs callbacks vs sync, with loop-lag measured |
| `02-read-write.ts` | flags, atomic writes, handles, `appendFile`, modes |
| `03-directories.ts` | `readdir` variants, `Dirent`, `opendir`, `glob`, tree walking |
| `04-races.ts` | TOCTOU, `existsSync`, atomic alternatives, symlink escapes |
| `05-watching.ts` | `fs.watch`, duplicate events, debouncing, the caveats |
| `06-errors-limits.ts` | error codes in practice, unbounded vs bounded concurrency |
| `exercise.ts` | `atomicWrite`, a `walk` generator, `safeResolve`, `readJsonCapped`, `copyTree` |

```bash
node src/06-filesystem/index.ts        # all six demos
node scripts/test.ts 06                # test your exercise
node scripts/test.ts --solutions 06
```

---

## 13. Check yourself

1. Why is `readFileSync` in a request handler worse than a slow database query?
2. `if (existsSync(p)) await readFile(p)` — name two ways this fails.
3. Your service writes `state.json` every minute and occasionally reads back an empty file after a restart. What happened, and what's the fix?
4. `readdir` returns `["a.txt"]` and `stat("a.txt")` throws `ENOENT`. Why?
5. A user requests `uploads/report.pdf`. Your `path.relative` check passes. How can they still read `/etc/passwd`?
6. `Promise.all(files.map(readFile))` works in dev and throws `EMFILE` in production. What's the fix, and why doesn't `UV_THREADPOOL_SIZE` help?
7. Your file watcher fires three times per save. Why, and what do you do?
8. `rename` returns `EXDEV`. What does that mean for your atomic-write implementation?
