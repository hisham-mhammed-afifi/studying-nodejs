/**
 * 05 — Migrations: ordered, once, recorded
 *
 * Run:  node src/13-persistence/05-migrations.ts
 */

import type { DatabaseSync } from "node:sqlite";
import { memoryDb, transaction, withFileDb } from "./_helpers.ts";

interface Migration {
  name: string;
  up: string;
}

/** Ordered by NAME, so the numeric prefix is the contract. */
const MIGRATIONS: Migration[] = [
  {
    name: "001_create_users",
    up: `CREATE TABLE users (
           id    INTEGER PRIMARY KEY,
           email TEXT NOT NULL UNIQUE,
           name  TEXT NOT NULL
         )`,
  },
  {
    name: "002_create_posts",
    up: `CREATE TABLE posts (
           id      INTEGER PRIMARY KEY,
           user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
           title   TEXT NOT NULL
         );
         CREATE INDEX idx_posts_user ON posts(user_id)`,
  },
  {
    name: "003_add_user_active",
    // A new column MUST be nullable or have a default — existing rows need
    // a value, and SQLite will not invent one.
    up: `ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1`,
  },
];

/** ~15 lines, and it is the whole mechanism. */
function migrate(db: DatabaseSync, migrations: readonly Migration[]): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    id      INTEGER PRIMARY KEY,
    name    TEXT NOT NULL UNIQUE,
    applied TEXT NOT NULL
  )`);

  const done = new Set(
    (db.prepare("SELECT name FROM _migrations").all() as Array<{ name: string }>).map((r) => r.name),
  );
  const record = db.prepare("INSERT INTO _migrations (name, applied) VALUES (?, ?)");
  const ran: string[] = [];

  for (const m of [...migrations].sort((a, b) => a.name.localeCompare(b.name))) {
    if (done.has(m.name)) continue;
    // Each migration is ATOMIC: schema change + bookkeeping together, so a
    // failure can never leave "applied" recorded for a change that didn't land.
    transaction(db, () => {
      db.exec(m.up);
      record.run(m.name, new Date().toISOString());
    });
    ran.push(m.name);
  }
  return ran;
}

console.log("=== 1. Running them ===");
{
  const db = memoryDb();

  console.log("  first run applied: ", migrate(db, MIGRATIONS));
  console.log("  second run applied:", migrate(db, MIGRATIONS), "← idempotent ✓");

  const cols = (db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>).map((c) => c.name);
  console.log("  users columns:", cols.join(", "));
  console.log("  recorded:", (db.prepare("SELECT name FROM _migrations ORDER BY id").all() as Array<{ name: string }>).map((r) => r.name));

  db.close();
}

console.log(`
  The mechanism is three ideas:

    1. a table recording what has been applied
    2. skip anything already recorded
    3. apply the rest, in order, each in its own transaction

  Run it at STARTUP, before the server accepts traffic, and let a failure
  stop the process (module 12 §1). A container that cannot migrate should
  fail its health check and roll back, not serve requests against a schema
  it does not understand.
`);

console.log("=== 2. Atomicity: a failing migration leaves nothing behind ===");
{
  const db = memoryDb();
  migrate(db, MIGRATIONS);

  const broken: Migration = {
    name: "004_broken",
    up: `CREATE TABLE ok_so_far (id INTEGER PRIMARY KEY);
         CREATE TABLE users (id INTEGER PRIMARY KEY)`, // users already exists
  };

  try {
    migrate(db, [...MIGRATIONS, broken]);
  } catch (err) {
    console.log("  migration failed:", (err as Error).message.slice(0, 50));
  }

  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
    .map((t) => t.name)
    .filter((t) => !t.startsWith("sqlite_"));
  console.log("  tables now:", tables.join(", "));
  console.log("  'ok_so_far' created?", tables.includes("ok_so_far"), "← rolled back ✓");
  console.log("  '004_broken' recorded?", Boolean(db.prepare("SELECT 1 FROM _migrations WHERE name = ?").get("004_broken")));

  console.log(`
  The first CREATE inside 004 succeeded, the second failed, and the
  transaction undid BOTH — plus the bookkeeping row.

  Without the transaction you would be left with a half-applied schema AND
  no record of it, which is the worst possible state: the next run either
  skips it (leaving the schema broken) or re-runs it (and fails on the
  table that DID get created).
`);
  db.close();
}

console.log("=== 3. Ordering must not depend on the filesystem ===");
console.log(`
  If migrations live in files, sort them EXPLICITLY:

      const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();

  readdir order is filesystem-dependent (module 06 §3.1) — it differs
  between ext4, APFS and NTFS, and between a local checkout and a Docker
  image. "It worked on my machine" here means a differently-ordered schema.

  And zero-pad the prefix:

      001_, 002_ … 010_     ✓ sorts correctly as TEXT
      1_, 2_ … 10_          ✗ "10_" sorts before "2_"
`);

console.log("=== 4. Rules that matter more than the code ===");
console.log(`
  NEVER EDIT AN APPLIED MIGRATION.
      It already ran in production. Editing it changes nothing there and
      makes fresh databases diverge from existing ones. Add a new one.

  ONE LOGICAL CHANGE PER MIGRATION.
      Easier to review, and a failure has a smaller blast radius.

  NEW COLUMNS NEED A DEFAULT OR NULLABILITY.
      ALTER TABLE ADD COLUMN x TEXT NOT NULL   → fails if rows exist.
      Add it nullable, backfill, then tighten in a later migration.

  EXPAND / CONTRACT FOR ANYTHING BREAKING.
      Renaming a column with running instances is three deploys:
        1. ADD the new column, write to BOTH, read from the old
        2. backfill; switch reads to the new
        3. DROP the old
      One deploy that renames it breaks every instance still running the
      previous version — which, during a rolling deploy, is all of them.

  MIGRATIONS ARE NOT SEEDS.
      Schema in migrations; test/demo data in a separate seed script.
      Otherwise you cannot run migrations against production.

  ⚠ SQLite specifically: ALTER TABLE is limited. DROP COLUMN and RENAME
  COLUMN exist in modern versions, but changing a type or a constraint
  needs the 12-step dance: create a new table, copy, drop, rename. Write it
  as one transaction.
`);

console.log("=== 5. On a real file, at startup ===");
await withFileDb(async (db) => {
  // Pragmas FIRST — journal_mode is persistent, the others are per-connection.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");

  const applied = migrate(db, MIGRATIONS);
  console.log("  applied:", applied.length, "migrations");
  console.log("  journal_mode:", (db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode);

  db.prepare("INSERT INTO users (email, name) VALUES (?, ?)").run("ada@example.com", "ada");
  console.log("  smoke test:", db.prepare("SELECT id, email, active FROM users").get());

  console.log(`
  The startup sequence:

      const db = new DatabaseSync(config.DATABASE_PATH);
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA busy_timeout = 5000");
      migrate(db, MIGRATIONS);          // throws → the process dies → rollback
      const app = buildApp({ db });
      await app.listen({ port: config.PORT });

  Note the order: pragmas, then migrate, then build, then listen. Nothing
  accepts a connection until the schema is known-good.
`);
});
