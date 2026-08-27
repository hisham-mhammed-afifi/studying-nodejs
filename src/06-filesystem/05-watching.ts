/**
 * 05 — Watching files, and why it's harder than it looks
 *
 * Run:  node src/06-filesystem/05-watching.ts
 */

import { watch, writeFile, mkdir, rm, rename, stat } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { withTempDir, isErrno } from "./_helpers.ts";

await withTempDir(async (dir) => {
  console.log("=== 1. The basic loop ===");
  {
    const ac = new AbortController();
    const events: string[] = [];

    // fs.watch uses OS notifications: inotify (Linux), FSEvents (macOS),
    // ReadDirectoryChangesW (Windows). Cheap — no polling.
    const watching = (async () => {
      try {
        for await (const e of watch(dir, { signal: ac.signal })) {
          events.push(`${e.eventType}:${e.filename}`);
        }
      } catch (err) {
        if ((err as Error).name !== "AbortError") throw err;
      }
    })();

    await sleep(50); // let the watcher attach
    await writeFile(path.join(dir, "a.txt"), "one");
    await sleep(50);
    await writeFile(path.join(dir, "a.txt"), "two");
    await sleep(50);
    await rm(path.join(dir, "a.txt"));
    await sleep(100);

    ac.abort();
    await watching;

    console.log("  three operations produced", events.length, "events:");
    for (const e of events) console.log("   ", e);
    console.log(`
  Note the count. One create + one modify + one delete rarely produces
  exactly three events — you typically get duplicates, and eventType is
  "rename" for BOTH the create and the delete.
`);
  }

  console.log("=== 2. eventType tells you almost nothing ===");
  console.log(`
  You get exactly two values:

    "rename"  created, OR deleted, OR actually renamed
    "change"  contents or metadata changed

  So the event is a hint that SOMETHING happened to that name. To find out
  what, re-stat it:

      for await (const e of watch(dir, { signal })) {
        if (!e.filename) continue;
        const full = path.join(dir, e.filename);
        try {
          const s = await lstat(full);
          onCreatedOrChanged(full, s);
        } catch (err) {
          if (err.code === "ENOENT") onDeleted(full);
          else throw err;
        }
      }

  And 'filename' can be null on some platforms — always guard it.
`);

  console.log("=== 3. Editors don't 'save', they rename ===");
  {
    const ac = new AbortController();
    const events: string[] = [];
    const target = path.join(dir, "doc.txt");
    await writeFile(target, "v1");

    const watching = (async () => {
      try {
        for await (const e of watch(dir, { signal: ac.signal })) events.push(`${e.eventType}:${e.filename}`);
      } catch (err) {
        if ((err as Error).name !== "AbortError") throw err;
      }
    })();

    await sleep(50);
    // What vim, VS Code, and most editors actually do on save: write a temp
    // file, then rename it over the target. Atomic (good!) — but the watcher
    // sees a temp-file create plus a rename, NOT a "change" on doc.txt.
    const tmp = path.join(dir, ".doc.txt.swp");
    await writeFile(tmp, "v2");
    await rename(tmp, target);
    await sleep(100);

    ac.abort();
    await watching;

    console.log("  an editor-style atomic save produced:");
    for (const e of events) console.log("   ", e);
    console.log(`
  If you were watching the FILE (not its directory) with a single-file
  watcher, some platforms stop delivering events entirely after this,
  because the inode you were watching no longer exists at that name.

  → Watch the DIRECTORY, not the file. Then re-stat on every event.
`);
  }

  console.log("=== 4. Debouncing is mandatory ===");
  {
    const ac = new AbortController();
    let rawEvents = 0;
    const stableChanges: string[] = [];
    const pending = new Map<string, NodeJS.Timeout>();

    const watching = (async () => {
      try {
        for await (const e of watch(dir, { signal: ac.signal })) {
          rawEvents++;
          if (!e.filename) continue;
          const name = e.filename;
          clearTimeout(pending.get(name));
          pending.set(
            name,
            setTimeout(() => {
              pending.delete(name);
              stableChanges.push(name);
            }, 50),
          );
        }
      } catch (err) {
        if ((err as Error).name !== "AbortError") throw err;
      }
    })();

    await sleep(50);
    // Simulate a burst: a build tool rewriting one file several times.
    for (let i = 0; i < 5; i++) {
      await writeFile(path.join(dir, "burst.txt"), `v${i}`);
      await sleep(5);
    }
    await sleep(200);

    ac.abort();
    for (const t of pending.values()) clearTimeout(t);
    await watching;

    console.log(`  raw events: ${rawEvents}   →   debounced callbacks: ${stableChanges.length}`);
    console.log(`
  Without debouncing, a "rebuild on change" hook fires several times per
  save and you get overlapping builds. 50-100ms is a good window.

  A trailing-edge debounce per FILENAME (as above) is the minimum. If your
  handler is async, also guard against overlapping runs — otherwise a slow
  rebuild and the next change race each other.
`);
  }

  console.log("=== 5. recursive: the platform caveat ===");
  {
    await mkdir(path.join(dir, "nested/deep"), { recursive: true });
    const ac = new AbortController();
    const events: string[] = [];

    const watching = (async () => {
      try {
        for await (const e of watch(dir, { recursive: true, signal: ac.signal })) {
          events.push(`${e.eventType}:${e.filename}`);
        }
      } catch (err) {
        if (isErrno(err) && err.code === "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM") {
          console.log("  recursive watching not supported on this platform");
          return;
        }
        if ((err as Error).name !== "AbortError") throw err;
      }
    })();

    await sleep(50);
    await writeFile(path.join(dir, "nested/deep/x.txt"), "hi");
    await sleep(150);
    ac.abort();
    await watching;

    console.log("  events from a nested write:", events.length > 0 ? events : "(none)");
    console.log(`
  recursive: true is solid on macOS and Windows. On Linux it's implemented by
  registering an inotify watch per DIRECTORY, which means:
    • it can be slow to set up on a large tree,
    • it consumes one inotify watch per directory, and
      /proc/sys/fs/inotify/max_user_watches defaults to ~8192 —
      the classic "ENOSPC when watching node_modules" error, which is NOT
      about disk space at all.
`);
  }

  console.log("=== 6. The full list of caveats ===");
  console.log(`
  • Duplicate events. One save often fires 2-4 times. Debounce.
  • eventType is "rename" | "change" — nearly useless. Re-stat.
  • filename can be null on some platforms.
  • Editors rename over files, so watch the DIRECTORY, not the file.
  • recursive costs one inotify watch per directory on Linux; you can hit
    max_user_watches and get ENOSPC.
  • Network filesystems (NFS, SMB, some Docker bind mounts, WSL2 crossing
    the /mnt boundary) often deliver NOTHING. Fall back to polling:
        watchFile(p, { interval: 1000 }, (curr, prev) => { ... });
  • Events can be missed entirely under heavy churn. If correctness matters,
    treat the watcher as a HINT and reconcile against real state.

  For anything user-facing, use chokidar. It exists because getting all of
  the above right on every platform is genuinely hard — but now you know
  what it's actually doing for you.
`);

  // Prove watchFile/stat-based polling still works, as the fallback.
  {
    const p = path.join(dir, "polled.txt");
    await writeFile(p, "a");
    const before = (await stat(p)).mtimeMs;
    await sleep(10);
    await writeFile(p, "bb");
    const after = (await stat(p)).mtimeMs;
    console.log("=== 7. The polling fallback ===");
    console.log("  mtime changed:", after !== before, "| size:", (await stat(p)).size);
    console.log(`
  watchFile(p, { interval }) polls stat() on a timer. Slower and noisier,
  but it works EVERYWHERE — including the network filesystems where fs.watch
  silently delivers nothing.
`);
  }
});
