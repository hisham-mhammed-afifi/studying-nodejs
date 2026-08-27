/**
 * 01 — node:sqlite: a real database, no install
 *
 * Run:  node src/13-persistence/01-basics.ts
 */

import { DatabaseSync } from "node:sqlite";
import { memoryDb, withFileDb } from "./_helpers.ts";

console.log("=== 1. It's built in ===");
console.log(`
  import { DatabaseSync } from "node:sqlite";

  No npm install. No node-gyp, no Python, no prebuilt binaries per platform,
  no "npm rebuild" after a Node upgrade. It is compiled into the binary.

  ⚠ It prints "ExperimentalWarning: SQLite is an experimental feature", so
  the API may still move. The CONCEPTS below — SQL, binding, transactions,
  indexes — transfer to any database; only the method names might change.

  Silence it while you learn:  node --no-warnings your-file.ts
`);

console.log("=== 2. The whole API, in one screen ===");
{
  const db = memoryDb();

  // exec: run SQL, return nothing. For DDL and multi-statement scripts.
  db.exec(`
    CREATE TABLE users (
      id         INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      email      TEXT UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // prepare: compile once, reuse. See §4 for why that matters.
  const insert = db.prepare("INSERT INTO users (name, email) VALUES (?, ?)");

  const result = insert.run("ada", "ada@example.com");
  console.log("  run()  →", result, "← lastInsertRowid + changes");

  insert.run("grace", "grace@example.com");
  insert.run("alan", null); // email is nullable

  const byId = db.prepare("SELECT id, name, email FROM users WHERE id = ?");
  console.log("  get()  →", byId.get(1), "← one row, or undefined");
  console.log("  get() miss →", byId.get(999));

  const all = db.prepare("SELECT id, name FROM users ORDER BY id").all();
  console.log("  all()  →", all);

  const updated = db.prepare("UPDATE users SET name = ? WHERE id = ?").run("Ada L", 1);
  console.log("  update →", updated, "← changes tells you if it matched");

  const deleted = db.prepare("DELETE FROM users WHERE id = ?").run(999);
  console.log("  delete miss →", deleted, "← changes: 0, NOT an error");

  db.close();

  console.log(`
  That is essentially the whole surface:

      db.exec(sql)              run SQL, no results, no parameters
      db.prepare(sql)           compile a statement
      stmt.run(...params)       → { changes, lastInsertRowid }
      stmt.get(...params)       → one row, or undefined
      stmt.all(...params)       → an array of rows
      stmt.iterate(...params)   → an iterator, for large result sets
      db.close()

  Note that a DELETE matching nothing is NOT an error — changes: 0. If
  "not found" matters, check it and turn it into your own 404.
`);
}

console.log("=== 3. ⚠ It is SYNCHRONOUS ===");
{
  const db = memoryDb();
  db.exec("CREATE TABLE t (v INTEGER)");
  db.exec("BEGIN");
  const ins = db.prepare("INSERT INTO t VALUES (?)");
  for (let i = 0; i < 200_000; i++) ins.run(i);
  db.exec("COMMIT");

  // Measure how long the loop is blocked by one deliberately bad query.
  let maxLag = 0;
  let expected = performance.now() + 10;
  const monitor = setInterval(() => {
    const now = performance.now();
    maxLag = Math.max(maxLag, now - expected);
    expected = now + 10;
  }, 10);
  monitor.unref();

  const t0 = performance.now();
  // No index on v, so this is a full scan of 200k rows.
  const row = db.prepare("SELECT COUNT(*) c FROM t WHERE v % 7 = 0").get();
  const queryMs = performance.now() - t0;

  await new Promise((r) => setTimeout(r, 40)); // let the monitor sample
  clearInterval(monitor);

  console.log(`  full scan of 200k rows: ${queryMs.toFixed(0)}ms, result ${JSON.stringify(row)}`);
  console.log(`  max event-loop lag during it: ${maxLag.toFixed(0)}ms`);
  console.log(`
  The class name says it: DatabaseSync. Every call blocks the event loop
  (module 02 §6) — no other requests, no timers, no health checks.

  But look at the number. I went looking for a query slow enough to make
  that visible and struggled: a full scan of 200k rows, an unindexed LIKE,
  an unindexed ORDER BY and a 40k-row self-join were all ~6-13ms. SQLite is
  in-process, so there is no network round trip to pay for, and its
  optimiser is very good.

  That is the honest conclusion: for typical workloads, synchronous is FINE,
  and the convenience is worth a lot. The risk is real but narrow:

    • a genuinely large scan — millions of rows, no usable index
    • a migration or bulk import run on a live server
    • analytics-shaped aggregation inside a request handler
    • a huge result set materialised with .all() instead of .iterate()

  How to know rather than guess: keep the event-loop lag monitor from
  module 02 §6.1 running in production. If p99 lag climbs, THEN investigate.

  Options, in order of preference:
    1. Index it (06-queries.ts §3) — usually the whole answer.
    2. Move the work off the request path (a job, a cron).
    3. Put the database in a WORKER THREAD (module 08) and message results.
`);
  db.close();
}

console.log("=== 4. Reuse prepared statements — measured ===");
{
  const db = memoryDb();
  db.exec("CREATE TABLE t (v INTEGER)");
  const N = 20_000;

  // Warm up, so the JIT isn't the thing being measured (module 02).
  for (let i = 0; i < 2_000; i++) db.prepare("SELECT ? AS v").get(i);

  let t0 = performance.now();
  for (let i = 0; i < N; i++) db.prepare("SELECT ? AS v").get(i);
  const reprepared = performance.now() - t0;

  const stmt = db.prepare("SELECT ? AS v");
  t0 = performance.now();
  for (let i = 0; i < N; i++) stmt.get(i);
  const reused = performance.now() - t0;

  console.log(`  ${N.toLocaleString()} queries, prepared each time: ${reprepared.toFixed(0)}ms`);
  console.log(`  ${N.toLocaleString()} queries, statement reused:   ${reused.toFixed(0)}ms`);
  console.log(`  → ${(reprepared / reused).toFixed(1)}× faster`);
  console.log(`
  prepare() COMPILES the SQL: parse, plan, generate bytecode. Doing that per
  query throws the work away every time.

  Prepare once, at startup, and hold the statements — which is exactly what
  a repository object is for (see the exercise):

      class UserRepo {
        #byId = this.db.prepare("SELECT * FROM users WHERE id = ?");
        findById(id: number) { return this.#byId.get(id); }
      }
`);
  db.close();
}

console.log("=== 5. Files vs memory ===");
await withFileDb((db, file) => {
  db.exec("CREATE TABLE t (v TEXT)");
  db.prepare("INSERT INTO t VALUES (?)").run("persisted");

  console.log("  file:", file.split("/").slice(-2).join("/"));
  console.log("  journal_mode:", (db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode);
  console.log("  page_size:   ", (db.prepare("PRAGMA page_size").get() as { page_size: number }).page_size);

  // Reopening the same path sees the same data.
  const second = new DatabaseSync(file);
  console.log("  reopened →", second.prepare("SELECT v FROM t").get());
  second.close();
});

console.log(`
  new DatabaseSync(":memory:")   fresh per connection, gone on close.
                                 Ideal for TESTS — no cleanup, no shared
                                 state between test files, instant.
  new DatabaseSync("./app.db")   persists. Creates the file if missing.

  ⚠ ":memory:" is per CONNECTION, not per process. Two DatabaseSync
  instances with ":memory:" are two SEPARATE databases — which is a feature
  for test isolation and a surprise if you expected a shared cache.
`);
