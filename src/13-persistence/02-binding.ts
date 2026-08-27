/**
 * 02 — Parameter binding, and SQL injection
 *
 * Run:  node src/13-persistence/02-binding.ts
 */

import { memoryDb } from "./_helpers.ts";

const db = memoryDb();
db.exec(`
  CREATE TABLE users (
    id    INTEGER PRIMARY KEY,
    name  TEXT NOT NULL,
    email TEXT,
    role  TEXT NOT NULL DEFAULT 'user'
  );
  INSERT INTO users (name, email, role) VALUES
    ('ada',   'ada@example.com',   'admin'),
    ('grace', 'grace@example.com', 'user'),
    ('alan',  'alan@example.com',  'user');
`);

console.log("=== 1. The vulnerability ===");
{
  // Imagine this came from a query string or a JSON body.
  const userInput = "ada' OR '1'='1";

  console.log("  input:", JSON.stringify(userInput));

  // ✗ String interpolation. The input becomes SQL SYNTAX.
  const interpolated = `SELECT name, role FROM users WHERE name = '${userInput}'`;
  console.log("  ✗ interpolated SQL:", interpolated);
  console.log("    returns:", JSON.stringify(db.prepare(interpolated).all()));

  // ✓ Bound. The input can only ever be a VALUE.
  const bound = db.prepare("SELECT name, role FROM users WHERE name = ?").all(userInput);
  console.log("  ✓ bound parameter returns:", JSON.stringify(bound), "← no match, correctly");

  console.log(`
  The interpolated version returned EVERY user, including the admin. The
  bound version looked for a user literally named "ada' OR '1'='1" and
  found none — which is the right answer.

  Binding is not "escaping done well". It is escaping made UNNECESSARY:
  the SQL is parsed ONCE with ? as a placeholder in the compiled plan, and
  the value is attached afterwards. There is no path by which it can be
  re-parsed as syntax.

  Exactly the same argument as execFile vs exec in module 08 §2.1.
`);
}

console.log("=== 2. It gets worse than reading data ===");
{
  console.log(`
  A few classics, all of which bound parameters make impossible:

    "'; DROP TABLE users; --"          destruction
    "' UNION SELECT password FROM …"   exfiltration from other tables
    "' OR 1=1 --"                      authentication bypass
    "' AND (SELECT COUNT(*) FROM …)"   blind extraction, one bit at a time

  And note: node:sqlite's prepare() only accepts ONE statement, so the
  classic "; DROP TABLE" chain fails here for a second reason. Do not rely
  on that — other drivers allow multiple statements, and exfiltration via
  UNION needs no second statement at all.
`);

  try {
    db.prepare("SELECT 1; SELECT 2");
  } catch (err) {
    console.log("  multi-statement prepare() →", (err as Error).message.slice(0, 70));
  }
}

console.log("\n=== 3. Positional and named parameters ===");
{
  const positional = db.prepare("SELECT name FROM users WHERE role = ? AND name != ?");
  console.log("  ? placeholders:", JSON.stringify(positional.all("user", "alan")));

  const named = db.prepare("SELECT name FROM users WHERE role = :role AND name != :exclude");
  console.log("  :named        :", JSON.stringify(named.all({ role: "user", exclude: "alan" })));

  console.log(`
  Named parameters are worth it past about three: they are order-independent
  and self-documenting, and adding a column later cannot silently shift
  every argument by one.

  node:sqlite also accepts $name and @name — SQLite's other prefixes.
`);
}

console.log("=== 4. ⚠ What you CANNOT parameterise ===");
{
  for (const [label, sql] of [
    ["table name", "SELECT * FROM ?"],
    ["column name", "SELECT ? FROM users"],
    ["ORDER BY column", "SELECT * FROM users ORDER BY ?"],
  ] as const) {
    try {
      const stmt = db.prepare(sql);
      const rows = stmt.all("name");
      console.log(`  ${label.padEnd(16)} → no error, but returns: ${JSON.stringify(rows).slice(0, 60)}`);
    } catch (err) {
      console.log(`  ${label.padEnd(16)} → ${(err as Error).message.slice(0, 50)}`);
    }
  }

  console.log(`
  Placeholders are for VALUES, never identifiers or keywords.

  Note the ORDER BY case: it did not error — it "sorted" by the constant
  string "name", i.e. it did nothing. A silently wrong query is worse than
  a loud one, because your tests pass and the ordering is just subtly wrong
  in production.
`);
}

console.log("=== 5. Dynamic sorting, safely ===");
{
  // The interpolated values come from YOUR table, never from the request.
  const SORTABLE = { name: "name", email: "email", newest: "id" } as const;

  function listUsers(input: { sort?: string; dir?: string }) {
    const column = SORTABLE[input.sort as keyof typeof SORTABLE] ?? "id";
    const direction = input.dir?.toLowerCase() === "desc" ? "DESC" : "ASC";
    // Safe: `column` and `direction` can only be one of the literals above.
    return db.prepare(`SELECT name FROM users ORDER BY ${column} ${direction}`).all();
  }

  console.log("  sort=name        →", JSON.stringify(listUsers({ sort: "name" })));
  console.log("  sort=name&desc   →", JSON.stringify(listUsers({ sort: "name", dir: "desc" })));
  console.log("  sort=<injection> →", JSON.stringify(listUsers({ sort: "name; DROP TABLE users" })));

  console.log(`
  The last one fell back to "id" because it is not a key of SORTABLE. An
  ALLOWLIST is the only safe pattern here: never sanitise the input, map it.

  Same shape as module 10 §1.3's route precedence and module 11 §3.1's
  response schemas — decide what is ALLOWED, rather than trying to
  enumerate what is forbidden.
`);
}

console.log("=== 6. Variable-length IN (...) ===");
{
  const ids = [1, 3];
  // The number of placeholders is derived from the array LENGTH — a number
  // you control — not from its contents.
  const placeholders = ids.map(() => "?").join(",");
  const rows = db.prepare(`SELECT id, name FROM users WHERE id IN (${placeholders})`).all(...ids);
  console.log(`  IN (${placeholders}) with [${ids}] →`, JSON.stringify(rows));

  console.log(`
  This is the one place interpolation is legitimate, because you are
  interpolating a COUNT of question marks, not any user data.

  ⚠ Two cautions:
    • an EMPTY array produces "IN ()", which is a syntax error — special-case it
    • SQLite's parameter limit is 32,766 by default; chunk large lists

  A prepared statement is tied to its placeholder count, so this one cannot
  be prepared at startup. Cache by length if it is hot:

      const cache = new Map<number, StatementSync>();
`);

  try {
    db.prepare("SELECT * FROM users WHERE id IN ()").all();
  } catch (err) {
    console.log("  empty IN () →", (err as Error).message.slice(0, 50));
  }
}

db.close();
