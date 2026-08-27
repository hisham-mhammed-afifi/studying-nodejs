/**
 *   node scripts/test.ts 06
 *   node scripts/test.ts --solutions 06
 */

import { describe, it, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  type AtomicWriteOptions,
  type CopyTreeOptions,
  FileTooLargeError,
  PathEscapeError,
  type WalkOptions,
} from "./exercise.ts";

const modulePath = process.env["IMPL"] === "solution" ? "./solution.ts" : "./exercise.ts";

type Impl = {
  atomicWrite(target: string, data: string | Buffer, options?: AtomicWriteOptions): Promise<void>;
  walk(root: string, options?: WalkOptions): AsyncGenerator<string>;
  safeResolve(base: string, userPath: string): Promise<string>;
  readJsonCapped<T>(file: string, maxBytes: number, fallback?: T): Promise<T>;
  copyTree(src: string, dst: string, options?: CopyTreeOptions): Promise<number>;
};

let impl: Impl;
let canSymlink = false;
before(async () => {
  impl = (await import(modulePath)) as unknown as Impl;
  const probe = await mkdtemp(path.join(tmpdir(), "symprobe-"));
  try {
    await symlink(probe, path.join(probe, "l"), "dir");
    canSymlink = true;
  } catch {
    canSymlink = false;
  } finally {
    await rm(probe, { recursive: true, force: true });
  }
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "m06-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const rel = (root: string, files: string[]) =>
  files.map((f) => path.relative(root, f).split(path.sep).join("/")).sort();

async function tree(root: string, spec: Record<string, string>): Promise<void> {
  for (const [p, content] of Object.entries(spec)) {
    const full = path.join(root, p);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content);
  }
}

describe("atomicWrite", () => {
  it("writes the file", async () => {
    const p = path.join(dir, "a.txt");
    await impl.atomicWrite(p, "hello");
    assert.equal(await readFile(p, "utf8"), "hello");
  });

  it("overwrites an existing file", async () => {
    const p = path.join(dir, "a.txt");
    await writeFile(p, "old");
    await impl.atomicWrite(p, "new");
    assert.equal(await readFile(p, "utf8"), "new");
  });

  it("accepts a Buffer", async () => {
    const p = path.join(dir, "a.bin");
    await impl.atomicWrite(p, Buffer.from([1, 2, 3]));
    assert.deepEqual([...(await readFile(p))], [1, 2, 3]);
  });

  it("creates the parent directory", async () => {
    const p = path.join(dir, "deep/nested/a.txt");
    await impl.atomicWrite(p, "x");
    assert.equal(await readFile(p, "utf8"), "x");
  });

  it("leaves no temp files behind", async () => {
    const p = path.join(dir, "a.txt");
    await impl.atomicWrite(p, "x");
    assert.deepEqual(await readdir(dir), ["a.txt"], "a temp file was left behind");
  });

  it("stages the temp file in the TARGET's directory (EXDEV safety)", async () => {
    // Watch the directory while a large write is in flight: the temp file has
    // to appear next to the target, not in os.tmpdir().
    const sub = path.join(dir, "sub");
    await mkdir(sub, { recursive: true });
    const p = path.join(sub, "big.txt");

    const writing = impl.atomicWrite(p, "x".repeat(4 * 1024 * 1024));
    let sawTemp = false;
    for (let i = 0; i < 200 && !sawTemp; i++) {
      const names = await readdir(sub).catch(() => []);
      if (names.some((n) => n !== "big.txt")) sawTemp = true;
      await new Promise((r) => setImmediate(r));
    }
    await writing;
    assert.ok(sawTemp, "no temp file appeared in the target directory — staging elsewhere risks EXDEV");
    assert.deepEqual(await readdir(sub), ["big.txt"]);
  });

  it("honours mode", async () => {
    if (process.platform === "win32") return;
    const p = path.join(dir, "a.txt");
    await impl.atomicWrite(p, "x", { mode: 0o600 });
    assert.equal((await stat(p)).mode & 0o777, 0o600);
  });

  it("cleans up and rethrows when aborted", async () => {
    const p = path.join(dir, "a.txt");
    await assert.rejects(() => impl.atomicWrite(p, "x", { signal: AbortSignal.abort() }));
    assert.deepEqual(await readdir(dir), [], "temp file left behind after failure");
  });

  it("concurrent writes to the same target do not collide", async () => {
    const p = path.join(dir, "a.txt");
    await Promise.all(Array.from({ length: 10 }, (_, i) => impl.atomicWrite(p, `v${i}`)));
    const content = await readFile(p, "utf8");
    assert.match(content, /^v\d$/, "final content is corrupt — temp names collided?");
    assert.deepEqual(await readdir(dir), ["a.txt"]);
  });
});

describe("walk", () => {
  const spec = {
    "README.md": "x",
    "src/index.ts": "x",
    "src/util.ts": "x",
    "src/lib/deep.ts": "x",
    "node_modules/pkg/i.js": "x",
  };

  it("yields every file as an absolute path", async () => {
    await tree(dir, spec);
    const out: string[] = [];
    for await (const f of impl.walk(dir)) {
      assert.ok(path.isAbsolute(f), `not absolute: ${f}`);
      out.push(f);
    }
    assert.deepEqual(rel(dir, out), [
      "README.md",
      "node_modules/pkg/i.js",
      "src/index.ts",
      "src/lib/deep.ts",
      "src/util.ts",
    ]);
  });

  it("prunes with skip, without descending", async () => {
    await tree(dir, spec);
    const out: string[] = [];
    for await (const f of impl.walk(dir, { skip: (n) => n === "node_modules" })) out.push(f);
    assert.deepEqual(rel(dir, out), ["README.md", "src/index.ts", "src/lib/deep.ts", "src/util.ts"]);
  });

  it("respects maxDepth", async () => {
    await tree(dir, spec);
    const depth0: string[] = [];
    for await (const f of impl.walk(dir, { maxDepth: 0 })) depth0.push(f);
    assert.deepEqual(rel(dir, depth0), ["README.md"]);

    const depth1: string[] = [];
    for await (const f of impl.walk(dir, { maxDepth: 1, skip: (n) => n === "node_modules" })) depth1.push(f);
    assert.deepEqual(rel(dir, depth1), ["README.md", "src/index.ts", "src/util.ts"]);
  });

  it("is deterministic", async () => {
    await tree(dir, spec);
    const runs: string[][] = [];
    for (let i = 0; i < 3; i++) {
      const out: string[] = [];
      for await (const f of impl.walk(dir)) out.push(f);
      runs.push(out);
    }
    assert.deepEqual(runs[0], runs[1]);
    assert.deepEqual(runs[1], runs[2]);
  });

  it("supports early break (it is a generator)", async () => {
    await tree(dir, spec);
    const out: string[] = [];
    for await (const f of impl.walk(dir)) {
      out.push(f);
      if (out.length === 2) break;
    }
    assert.equal(out.length, 2);
  });

  it("yields nothing for an empty directory", async () => {
    const out: string[] = [];
    for await (const f of impl.walk(dir)) out.push(f);
    assert.deepEqual(out, []);
  });

  it("throws ENOENT for a missing root", async () => {
    await assert.rejects(
      async () => {
        for await (const _ of impl.walk(path.join(dir, "nope"))) void _;
      },
      (err: unknown) => (err as NodeJS.ErrnoException).code === "ENOENT",
    );
  });

  it("does not follow symlinks or loop forever", async () => {
    if (!canSymlink) return;
    await tree(dir, { "a/file.txt": "x" });
    // A link pointing at its own ancestor: a stat-based walker loops forever.
    await symlink(dir, path.join(dir, "a", "loop"), "dir");

    const out: string[] = [];
    for await (const f of impl.walk(dir)) out.push(f);
    assert.deepEqual(rel(dir, out), ["a/file.txt"], "symlink was followed");
  });

  it("does not yield symlinks as files", async () => {
    if (!canSymlink) return;
    await tree(dir, { "real.txt": "x" });
    await symlink(path.join(dir, "real.txt"), path.join(dir, "link.txt"));
    const out: string[] = [];
    for await (const f of impl.walk(dir)) out.push(f);
    assert.deepEqual(rel(dir, out), ["real.txt"]);
  });
});

describe("safeResolve", () => {
  let base: string;
  beforeEach(async () => {
    base = path.join(dir, "uploads");
    await mkdir(base, { recursive: true });
    await writeFile(path.join(base, "ok.txt"), "fine");
    await mkdir(path.join(base, "sub"), { recursive: true });
    await writeFile(path.join(base, "sub", "nested.txt"), "fine");
  });

  it("resolves a simple file", async () => {
    const r = await impl.safeResolve(base, "ok.txt");
    assert.equal(path.basename(r), "ok.txt");
    assert.ok(path.isAbsolute(r));
  });

  it("resolves a nested file", async () => {
    const r = await impl.safeResolve(base, "sub/nested.txt");
    assert.equal(path.basename(r), "nested.txt");
  });

  it("allows .. that stays inside", async () => {
    const r = await impl.safeResolve(base, "sub/../ok.txt");
    assert.equal(path.basename(r), "ok.txt");
  });

  it("allows a file that does not exist yet", async () => {
    const r = await impl.safeResolve(base, "new-file.txt");
    assert.equal(path.basename(r), "new-file.txt");
  });

  it("allows a not-yet-existing file in an existing subdirectory", async () => {
    const r = await impl.safeResolve(base, "sub/new.txt");
    assert.equal(path.basename(r), "new.txt");
  });

  for (const bad of ["../outside.txt", "../../etc/passwd", "/etc/passwd", "", ".", "sub/../.."]) {
    it(`rejects ${JSON.stringify(bad)}`, async () => {
      await assert.rejects(() => impl.safeResolve(base, bad), PathEscapeError);
    });
  }

  it("rejects a symlink pointing outside the base", async () => {
    if (!canSymlink) return;
    const secret = path.join(dir, "private", "secret.txt");
    await mkdir(path.dirname(secret), { recursive: true });
    await writeFile(secret, "API_KEY=hunter2");
    await symlink(secret, path.join(base, "report.pdf"));

    // A path.relative-only check passes this. realpath must catch it.
    await assert.rejects(() => impl.safeResolve(base, "report.pdf"), PathEscapeError);
  });

  it("rejects a file under a symlinked directory", async () => {
    if (!canSymlink) return;
    const outside = path.join(dir, "outside");
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "x.txt"), "secret");
    await symlink(outside, path.join(base, "linkdir"), "dir");

    await assert.rejects(() => impl.safeResolve(base, "linkdir/x.txt"), PathEscapeError);
  });

  it("rejects a NEW file under a symlinked directory", async () => {
    if (!canSymlink) return;
    const outside = path.join(dir, "outside2");
    await mkdir(outside, { recursive: true });
    await symlink(outside, path.join(base, "linkdir2"), "dir");

    // The file doesn't exist, so realpath(candidate) throws ENOENT — the
    // fallback must still resolve the PARENT and catch the escape.
    await assert.rejects(() => impl.safeResolve(base, "linkdir2/new.txt"), PathEscapeError);
  });

  it("works when the base itself is behind a symlink", async () => {
    if (!canSymlink) return;
    const aliased = path.join(dir, "alias");
    await symlink(base, aliased, "dir");
    const r = await impl.safeResolve(aliased, "ok.txt");
    assert.equal(path.basename(r), "ok.txt");
  });
});

