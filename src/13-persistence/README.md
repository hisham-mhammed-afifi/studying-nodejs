# 13 — Persistence with `node:sqlite`

Node 22 ships a real SQL database. No `npm install`, no native build step, no Python toolchain — `node:sqlite` is compiled into the binary.

That makes it the ideal way to learn persistence: the SQL, the transactions, the injection risks and the query patterns are all the same ones you'll use against Postgres. Only the driver changes.

```ts
import { DatabaseSync } from "node:sqlite";
```

> ⚠ It emits `ExperimentalWarning: SQLite is an experimental feature`. The API may still change. Everything *conceptual* here transfers to any database; the specific method names are the part that might move.

---

## 1. The API is synchronous

```ts
const db = new DatabaseSync(":memory:");          // or a file path

db.exec(`CREATE TABLE users (
  id    INTEGER PRIMARY KEY,
  name  TEXT NOT NULL,
  email TEXT UNIQUE
)`);

const insert = db.prepare("INSERT INTO users (name, email) VALUES (?, ?)");
insert.run("ada", "ada@example.com");       // → { lastInsertRowid: 1, changes: 1 }

db.prepare("SELECT * FROM users WHERE id = ?").get(1);   // one row, or undefined
db.prepare("SELECT * FROM users").all();                 // an array
db.close();
```

**Synchronous.** Every module-02 warning applies: a slow query blocks the entire event loop — no other requests, no timers, no health checks.

That's usually *fine* for SQLite, because there's no network round trip and queries are microseconds. It stops being fine when you run a full table scan on a large table, so index your queries and keep an eye on loop lag (module 02 §6).

For genuinely heavy work, move the database into a **worker thread** (module 08) and message results back.

---

## 2. Prepared statements, and SQL injection

```ts
// ✗ NEVER. This is SQL injection, the whole vulnerability class.
db.prepare(`SELECT * FROM users WHERE name = '${userInput}'`);

// ✓ Bind parameters. The value can never become syntax.
db.prepare("SELECT * FROM users WHERE name = ?").get(userInput);
db.prepare("SELECT * FROM users WHERE name = :name").get({ name: userInput });
```

Binding isn't "escaping done well" — it's escaping made **unnecessary**. The SQL is parsed once, with `?` as a placeholder in the compiled plan; the value is attached afterwards and can never be re-parsed as syntax.

This is the same argument as `execFile` vs `exec` in module 08 §2.1. Same class of bug, same shape of fix.

### 2.1 Reuse statements — measured 5× faster

| 20,000 queries | Time |
|---|---|
| `db.prepare(sql).get(i)` each time | 54ms |
| prepare once, `stmt.get(i)` | **11ms** |

Preparing compiles the SQL. Do it once, at startup, and keep the statement.

### 2.2 What you cannot parameterise

Placeholders work for **values**, never for identifiers or keywords:

```ts
db.prepare("SELECT * FROM ? WHERE ...");           // ✗ table name
db.prepare("SELECT * FROM users ORDER BY ?");      // ✗ column name
db.prepare("SELECT * FROM users ORDER BY ? ASC");  // ✗ direction
```

For dynamic sorting, use an **allowlist** — never interpolate the raw input:

```ts
const COLUMNS = { name: "name", created: "created_at" } as const;
const column = COLUMNS[input.sort as keyof typeof COLUMNS] ?? "id";
const direction = input.dir === "desc" ? "DESC" : "ASC";
db.prepare(`SELECT * FROM users ORDER BY ${column} ${direction}`);
```

The interpolated values come from *your* table, not from the request.

---

## 3. Types, and two surprises

| SQLite | JavaScript |
|---|---|
| INTEGER | `number` (or `BigInt` past 2^53) |
| REAL | `number` |
| TEXT | `string` |
| BLOB | **`Uint8Array`** — not `Buffer` |
| NULL | `null` |

### 3.1 ⚠ Booleans are rejected

```ts
db.prepare("INSERT INTO t (active) VALUES (?)").run(true);
// → Error: Provided value cannot be bound to SQLite parameter 1.
```

SQLite has no boolean type, and `node:sqlite` won't guess. Convert at the boundary:

