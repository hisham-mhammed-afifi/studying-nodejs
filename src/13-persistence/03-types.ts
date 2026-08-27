/**
 * 03 — Types, null-prototype rows, and error codes
 *
 * Run:  node src/13-persistence/03-types.ts
 */

import { isSqliteError, memoryDb, SQLITE } from "./_helpers.ts";

console.log("=== 1. The type map ===");
{
  const db = memoryDb();
  db.exec("CREATE TABLE t (i INTEGER, r REAL, s TEXT, b BLOB, n INTEGER)");
  db.prepare("INSERT INTO t VALUES (?, ?, ?, ?, ?)").run(42, 1.5, "hello", Buffer.from([1, 2, 3]), null);

  const row = db.prepare("SELECT * FROM t").get() as Record<string, unknown>;
  for (const [k, v] of Object.entries(row)) {
    const detail = v instanceof Uint8Array ? ` (${v.constructor.name})` : "";
    console.log(`  ${k}: ${String(v).slice(0, 20).padEnd(12)} typeof ${typeof v}${detail}`);
  }

  console.log(`
    INTEGER  → number  (BigInt past 2^53 — see §3)
    REAL     → number
    TEXT     → string
    BLOB     → Uint8Array   ← NOT a Buffer
    NULL     → null

  The BLOB case is module 04 §1 again: the BYTES survive, the Buffer CLASS
  does not. Buffer.isBuffer(row.b) is false, and .toString("hex"),
  .readUInt32BE() and every other Buffer method are missing.

  Re-wrap when you need them:

      Buffer.from(v.buffer, v.byteOffset, v.byteLength)
`);
  console.log("  Buffer.isBuffer(row.b):", Buffer.isBuffer(row["b"]));
  db.close();
}

console.log("=== 2. ⚠ Booleans are REJECTED ===");
{
  const db = memoryDb();
  db.exec("CREATE TABLE flags (id INTEGER PRIMARY KEY, active INTEGER NOT NULL)");
  const ins = db.prepare("INSERT INTO flags (active) VALUES (?)");

  try {
    ins.run(true as unknown as number);
  } catch (err) {
    console.log("  run(true) →", (err as Error).message);
  }

  ins.run(1);
  ins.run(0);
  const rows = db.prepare("SELECT id, active FROM flags").all() as Array<{ id: number; active: number }>;
  console.log("  stored as integers:", JSON.stringify(rows));
  console.log("  read back as booleans:", rows.map((r) => r.active === 1));

  console.log(`
  SQLite has no boolean type, and node:sqlite refuses to guess. Convert at
  the boundary — and do it in ONE place, your repository (§6), not at every
  call site:

      stmt.run(user.active ? 1 : 0);
      return { ...row, active: row.active === 1 };

  ⚠ A subtle one: SQLite accepts TRUE/FALSE keywords in SQL and stores them
  as 1/0, so a DEFAULT TRUE column works fine — it is only the JS BINDING
  that rejects a boolean.
`);
  db.exec("CREATE TABLE d (ok INTEGER DEFAULT TRUE)");
  db.exec("INSERT INTO d DEFAULT VALUES");
  console.log("  DEFAULT TRUE in SQL →", db.prepare("SELECT ok FROM d").get());
  db.close();
}

console.log("=== 3. Big integers ===");
{
  const db = memoryDb();
  db.exec("CREATE TABLE big (v INTEGER)");

  db.prepare("INSERT INTO big VALUES (?)").run(9007199254740993n); // 2^53 + 1
  console.log("  Number.MAX_SAFE_INTEGER:", Number.MAX_SAFE_INTEGER);

  const stmt = db.prepare("SELECT v FROM big");

  // I expected a silent precision loss here. It is better than that.
  try {
    stmt.get();
  } catch (err) {
    console.log("  reading it as a number →", (err as NodeJS.ErrnoException).code);
    console.log("   ", (err as Error).message);
  }

  // Opt in per statement.
  stmt.setReadBigInts(true);
  const row = stmt.get() as { v: bigint };
  console.log("  setReadBigInts(true)   →", row.v, `(${typeof row.v})`, "✓ exact");

  console.log(`
  SQLite INTEGERs are 64-bit; JS numbers are exact only to 2^53-1
  (module 04 §4.3).

  Pleasingly, node:sqlite does NOT silently round — it THROWS
  ERR_OUT_OF_RANGE. That is the right design: a loud failure beats a
  quietly wrong id.

  So for snowflake ids, nanosecond timestamps or anything from a C int64:

      stmt.setReadBigInts(true);      // per statement, opt in

  …and remember the values are then BigInt, which does not mix with number
  in arithmetic and does not survive JSON.stringify. Converting to TEXT at
  the boundary is often simpler.
`);
  db.close();
}