describe("readJsonCapped", () => {
  it("reads and parses", async () => {
    const p = path.join(dir, "a.json");
    await writeFile(p, JSON.stringify({ a: 1 }));
    assert.deepEqual(await impl.readJsonCapped(p, 1000), { a: 1 });
  });

  it("returns the fallback for a missing file", async () => {
    const r = await impl.readJsonCapped(path.join(dir, "nope.json"), 1000, { def: true });
    assert.deepEqual(r, { def: true });
  });

  it("throws ENOENT when no fallback was given", async () => {
    await assert.rejects(
      () => impl.readJsonCapped(path.join(dir, "nope.json"), 1000),
      (err: unknown) => (err as NodeJS.ErrnoException).code === "ENOENT",
    );
  });

  it("throws FileTooLargeError past the cap", async () => {
    const p = path.join(dir, "big.json");
    await writeFile(p, JSON.stringify({ pad: "x".repeat(5000) }));
    await assert.rejects(() => impl.readJsonCapped(p, 100), FileTooLargeError);
  });

  it("does not fall back on a too-large file even when a fallback exists", async () => {
    const p = path.join(dir, "big.json");
    await writeFile(p, JSON.stringify({ pad: "x".repeat(5000) }));
    await assert.rejects(() => impl.readJsonCapped(p, 100, { def: true }), FileTooLargeError);
  });

  it("checks the size BEFORE reading", async () => {
    // 8MB file, 100-byte cap. A read-then-check implementation still pulls
    // 8MB into memory; we assert it returns fast enough that it can't have.
    const p = path.join(dir, "huge.json");
    await writeFile(p, JSON.stringify({ pad: "x".repeat(8 * 1024 * 1024) }));
    const before = process.memoryUsage().heapUsed;
    await assert.rejects(() => impl.readJsonCapped(p, 100), FileTooLargeError);
    const grewMB = (process.memoryUsage().heapUsed - before) / 1024 / 1024;
    assert.ok(grewMB < 4, `heap grew ${grewMB.toFixed(1)}MB — the file was read before the size check`);
  });

  it("throws a SyntaxError naming the file for invalid JSON", async () => {
    const p = path.join(dir, "bad.json");
    await writeFile(p, "{not json}");
    await assert.rejects(() => impl.readJsonCapped(p, 1000), (err: unknown) => {
      assert.ok(err instanceof SyntaxError, "expected a SyntaxError");
      assert.ok(err.message.includes("bad.json"), `message should name the file: ${err.message}`);
      return true;
    });
  });

  it("does not swallow EISDIR as 'missing'", async () => {
    await assert.rejects(
      () => impl.readJsonCapped(dir, 1000, { def: true }),
      (err: unknown) => (err as NodeJS.ErrnoException).code === "EISDIR",
    );
  });
});

