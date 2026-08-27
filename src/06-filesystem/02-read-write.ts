/**
 * 02 — Reading, writing, flags, atomic writes, handles
 *
 * Run:  node src/06-filesystem/02-read-write.ts
 */

import { readFile, writeFile, appendFile, rename, rm, stat, open, mkdir } from "node:fs/promises";
import path from "node:path";
import { withTempDir, codeOf, isErrno } from "./_helpers.ts";

await withTempDir(async (dir) => {
  console.log("=== 1. Buffer vs string, and the URL form ===");
  {
    const p = path.join(dir, "hello.txt");
    await writeFile(p, "héllo");
    console.log("  readFile(p)         →", (await readFile(p)).constructor.name, `(${(await readFile(p)).length} bytes)`);
    console.log("  readFile(p, 'utf8') →", JSON.stringify(await readFile(p, "utf8")), `(${(await readFile(p, "utf8")).length} chars)`);
    // fs accepts a URL anywhere it accepts a path — handy with import.meta.url.
    console.log("  readFile(new URL(…)) works:", (await readFile(new URL(`file://${p}`), "utf8")) === "héllo");
    console.log(`
  6 bytes, 5 characters (module 04 §3.1). Size limits, Content-Length, and
  truncation logic all want BYTES. And note the string form has V8's ~512MB
  ceiling — the Buffer form does not.
`);
  }

  console.log("=== 2. Flags ===");
  {
    const p = path.join(dir, "flags.txt");
    await writeFile(p, "original");

    await writeFile(p, "replaced");
    console.log("  writeFile again (flag 'w') →", JSON.stringify(await readFile(p, "utf8")), "← TRUNCATED");

    await appendFile(p, "-more");
    console.log("  appendFile                 →", JSON.stringify(await readFile(p, "utf8")));

    console.log("  writeFile with flag 'wx'   →", await codeOf(() => writeFile(p, "x", { flag: "wx" })), "← fails because it exists");

    const fresh = path.join(dir, "new.txt");
    await writeFile(fresh, "created", { flag: "wx" });
    console.log("  'wx' on a new path         → ok");
  }

  console.log(`
  w    create or truncate  (writeFile's default)
  wx   create, EEXIST if it already exists
  a    append, create if missing
  ax   append, EEXIST if it exists
  r+   read/write, ENOENT if missing, does NOT truncate
`);

  console.log("=== 3. 'wx' is an atomic lock ===");
  {
    const lock = path.join(dir, "app.lock");

    // ✗ The racy version: another process can create the file between the
    //   check and the write. Two winners, both think they hold the lock.
    // if (!existsSync(lock)) await writeFile(lock, pid);

    // ✓ The OS decides. Exactly one caller can win.
    async function tryLock(): Promise<boolean> {
      try {
        await writeFile(lock, String(process.pid), { flag: "wx" });
        return true;
      } catch (err) {
        if (isErrno(err) && err.code === "EEXIST") return false;
        throw err;
      }
    }

    console.log("  first  tryLock():", await tryLock(), "✓");
    console.log("  second tryLock():", await tryLock(), "← correctly refused");
    await rm(lock);
    console.log("  after releasing: ", await tryLock(), "✓");
  }

  console.log("\n=== 4. writeFile is NOT atomic ===");
  {
    const target = path.join(dir, "state.json");
    await writeFile(target, JSON.stringify({ version: 1, data: "important" }));

    console.log(`
  writeFile TRUNCATES first, then writes. In that window the file is empty
  or partial. A crash, a full disk, or a concurrent reader mid-write leaves
  you with corrupted state — and it always happens to the config file, at
  3am, on the box you can't reach.
`);

    // The fix: write a temp file in the SAME directory, then rename.
    async function atomicWrite(t: string, data: string | Buffer): Promise<void> {
      const tmp = path.join(path.dirname(t), `.${path.basename(t)}.${process.pid}.tmp`);
      try {
        await writeFile(tmp, data, { mode: 0o600 });
        // rename() is atomic WITHIN a filesystem: readers see either the old
        // file or the new one, never a half-written one.
        await rename(tmp, t);
      } catch (err) {
        await rm(tmp, { force: true }); // don't litter on failure
        throw err;
      }
    }

    await atomicWrite(target, JSON.stringify({ version: 2, data: "safe" }));
    console.log("  after atomicWrite:", await readFile(target, "utf8"));
    console.log(`
  Two details that matter:

  • SAME DIRECTORY. rename is only atomic within one filesystem. Across
    devices it degrades to copy-then-delete and you get EXDEV — or, worse
    on some platforms, a torn write. /tmp is often a different filesystem,
    so never stage there and rename into place.

  • For crash durability you also need fsync on the file AND on its
    directory before the rename. Most apps don't need that; databases do.
`);
  }

  console.log("=== 5. File handles leak ===");
  {
    const p = path.join(dir, "handle.txt");
    await writeFile(p, "0123456789");

    // ✗ If anything between open and close throws, the fd is leaked for the
    //   life of the process. A few thousand of those and you hit EMFILE.
    // const h = await open(p, "r");
    // const data = await h.readFile();
    // await h.close();

    // ✓ try/finally
    const h = await open(p, "r");
    try {
      const buf = Buffer.alloc(4);
      // Positional read — the reason to use a handle at all.
      const { bytesRead } = await h.read(buf, 0, 4, 3);
      console.log(`  read ${bytesRead} bytes from offset 3:`, JSON.stringify(buf.toString()));
      console.log("  handle.stat().size:", (await h.stat()).size);
    } finally {
      await h.close();
    }

    console.log(`
  FileHandle already implements Symbol.asyncDispose, so on
  Node 24+ you can write:

      await using handle = await open(p, "r");   // closes at scope exit

  That syntax is NOT available in Node 22 — try/finally until you upgrade.

  Most of the time you don't need a handle at all: readFile/writeFile open
  and close for you. Reach for open() when you need positional reads, one fd
  shared across several operations, or 'wx' plus follow-up writes.
`);
  }

  console.log("=== 6. Modes and directories ===");
  {
    const p = path.join(dir, "secret.txt");
    await writeFile(p, "s3cret", { mode: 0o600 });
    console.log("  created with mode 0o600 →", ((await stat(p)).mode & 0o777).toString(8));
    console.log("  (mode is masked by the process umask, and ignored on Windows)");

    // mkdir recursive is the atomic "ensure it exists" — no EEXIST, no race.
    const nested = path.join(dir, "a/b/c");
    await mkdir(nested, { recursive: true });
    await mkdir(nested, { recursive: true }); // idempotent
    console.log("  mkdir recursive twice   → no error ✓");
    console.log("  mkdir non-recursive     →", await codeOf(() => mkdir(nested)));
  }

  console.log("\n=== 7. Common one-liners ===");
  console.log(`
  // Read JSON with a default when missing
  try { return JSON.parse(await readFile(p, "utf8")); }
  catch (err) { if (err.code === "ENOENT") return fallback; throw err; }

  // Append a log line (atomic per-line for small writes on POSIX)
  await appendFile(logPath, JSON.stringify(entry) + "\\n");

  // Copy a tree
  await cp(src, dst, { recursive: true });

  // Delete, don't care if missing
  await rm(p, { recursive: true, force: true });

  // Read a big file without loading it (module 05)
  await pipeline(createReadStream(p), transform, createWriteStream(out));
`);
});
