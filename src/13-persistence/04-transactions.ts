/**
 * 04 — Transactions: the biggest number in this course
 *
 * Run:  node src/13-persistence/04-transactions.ts
 */

import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { memoryDb, transaction } from "./_helpers.ts";

console.log("=== 1. The measurement ===");
{
  const dir = await mkdtemp(path.join(tmpdir(), "node-study-tx-"));
  const ROWS = 5_000;

  console.log(`  ${ROWS.toLocaleString()} inserts into a FILE database:\n`);
  console.log("  journal_mode   no transaction   one transaction   ratio");
  console.log("  ────────────   ──────────────   ───────────────   ─────");

  for (const mode of ["delete", "wal"] as const) {
    const db = new DatabaseSync(path.join(dir, `${mode}.db`));
    db.exec(`PRAGMA journal_mode = ${mode}`);
    db.exec("CREATE TABLE t (v INTEGER)");
    const ins = db.prepare("INSERT INTO t VALUES (?)");

    // Each statement is its own implicit transaction → one fsync each.
    let t0 = performance.now();
    for (let i = 0; i < ROWS; i++) ins.run(i);
    const without = performance.now() - t0;

    db.exec("DELETE FROM t");

    // One transaction → one fsync for the lot.
    t0 = performance.now();
    db.exec("BEGIN");
    for (let i = 0; i < ROWS; i++) ins.run(i);
    db.exec("COMMIT");
    const within = performance.now() - t0;

    console.log(
      `  ${mode.padEnd(12)}   ${(without / 1000).toFixed(1).padStart(11)}s   ${within.toFixed(0).padStart(13)}ms   ${(without / within).toFixed(0).padStart(4)}×`,
    );
    db.close();
  }

  await rm(dir, { recursive: true, force: true });

  console.log(`
  Thirty-five seconds versus eleven milliseconds.

  Without an explicit transaction SQLite wraps EVERY statement in its own,
  and every commit waits for an fsync — an actual "is it on the physical
  disk yet" round trip. 5,000 of those is 5,000 disk syncs.

  One BEGIN…COMMIT is one sync for the whole batch.

  This is not a micro-optimisation. It is the difference between an import
  that works and one that appears to hang.
`);
}

console.log("=== 2. ⚠ Benchmark against a FILE, not :memory: ===");
{
  const db = memoryDb();
  db.exec("CREATE TABLE t (v INTEGER)");
  const ins = db.prepare("INSERT INTO t VALUES (?)");
  const ROWS = 20_000;

  let t0 = performance.now();
  for (let i = 0; i < ROWS; i++) ins.run(i);
  const without = performance.now() - t0;

  db.exec("DELETE FROM t");
  t0 = performance.now();
  db.exec("BEGIN");
  for (let i = 0; i < ROWS; i++) ins.run(i);
  db.exec("COMMIT");
  const within = performance.now() - t0;

  console.log(`  in-memory, ${ROWS.toLocaleString()} inserts: ${without.toFixed(0)}ms vs ${within.toFixed(0)}ms → ${(without / within).toFixed(1)}×`);
  console.log(`
  Only ~1.5×, because there is no disk to sync to.

  If you benchmark transactions against :memory: you will conclude they
  barely matter — and then ship the import that takes 35 seconds. Always
  benchmark persistence against the storage you actually use.
`);
  db.close();
}

console.log("=== 3. Rollback ===");
{
  const db = memoryDb();
  db.exec("CREATE TABLE accounts (id INTEGER PRIMARY KEY, balance INTEGER NOT NULL CHECK (balance >= 0))");
  const ins = db.prepare("INSERT INTO accounts (id, balance) VALUES (?, ?)");
  ins.run(1, 100);
  ins.run(2, 50);

  const debit = db.prepare("UPDATE accounts SET balance = balance - ? WHERE id = ?");
  const credit = db.prepare("UPDATE accounts SET balance = balance + ? WHERE id = ?");
  const balances = () => db.prepare("SELECT id, balance FROM accounts ORDER BY id").all();

  console.log("  before:      ", JSON.stringify(balances()));

  // A transfer that succeeds.
  transaction(db, () => {
    debit.run(30, 1);
    credit.run(30, 2);
  });
  console.log("  after 30:    ", JSON.stringify(balances()));

  // A transfer that violates the CHECK halfway through.
  try {
    transaction(db, () => {
      debit.run(500, 1); // → balance would be -430, CHECK fails
      credit.run(500, 2); // never runs
    });
  } catch (err) {
    console.log("  failed transfer:", (err as Error).message.slice(0, 60));
  }
  console.log("  after failure:", JSON.stringify(balances()), "← unchanged ✓");

  console.log(`
  Without the transaction, the debit would have succeeded and the credit
  failed — money destroyed. Atomicity is the point: all of it, or none.

  Note the CHECK constraint doing real work. Constraints in the SCHEMA are
  enforced no matter which code path writes; a check in application code is
  enforced only where someone remembered it.
`);
  db.close();
}