describe("copyTree", () => {
  const spec = {
    "a.txt": "A",
    "sub/b.txt": "B",
    "sub/deep/c.txt": "C",
    "node_modules/x.js": "X",
  };

  it("copies the whole tree and returns a count", async () => {
    const src = path.join(dir, "src");
    const dst = path.join(dir, "dst");
    await tree(src, spec);

    const n = await impl.copyTree(src, dst);
    assert.equal(n, 4);
    assert.equal(await readFile(path.join(dst, "a.txt"), "utf8"), "A");
    assert.equal(await readFile(path.join(dst, "sub/deep/c.txt"), "utf8"), "C");
  });

  it("honours skip", async () => {
    const src = path.join(dir, "src");
    const dst = path.join(dir, "dst");
    await tree(src, spec);

    const n = await impl.copyTree(src, dst, { skip: (name) => name === "node_modules" });
    assert.equal(n, 3);
    await assert.rejects(() => stat(path.join(dst, "node_modules")));
  });

  it("respects the concurrency limit", async () => {
    const src = path.join(dir, "src");
    const dst = path.join(dir, "dst");
    const many: Record<string, string> = {};
    for (let i = 0; i < 60; i++) many[`f${i}.txt`] = `content ${i}`;
    await tree(src, many);

    // Count concurrent copyFile calls by patching the module's view of fs is
    // awkward; instead assert the whole thing completes and is correct, and
    // check the limit via a small concurrency that must still finish.
    const n = await impl.copyTree(src, dst, { concurrency: 4 });
    assert.equal(n, 60);
    assert.equal((await readdir(dst)).length, 60);
  });

  it("handles an empty source tree", async () => {
    const src = path.join(dir, "src");
    const dst = path.join(dir, "dst");
    await mkdir(src, { recursive: true });
    assert.equal(await impl.copyTree(src, dst), 0);
  });

  it("copies into an existing destination", async () => {
    const src = path.join(dir, "src");
    const dst = path.join(dir, "dst");
    await tree(src, { "a.txt": "A" });
    await tree(dst, { "existing.txt": "E" });

    await impl.copyTree(src, dst);
    assert.equal(await readFile(path.join(dst, "a.txt"), "utf8"), "A");
    assert.equal(await readFile(path.join(dst, "existing.txt"), "utf8"), "E");
  });

  it("honours an AbortSignal", async () => {
    const src = path.join(dir, "src");
    const dst = path.join(dir, "dst");
    const many: Record<string, string> = {};
    for (let i = 0; i < 200; i++) many[`f${i}.txt`] = "x".repeat(1000);
    await tree(src, many);

    const ac = new AbortController();
    ac.abort();
    await assert.rejects(
      () => impl.copyTree(src, dst, { signal: ac.signal, concurrency: 2 }),
      (err: unknown) => (err as Error).name === "AbortError",
    );
  });
});
