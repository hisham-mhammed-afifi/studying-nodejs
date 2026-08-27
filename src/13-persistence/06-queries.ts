/**
 * 06 — Query patterns: N+1, indexes, and reading a query plan
 *
 * Run:  node src/13-persistence/06-queries.ts
 */

import { memoryDb } from "./_helpers.ts";

const USERS = 500;
const POSTS_EACH = 5;

const db = memoryDb();
db.exec(`
  CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
  CREATE TABLE posts (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, title TEXT NOT NULL);
`);

db.exec("BEGIN");
const insUser = db.prepare("INSERT INTO users (name) VALUES (?)");
const insPost = db.prepare("INSERT INTO posts (user_id, title) VALUES (?, ?)");
for (let u = 1; u <= USERS; u++) {
  insUser.run(`user ${u}`);
  for (let p = 0; p < POSTS_EACH; p++) insPost.run(u, `post ${u}-${p}`);
}
db.exec("COMMIT");

console.log("=== 1. Indexes: EXPLAIN QUERY PLAN tells you ===");
{
  const plan = (sql: string) =>
    (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>)
      .map((r) => r.detail)
      .join(" | ");

  const q = "SELECT * FROM posts WHERE user_id = 1";
  console.log("  before an index:", plan(q));

  const t0 = performance.now();
  for (let i = 1; i <= 200; i++) db.prepare("SELECT * FROM posts WHERE user_id = ?").all(i);
  const scanMs = performance.now() - t0;

  db.exec("CREATE INDEX idx_posts_user ON posts(user_id)");
  console.log("  after an index: ", plan(q));

  const stmt = db.prepare("SELECT * FROM posts WHERE user_id = ?");
  const t1 = performance.now();
  for (let i = 1; i <= 200; i++) stmt.all(i);
  const indexedMs = performance.now() - t1;

  console.log(`  200 lookups: ${scanMs.toFixed(0)}ms scanning → ${indexedMs.toFixed(1)}ms indexed`);
  console.log(`
  Read the plan, not the vibes:

      SCAN posts                          ✗ every row, every time
      SEARCH posts USING INDEX idx_…      ✓ a B-tree lookup

  Index the columns you FILTER on (WHERE) and JOIN on. A foreign key does
  NOT create an index in SQLite — you have to add it yourself, and forgetting
  is the single most common cause of a slow SQLite app.

  Indexes are not free: they cost space and slow writes. Add them for
  queries you actually run, then verify with EXPLAIN QUERY PLAN.
`);
}

console.log("=== 2. N+1, measured — with an honest caveat ===");
{
  const users = db.prepare("SELECT id, name FROM users").all() as Array<{ id: number; name: string }>;
  const byUser = db.prepare("SELECT user_id, title FROM posts WHERE user_id = ?");
  const joined = db.prepare(`
    SELECT u.id AS uid, u.name, p.title
    FROM users u LEFT JOIN posts p ON p.user_id = u.id
  `);
  const placeholders = users.map(() => "?").join(",");
  const inQuery = db.prepare(`SELECT user_id, title FROM posts WHERE user_id IN (${placeholders})`);

  const bench = (label: string, fn: () => number) => {
    fn(); // warm
    const t0 = performance.now();
    const rows = fn();
    console.log(`  ${label.padEnd(30)} ${(performance.now() - t0).toFixed(1).padStart(6)}ms  (${rows} rows)`);
  };

  bench(`N+1 — 1 + ${USERS} queries`, () => {
    let total = 0;
    for (const u of users) total += byUser.all(u.id).length;
    return total;
  });

  bench("one JOIN", () => joined.all().length);

  bench("one IN (...) + group in JS", () => {
    const rows = inQuery.all(...users.map((u) => u.id)) as Array<{ user_id: number; title: string }>;
    const grouped = new Map<number, string[]>();
    for (const r of rows) grouped.set(r.user_id, [...(grouped.get(r.user_id) ?? []), r.title]);
    return rows.length;
  });

  console.log(`
  Only ~1.3×. That is an honest result and worth understanding rather than
  explaining away.

  N+1 is catastrophic when each query costs a NETWORK ROUND TRIP: 500
  queries × 1ms to Postgres is half a second of pure latency. SQLite is
  IN-PROCESS — there is no round trip, so the overhead is just function
  calls.

  Avoid it anyway:
    • the identical code against Postgres or MySQL is 100-1000× worse
    • 500 synchronous queries is 500 chances to block the loop (01 §3)
    • it scales with your data, so it degrades silently as rows grow
    • an ORM makes it invisible — user.posts inside a loop looks harmless

  The fix is one of two shapes:
    JOIN        one query, denormalised rows, group in JS
    IN (...)    two queries, no duplication of the parent columns
  Prefer IN when the parent has wide columns you would otherwise repeat
  N times.
`);
}