```ts
stmt.run(active ? 1 : 0);
const active = row.active === 1;
```

### 3.2 ⚠ Rows are null-prototype objects

```ts
const row = stmt.get();
Object.getPrototypeOf(row) === null;   // true
row instanceof Object;                 // false
row.hasOwnProperty;                    // undefined
{ ...row };                            // ✓ works
JSON.stringify(row);                   // ✓ works
```

This is a *security* choice — a column named `__proto__` can't poison anything. But `instanceof Object` checks and `row.hasOwnProperty(...)` both break. Use `Object.hasOwn(row, k)` and map rows into your own objects at the repository boundary (§6).

A BLOB coming back as `Uint8Array` is module 04 §1 again: the bytes survive, the `Buffer` class doesn't. Re-wrap if you need Buffer methods.

---

## 4. Transactions — the biggest number in this module

```ts
db.exec("BEGIN");
try {
  for (const row of rows) insert.run(row.a, row.b);
  db.exec("COMMIT");
} catch (err) {
  db.exec("ROLLBACK");
  throw err;
}
```

Without an explicit transaction, SQLite wraps **every statement in its own**, and each one waits for an `fsync`. Measured, 5,000 inserts to a file database:

| journal_mode | No transaction | One transaction | |
|---|---|---|---|
| `delete` (default) | **34,828ms** | **11ms** | **3285×** |
| `wal` | 11,662ms | 6ms | 1955× |

Thirty-five seconds versus eleven milliseconds. This is not a micro-optimisation — it's the difference between a working import and a broken one.

(In-memory the gap is only ~1.6×, because there's no disk to sync. Benchmark against a *file*, or you'll conclude this doesn't matter.)

### 4.1 A helper worth having

```ts
function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw err;
  }
}
```

⚠ It must be **synchronous**. An `await` inside a transaction interleaves other work onto the same connection, and you can commit someone else's half-finished changes. If you need async work, do it *before* `BEGIN`.

---

## 5. Pragmas you should set

```ts
db.exec("PRAGMA journal_mode = WAL");     // readers don't block the writer
db.exec("PRAGMA synchronous = NORMAL");   // safe with WAL, much faster
db.exec("PRAGMA busy_timeout = 5000");    // wait rather than fail on a lock
db.exec("PRAGMA foreign_keys = ON");      // see below
```

Verified defaults on a fresh file database:

| Pragma | Default | Want |
|---|---|---|
| `journal_mode` | `delete` | `wal` |
| `synchronous` | `2` (FULL) | `1` (NORMAL), with WAL |
| `foreign_keys` | **`1`** | already on |

`foreign_keys` being **ON by default** is worth knowing — the `sqlite3` CLI defaults it *off*, so advice on the internet says to enable it. `node:sqlite` already did.

---

## 6. Migrations

Schema changes need to be ordered, applied once, and recorded. The whole mechanism is about fifteen lines:

```ts
db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
  id      INTEGER PRIMARY KEY,
  name    TEXT NOT NULL UNIQUE,
  applied TEXT NOT NULL
)`);

const applied = new Set(
  db.prepare("SELECT name FROM _migrations").all().map((r) => r.name as string),
);

for (const m of migrations) {
  if (applied.has(m.name)) continue;
  transaction(db, () => {                        // ← each migration is atomic
    db.exec(m.up);
    db.prepare("INSERT INTO _migrations (name, applied) VALUES (?, ?)")
      .run(m.name, new Date().toISOString());
  });
}
```

Rules that matter more than the code:

- **Never edit an applied migration.** Add a new one. The old file is already in production.
- **Each migration in its own transaction**, so a failure leaves a consistent schema.
- **Order by name** — `001_`, `002_` — not by directory listing (module 06 §3.1: `readdir` order is filesystem-dependent).
- **Run at startup, before serving.** Fail fast (module 12 §1).

---

## 7. Query patterns

### 7.1 N+1 — and an honest caveat

```ts
// ✗ 1 + N queries
const users = db.prepare("SELECT * FROM users").all();
for (const u of users) u.posts = byUser.all(u.id);