console.log("=== 4. ⚠ Rows are null-prototype objects ===");
{
  const db = memoryDb();
  db.exec("CREATE TABLE u (id INTEGER PRIMARY KEY, name TEXT)");
  db.prepare("INSERT INTO u (name) VALUES (?)").run("ada");
  const row = db.prepare("SELECT * FROM u").get() as Record<string, unknown>;

  console.log("  Object.getPrototypeOf(row) === null:", Object.getPrototypeOf(row) === null);
  console.log("  row instanceof Object:              ", row instanceof Object, "← false!");
  console.log("  typeof row.hasOwnProperty:          ", typeof (row as { hasOwnProperty?: unknown }).hasOwnProperty);
  console.log("  Object.hasOwn(row, 'name'):         ", Object.hasOwn(row, "name"), "✓ use this");
  console.log("  { ...row }:                         ", JSON.stringify({ ...row }), "✓ works");
  console.log("  JSON.stringify(row):                ", JSON.stringify(row), "✓ works");

  console.log(`
  This is a SECURITY choice: a column literally named "__proto__" cannot
  poison anything, because there is no prototype to poison.

  What breaks:
    row.hasOwnProperty(k)    TypeError — the method does not exist
    row instanceof Object    false, so duck-type guards reject real rows
    row.toString()           TypeError
    lodash/util helpers      some assume Object.prototype

  What still works: property access, spread, Object.keys/entries,
  JSON.stringify, and Object.hasOwn.

  The clean fix is to MAP rows into your own objects at the repository
  boundary — which you want anyway, for the boolean conversion in §2 and
  for not leaking column names into your domain model:

      function toUser(row: UserRow): User {
        return { id: row.id, name: row.name, active: row.active === 1 };
      }
`);
  db.close();
}

console.log("=== 5. Constraint errors ===");
{
  const db = memoryDb();
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE);
    CREATE TABLE posts (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      score INTEGER CHECK (score >= 0)
    );
  `);
  const insUser = db.prepare("INSERT INTO users (email) VALUES (?)");
  insUser.run("ada@example.com");

  const cases: Array<[string, () => void]> = [
    ["UNIQUE", () => insUser.run("ada@example.com")],
    ["NOT NULL", () => insUser.run(null)],
    ["FOREIGN KEY", () => db.prepare("INSERT INTO posts (user_id) VALUES (?)").run(999)],
    ["CHECK", () => db.prepare("INSERT INTO posts (user_id, score) VALUES (?, ?)").run(1, -5)],
  ];

  console.log("  violation      code                errcode  errstr");
  console.log("  ─────────────  ──────────────────  ───────  ──────────────────");
  for (const [label, fn] of cases) {
    try {
      fn();
      console.log(`  ${label.padEnd(13)}  (no error!)`);
    } catch (err) {
      if (!isSqliteError(err)) throw err;
      console.log(
        `  ${label.padEnd(13)}  ${(err.code ?? "").padEnd(18)}  ${String(err.errcode).padEnd(7)}  ${err.errstr ?? ""}`,
      );
    }
  }

  console.log(`
  Note that .code is ERR_SQLITE_ERROR for ALL of them. Branching on it
  tells you nothing. The discriminator is .errcode:

      ${SQLITE.CONSTRAINT_UNIQUE}   UNIQUE       → 409 Conflict
      ${SQLITE.CONSTRAINT_NOTNULL}   NOT NULL     → 400 (or a bug in your code)
      ${SQLITE.CONSTRAINT_FOREIGNKEY}    FOREIGN KEY  → 400 / 409
      ${SQLITE.CONSTRAINT_CHECK}    CHECK        → 400
      ${SQLITE.BUSY}      BUSY         → retry, then 503

  Map these at the REPOSITORY boundary into your own error types
  (module 07 §3), so the HTTP layer never sees a driver error and no SQL
  ever reaches a client (module 07 §4):

      catch (err) {
        if (isSqliteError(err) && err.errcode === SQLITE.CONSTRAINT_UNIQUE) {
          throw new ConflictError("email already registered");
        }
        throw err;
      }
`);
  db.close();
}

console.log("=== 6. Dates: pick one representation ===");
{
  const db = memoryDb();
  db.exec("CREATE TABLE events (id INTEGER PRIMARY KEY, at_text TEXT, at_epoch INTEGER)");

  const now = new Date("2026-03-01T12:34:56.789Z");
  try {
    db.prepare("INSERT INTO events (at_text) VALUES (?)").run(now as unknown as string);
  } catch (err) {
    console.log("  binding a Date directly →", (err as Error).message.slice(0, 60));
  }

  db.prepare("INSERT INTO events (at_text, at_epoch) VALUES (?, ?)").run(now.toISOString(), now.getTime());
  const row = db.prepare("SELECT at_text, at_epoch FROM events").get() as { at_text: string; at_epoch: number };
  console.log("  as ISO TEXT: ", row.at_text, "→", new Date(row.at_text).toISOString());
  console.log("  as epoch ms: ", row.at_epoch, "→", new Date(row.at_epoch).toISOString());

  console.log(`
  SQLite has no date type either, and Date objects cannot be bound.

    ISO TEXT     human-readable in a SQL console, sorts correctly as text,
                 works with SQLite's date functions. Usually the right pick.
    epoch INTEGER  compact, trivially comparable, no timezone ambiguity.

  Pick ONE and apply it everywhere. A schema with both — or with some
  columns in seconds and others in milliseconds — is a bug generator.
  Store UTC. Always.
`);
  db.close();
}