console.log("=== 3. Grouping JOIN results ===");
{
  const rows = db
    .prepare(`
      SELECT u.id AS uid, u.name AS name, p.id AS pid, p.title AS title
      FROM users u LEFT JOIN posts p ON p.user_id = u.id
      WHERE u.id <= 2
      ORDER BY u.id, p.id
    `)
    .all() as Array<{ uid: number; name: string; pid: number | null; title: string | null }>;

  // A LEFT JOIN repeats the parent columns per child, and gives NULL
  // children for a parent with none. Both need handling.
  const byUser = new Map<number, { id: number; name: string; posts: string[] }>();
  for (const r of rows) {
    let user = byUser.get(r.uid);
    if (!user) {
      user = { id: r.uid, name: r.name, posts: [] };
      byUser.set(r.uid, user);
    }
    if (r.title !== null) user.posts.push(r.title); // NULL = no posts
  }

  console.log("  raw JOIN rows:", rows.length);
  console.log("  grouped:", JSON.stringify([...byUser.values()].map((u) => ({ ...u, posts: u.posts.length })), null, 0));
  console.log(`
  Two things a JOIN forces you to handle:

    • the parent columns REPEAT once per child — wasteful if they are wide
    • a parent with no children yields one row of NULLs, not zero rows,
      so \`if (r.title !== null)\` is load-bearing

  That is exactly the work an ORM does for you, and exactly the work it
  hides when it decides to do it as N+1 instead.
`);
}

console.log("=== 4. Pagination ===");
{
  const offsetQ = db.prepare("SELECT id, name FROM users ORDER BY id LIMIT ? OFFSET ?");
  const keysetQ = db.prepare("SELECT id, name FROM users WHERE id > ? ORDER BY id LIMIT ?");

  const deep = 400;
  let t0 = performance.now();
  for (let i = 0; i < 200; i++) offsetQ.all(10, deep);
  const offsetMs = performance.now() - t0;

  t0 = performance.now();
  for (let i = 0; i < 200; i++) keysetQ.all(deep, 10);
  const keysetMs = performance.now() - t0;

  console.log(`  200 × page at offset ${deep}: OFFSET ${offsetMs.toFixed(1)}ms | keyset ${keysetMs.toFixed(1)}ms`);
  console.log(`
  OFFSET must WALK the rows it skips, so page 1,000 reads 10,000 rows to
  return ten. Keyset ("seek") pagination uses the index directly:

      SELECT * FROM users WHERE id > :lastSeenId ORDER BY id LIMIT 20

  The gap is small at 500 rows and enormous at a million.

  Keyset also fixes a correctness bug OFFSET has: if a row is INSERTED
  while a user pages through, every subsequent page shifts and they see a
  duplicate. Keyset is stable because it is anchored to a value, not a
  position.

  The trade-off: no "jump to page 7". Usually fine — most UIs want
  infinite scroll or next/previous anyway.
`);
}

console.log("=== 5. Aggregate in SQL, not in JavaScript ===");
{
  const t0 = performance.now();
  const allPosts = db.prepare("SELECT user_id FROM posts").all() as Array<{ user_id: number }>;
  const counts = new Map<number, number>();
  for (const p of allPosts) counts.set(p.user_id, (counts.get(p.user_id) ?? 0) + 1);
  const jsMs = performance.now() - t0;

  const t1 = performance.now();
  const sqlCounts = db
    .prepare("SELECT user_id, COUNT(*) AS n FROM posts GROUP BY user_id")
    .all() as Array<{ user_id: number; n: number }>;
  const sqlMs = performance.now() - t1;

  console.log(`  count per user in JS:  ${jsMs.toFixed(1)}ms (${allPosts.length} rows pulled)`);
  console.log(`  count per user in SQL: ${sqlMs.toFixed(1)}ms (${sqlCounts.length} rows pulled)`);
  console.log(`
  ${allPosts.length} rows crossed the boundary in the first version; ${sqlCounts.length} in the second.
  That ratio is the point, and it grows with your data.

  This is module 02 §7.4's advice arriving in a different costume: "the
  cheapest fix is not to move the data". COUNT, SUM, GROUP BY, MAX and
  window functions all run where the data already is.
`);
}

console.log("=== 6. Streaming large result sets ===");
{
  // .all() materialises EVERYTHING. For a large table that is a memory
  // spike proportional to the result (module 04 §7.2).
  const iterator = db.prepare("SELECT id FROM posts").iterate();
  let count = 0;
  for (const _row of iterator) {
    count++;
    if (count >= 3) break; // early exit — nothing else was materialised
  }
  console.log(`  .iterate() + break after ${count} rows ✓`);
  console.log(`
      stmt.all()      builds the whole array in memory
      stmt.iterate()  yields one row at a time

  Use iterate() for exports, migrations and anything unbounded. Combine it
  with a Readable (module 05) to stream rows straight to an HTTP response
  with backpressure:

      Readable.from(stmt.iterate())
        .pipe(toNdjson())
        .pipe(res);

  ⚠ Do not leave an iterator half-consumed inside a transaction — it holds
  a read cursor. Finish it, or break out and let it be collected.
`);
}

db.close();