console.log("=== 4. ⚠ Never await inside a transaction ===");
console.log(`
  // ✗ BROKEN
  db.exec("BEGIN");
  for (const row of rows) {
    const enriched = await fetchFromApi(row.id);   // ← yields the loop
    insert.run(row.id, enriched.value);
  }
  db.exec("COMMIT");

  During that await, the event loop runs other work — including other
  request handlers using the SAME connection. Their statements land inside
  YOUR open transaction. Then:

    • your COMMIT commits their half-finished changes, or
    • your ROLLBACK discards their completed ones, or
    • they issue their own BEGIN and get "cannot start a transaction
      within a transaction"

  The transaction helper in _helpers.ts is deliberately SYNCHRONOUS so this
  cannot compile:

      export function transaction<T>(db: DatabaseSync, fn: () => T): T

  ✓ Do the async work FIRST, then write:

      const enriched = await Promise.all(rows.map((r) => fetchFromApi(r.id)));
      transaction(db, () => {
        for (const e of enriched) insert.run(e.id, e.value);
      });

  (This is the same hazard as module 05's "await inside a stream loop" and
  module 02's "await is not a yield": the loop keeps running, and shared
  state is what gets corrupted.)
`);

console.log("=== 5. Pragmas worth setting ===");
{
  const dir = await mkdtemp(path.join(tmpdir(), "node-study-pragma-"));
  const db = new DatabaseSync(path.join(dir, "app.db"));

  const read = (name: string) =>
    JSON.stringify((db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown>)?.[name]);

  console.log("  fresh file database defaults:");
  for (const p of ["journal_mode", "synchronous", "foreign_keys", "busy_timeout"]) {
    console.log(`    ${p.padEnd(14)} ${read(p)}`);
  }

  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");

  console.log("\n  after configuring:");
  for (const p of ["journal_mode", "synchronous", "busy_timeout"]) {
    console.log(`    ${p.padEnd(14)} ${read(p)}`);
  }

  db.close();
  await rm(dir, { recursive: true, force: true });

  console.log(`
  journal_mode = WAL
      Write-Ahead Logging. Readers no longer block the writer, and the
      writer no longer blocks readers. Almost always what you want for a
      server. Persists in the file — set it once.

  synchronous = NORMAL
      With WAL this is safe: you can lose the last transaction on an OS
      crash, but the database is never CORRUPTED. Much faster than FULL.

  busy_timeout = 5000
      SQLite allows one writer at a time. Without this, a concurrent writer
      fails immediately with SQLITE_BUSY (errcode 5); with it, it waits.

  foreign_keys
      Already 1 in node:sqlite. Worth knowing, because the sqlite3 CLI
      defaults it OFF, so most advice online tells you to turn it on.
`);
}

console.log("=== 6. Savepoints, for nesting ===");
{
  const db = memoryDb();
  db.exec("CREATE TABLE t (v TEXT)");
  const ins = db.prepare("INSERT INTO t VALUES (?)");
  const count = () => (db.prepare("SELECT COUNT(*) c FROM t").get() as { c: number }).c;

  db.exec("BEGIN");
  ins.run("outer");

  // BEGIN inside BEGIN is an error; SAVEPOINT is the nestable version.
  db.exec("SAVEPOINT inner_work");
  ins.run("inner");
  db.exec("ROLLBACK TO inner_work"); // undo just the inner part
  db.exec("RELEASE inner_work");

  ins.run("outer-2");
  db.exec("COMMIT");

  console.log("  rows after nested rollback:", db.prepare("SELECT v FROM t").all());
  console.log("  count:", count());
  console.log(`
  A nested BEGIN throws "cannot start a transaction within a transaction".
  SAVEPOINT nests: ROLLBACK TO undoes work back to the savepoint while
  leaving the outer transaction open.

  Useful when a helper wants atomicity but might itself be called from
  inside a larger transaction — a repository method, for instance.
`);
  db.close();
}