// ✓ one query
db.prepare(`SELECT u.*, p.title FROM users u LEFT JOIN posts p ON p.user_id = u.id`).all();
```

Measured here — 500 users, 5 posts each:

| | Time |
|---|---|
| N+1 (501 queries) | 2.4ms |
| one JOIN | 1.8ms |
| one `IN (...)` + group in JS | 1.8ms |

Only ~1.3×. That's an honest result and worth understanding: **N+1 is catastrophic over a network** — 500 round trips at 1ms each is half a second — but SQLite is *in-process*, so there's no round trip to pay for.

So: still avoid it, because the same code against Postgres is 500× worse, and because 500 queries is 500 chances to block the loop. But don't expect a dramatic local benchmark.

### 7.2 Index what you filter and join on

```ts
db.exec("CREATE INDEX idx_posts_user ON posts(user_id)");
db.prepare("EXPLAIN QUERY PLAN SELECT * FROM posts WHERE user_id = ?").all();
// → "SEARCH posts USING INDEX idx_posts_user" (good)
// → "SCAN posts"                              (bad, at scale)
```

`EXPLAIN QUERY PLAN` is the tool. `SCAN` on a large table is your answer.

---

## 8. Errors

```ts
try {
  insert.run("ada", "ada@example.com");
} catch (err) {
  err.code;     // "ERR_SQLITE_ERROR"  — always this
  err.errcode;  // 2067 = UNIQUE, 1299 = NOT NULL, 787 = FOREIGN KEY
  err.errstr;   // "constraint failed"
}
```

`code` is the same for everything, so branch on **`errcode`**:

| errcode | Meaning | Sensible HTTP status |
|---|---|---|
| 2067 | `SQLITE_CONSTRAINT_UNIQUE` | 409 Conflict |
| 1299 | `SQLITE_CONSTRAINT_NOTNULL` | 400 |
| 787 | `SQLITE_CONSTRAINT_FOREIGNKEY` | 400 / 409 |
| 5 | `SQLITE_BUSY` | retry, then 503 |

Map them at the repository boundary into your own error types (module 07 §3), so the HTTP layer never sees a driver error — and never leaks SQL to a client (module 07 §4).

---

## 9. When SQLite is the right answer

**Yes:** single-node services, CLIs, desktop apps, tests, caches, embedded/edge, read-heavy workloads, anything under a few hundred GB.

**No:** multiple writers across machines (one writer at a time, by design), horizontal scaling, managed-backup requirements, workloads needing Postgres-specific features.

For this course it's ideal: real SQL, zero setup, and every concept transfers.

---

## 10. Files in this module

| File | What it demonstrates |
|---|---|
| `01-basics.ts` | `DatabaseSync`, `exec`/`prepare`/`run`/`get`/`all`, sync implications |
| `02-binding.ts` | injection, positional vs named params, what can't be parameterised |
| `03-types.ts` | the type map, rejected booleans, null-prototype rows, BLOBs |
| `04-transactions.ts` | the 3285× measurement, rollback, the async trap, pragmas |
| `05-migrations.ts` | a migration runner, ordering, atomicity, the rules |
| `06-queries.ts` | N+1 measured, JOIN vs `IN`, indexes, `EXPLAIN QUERY PLAN` |
| `exercise.ts` | build a repository: migrations, mapping, transactions, error mapping |

```bash
node src/13-persistence/index.ts
node scripts/test.ts 13
node scripts/test.ts --solutions 13
```

---

## 11. Check yourself

1. Why is `db.prepare(\`… WHERE name = '\${input}'\`)` different in kind from `.get(input)`?
2. You need `ORDER BY` a user-supplied column. How, safely?
3. 5,000 inserts take 35 seconds. What's the one-line fix, and why does it help?
4. `stmt.run(true)` throws. Why, and what do you bind instead?
5. `row.hasOwnProperty("id")` is a TypeError. Why?
6. A BLOB comes back — is it a `Buffer`?
7. A `UNIQUE` violation. Which property do you branch on, and what status do you return?
8. N+1 was only 1.3× slower here. Why is it still worth avoiding?
