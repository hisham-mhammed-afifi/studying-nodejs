/**
 *   node scripts/test.ts 13
 *   node scripts/test.ts --solutions 13
 */

import { describe, it, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import {
  type Author,
  type AuthorWithPosts,
  ConflictError,
  type CreateAuthorInput,
  type ListOptions,
  NotFoundError,
  ValidationError,
} from "./exercise.ts";

const modulePath = process.env["IMPL"] === "solution" ? "./solution.ts" : "./exercise.ts";

interface Repo {
  create(input: CreateAuthorInput): Author;
  getById(id: number): Author;
  findByEmail(email: string): Author | undefined;
  list(options?: ListOptions): Author[];
  listWithPosts(options?: ListOptions): AuthorWithPosts[];
  update(id: number, changes: { name?: string; active?: boolean }): Author;
  delete(id: number): void;
  createWithPosts(input: CreateAuthorInput, titles: readonly string[]): AuthorWithPosts;
  count(options?: { activeOnly?: boolean }): number;
}

type Impl = {
  migrate(db: DatabaseSync): string[];
  AuthorRepository: new (db: DatabaseSync) => Repo;
};

let impl: Impl;
before(async () => {
  impl = (await import(modulePath)) as unknown as Impl;
});

let db: DatabaseSync;
let repo: Repo;
beforeEach(() => {
  // ":memory:" is per CONNECTION, so every test gets a pristine database
  // with no cleanup and no cross-test contamination.
  db = new DatabaseSync(":memory:");
  impl.migrate(db);
  repo = new impl.AuthorRepository(db);
});
afterEach(() => {
  db.close();
});

const AUTHOR: CreateAuthorInput = { email: "ada@example.com", name: "Ada" };

describe("migrate", () => {
  it("creates the schema", () => {
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
    ).map((t) => t.name);
    assert.ok(tables.includes("authors"));
    assert.ok(tables.includes("posts"));
  });

  it("creates the posts index", () => {
    const plan = (
      db.prepare("EXPLAIN QUERY PLAN SELECT * FROM posts WHERE author_id = 1").all() as Array<{
        detail: string;
      }>
    )
      .map((r) => r.detail)
      .join(" ");
    assert.ok(plan.includes("USING INDEX"), `expected an index scan, got: ${plan}`);
  });

  it("is idempotent", () => {
    const fresh = new DatabaseSync(":memory:");
    const first = impl.migrate(fresh);
    const second = impl.migrate(fresh);
    assert.ok(first.length > 0, "the first run should apply migrations");
    assert.deepEqual(second, [], "the second run should apply nothing");
    fresh.close();
  });

  it("records what it applied", () => {
    const names = (db.prepare("SELECT name FROM _migrations ORDER BY id").all() as Array<{ name: string }>).map(
      (r) => r.name,
    );
    assert.ok(names.length >= 3);
  });

  it("defaults active to 1 and published to 0", () => {
    db.prepare("INSERT INTO authors (email, name, created_at) VALUES (?, ?, ?)").run(
      "x@y.z",
      "X",
      new Date().toISOString(),
    );
    const row = db.prepare("SELECT active FROM authors WHERE email = ?").get("x@y.z") as { active: number };
    assert.equal(row.active, 1);
  });
});

describe("create and read", () => {
  it("creates an author", () => {
    const author = repo.create(AUTHOR);
    assert.equal(author.email, "ada@example.com");
    assert.equal(author.name, "Ada");
    assert.ok(author.id > 0);
  });

  it("exposes active as a real BOOLEAN", () => {
    const author = repo.create(AUTHOR);
    assert.equal(typeof author.active, "boolean", "0/1 must be mapped to a boolean");
    assert.equal(author.active, true);

    const inactive = repo.create({ email: "b@c.d", name: "B", active: false });
    assert.equal(inactive.active, false);
    assert.equal(
      (db.prepare("SELECT active FROM authors WHERE id = ?").get(inactive.id) as { active: number }).active,
      0,
      "false must be stored as 0 — binding a boolean throws",
    );
  });

  it("exposes createdAt as a real DATE", () => {
    const author = repo.create(AUTHOR);
    assert.ok(author.createdAt instanceof Date, "created_at must be mapped to a Date");
    assert.ok(!Number.isNaN(author.createdAt.getTime()));
  });

  it("returns an ORDINARY object, not a raw row", () => {
    const author = repo.create(AUTHOR);
    // A raw node:sqlite row is null-prototype: instanceof and
    // hasOwnProperty are both broken on it.
    assert.ok(author instanceof Object, "rows must be mapped — a raw row is not instanceof Object");
    assert.equal(typeof author.hasOwnProperty, "function");
    assert.equal(Object.getPrototypeOf(author), Object.prototype);
  });

  it("does not leak column names", () => {
    const author = repo.create(AUTHOR) as unknown as Record<string, unknown>;
    assert.equal(author["created_at"], undefined, "expose createdAt, not created_at");
    assert.notEqual(author["createdAt"], undefined);
  });

  it("getById returns the author", () => {
    const created = repo.create(AUTHOR);
    assert.equal(repo.getById(created.id).email, "ada@example.com");
  });

  it("getById throws NotFoundError", () => {
    assert.throws(() => repo.getById(999), NotFoundError);
  });

  it("findByEmail returns undefined for a miss", () => {
    assert.equal(repo.findByEmail("nobody@example.com"), undefined);
  });

  it("findByEmail finds by email", () => {
    repo.create(AUTHOR);
    assert.equal(repo.findByEmail("ada@example.com")?.name, "Ada");
  });
});

describe("error mapping", () => {
  it("a duplicate email is a ConflictError, not a SQLite error", () => {
    repo.create(AUTHOR);
    assert.throws(() => repo.create(AUTHOR), ConflictError);
  });

  it("never leaks SQL or the driver error to the caller", () => {
    repo.create(AUTHOR);
    try {
      repo.create(AUTHOR);
      assert.fail("expected a throw");
    } catch (err) {
      const e = err as Error & { code?: string };
      assert.equal(e.code, undefined, "the driver's ERR_SQLITE_ERROR must not escape");
      assert.ok(!/INSERT|SELECT|UNIQUE constraint/i.test(e.message), `SQL leaked: ${e.message}`);
    }
  });

  it("a bad foreign key is a ValidationError", () => {
    assert.throws(
      () => db.prepare("INSERT INTO posts (author_id, title) VALUES (?, ?)").run(999, "orphan"),
      (err: unknown) => (err as { errcode?: number }).errcode === 787,
    );
  });

  it("delete of a missing author throws NotFoundError", () => {
    assert.throws(() => repo.delete(999), NotFoundError);
  });

  it("update of a missing author throws NotFoundError", () => {
    assert.throws(() => repo.update(999, { name: "x" }), NotFoundError);
  });
});

describe("update and delete", () => {
  it("updates the name", () => {
    const a = repo.create(AUTHOR);
    assert.equal(repo.update(a.id, { name: "Ada L" }).name, "Ada L");
  });

  it("updates active", () => {
    const a = repo.create(AUTHOR);
    const updated = repo.update(a.id, { active: false });
    assert.equal(updated.active, false);
    assert.equal(repo.getById(a.id).active, false);
  });

  it("a partial update leaves other fields alone", () => {
    const a = repo.create(AUTHOR);
    const updated = repo.update(a.id, { name: "Renamed" });
    assert.equal(updated.name, "Renamed");
    assert.equal(updated.active, true, "active should be unchanged");
    assert.equal(updated.email, "ada@example.com");
  });

  it("deletes", () => {
    const a = repo.create(AUTHOR);
    repo.delete(a.id);
    assert.throws(() => repo.getById(a.id), NotFoundError);
  });

  it("cascades to posts", () => {
    const a = repo.createWithPosts(AUTHOR, ["one", "two"]);
    assert.equal((db.prepare("SELECT COUNT(*) n FROM posts").get() as { n: number }).n, 2);
    repo.delete(a.id);
    assert.equal(
      (db.prepare("SELECT COUNT(*) n FROM posts").get() as { n: number }).n,
      0,
      "ON DELETE CASCADE should remove the posts",
    );
  });
});

describe("list", () => {
  const seed = (n: number) => {
    for (let i = 1; i <= n; i++) {
      repo.create({ email: `u${i}@example.com`, name: `User ${i}`, active: i % 3 !== 0 });
    }
  };

  it("lists authors", () => {
    seed(3);
    assert.equal(repo.list().length, 3);
  });

  it("filters to active only", () => {
    seed(9); // every third is inactive
    const active = repo.list({ activeOnly: true });
    assert.equal(active.length, 6);
    assert.ok(active.every((a) => a.active));
  });

  it("applies a limit", () => {
    seed(10);
    assert.equal(repo.list({ limit: 3 }).length, 3);
  });

  it("paginates by KEYSET, not offset", () => {
    seed(10);
    const first = repo.list({ limit: 4 });
    const second = repo.list({ after: first.at(-1)!.id, limit: 4 });
    assert.equal(first.length, 4);
    assert.equal(second.length, 4);
    assert.ok(second[0]!.id > first.at(-1)!.id, "the second page must continue after the first");
    // No overlap.
    const ids = new Set([...first, ...second].map((a) => a.id));
    assert.equal(ids.size, 8);
  });

  it("count() is computed by SQL", () => {
    seed(9);
    assert.equal(repo.count(), 9);
    assert.equal(repo.count({ activeOnly: true }), 6);
  });
});

describe("listWithPosts", () => {
  it("attaches posts", () => {
    repo.createWithPosts({ email: "a@x.com", name: "A" }, ["p1", "p2"]);
    repo.createWithPosts({ email: "b@x.com", name: "B" }, ["p3"]);

    const authors = repo.listWithPosts();
    assert.equal(authors.length, 2);
    assert.deepEqual(authors[0]!.posts.map((p) => p.title), ["p1", "p2"]);
    assert.deepEqual(authors[1]!.posts.map((p) => p.title), ["p3"]);
  });

  it("includes an author with NO posts", () => {
    repo.create(AUTHOR);
    const authors = repo.listWithPosts();
    assert.equal(authors.length, 1);
    assert.deepEqual(authors[0]!.posts, [], "an author with no posts must still appear");
  });

  it("maps post fields to the domain shape", () => {
    repo.createWithPosts(AUTHOR, ["hello"]);
    const post = repo.listWithPosts()[0]!.posts[0]!;
    assert.equal(typeof post.authorId, "number", "expose authorId, not author_id");
    assert.equal(typeof post.published, "boolean", "0/1 must be mapped to a boolean");
    assert.equal((post as unknown as Record<string, unknown>)["author_id"], undefined);
  });

  it("is NOT N+1 — at most two queries for any number of authors", () => {
    for (let i = 1; i <= 20; i++) {
      repo.createWithPosts({ email: `u${i}@x.com`, name: `U${i}` }, [`p${i}a`, `p${i}b`]);
    }

    // Count SELECTs by wrapping prepare() on a fresh repo.
    const counting = new DatabaseSync(":memory:");
    impl.migrate(counting);
    const countingRepo = new impl.AuthorRepository(counting);
    for (let i = 1; i <= 20; i++) {
      countingRepo.createWithPosts({ email: `u${i}@x.com`, name: `U${i}` }, [`p${i}a`]);
    }

    let selects = 0;
    const realPrepare = counting.prepare.bind(counting);
    const patched = Object.create(counting) as DatabaseSync;
    void patched;
    // Instead of patching the DB, count via the statements the repo runs:
    // wrap prepare on the instance so any NEW statement is visible, and
    // count executions through a Proxy on the returned statement.
    (counting as unknown as { prepare: typeof counting.prepare }).prepare = ((sql: string) => {
      const stmt = realPrepare(sql);
      if (!/^\s*select/i.test(sql)) return stmt;
      return new Proxy(stmt, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver) as unknown;
          if ((prop === "all" || prop === "get") && typeof value === "function") {
            return (...args: unknown[]) => {
              selects++;
              return (value as (...a: unknown[]) => unknown).apply(target, args);
            };
          }
          return typeof value === "function" ? (value as () => unknown).bind(target) : value;
        },
      });
    }) as typeof counting.prepare;

    const fresh = new impl.AuthorRepository(counting);
    selects = 0;
    const authors = fresh.listWithPosts({ limit: 20 });

    assert.equal(authors.length, 20);
    assert.ok(
      selects <= 2,
      `listWithPosts ran ${selects} SELECTs for 20 authors — that is N+1. Use one IN (...) or a JOIN.`,
    );
    counting.close();
  });
});

describe("createWithPosts", () => {
  it("creates the author and the posts", () => {
    const result = repo.createWithPosts(AUTHOR, ["one", "two", "three"]);
    assert.equal(result.email, "ada@example.com");
    assert.equal(result.posts.length, 3);
    assert.deepEqual(result.posts.map((p) => p.title), ["one", "two", "three"]);
  });

  it("works with no posts", () => {
    const result = repo.createWithPosts(AUTHOR, []);
    assert.deepEqual(result.posts, []);
  });

  it("is ATOMIC — a failure rolls the author back too", () => {
    repo.create({ email: "taken@example.com", name: "Existing" });

    // The author insert itself conflicts, so nothing should be created.
    assert.throws(
      () => repo.createWithPosts({ email: "taken@example.com", name: "Dup" }, ["p1"]),
      ConflictError,
    );

    assert.equal(repo.count(), 1, "no extra author should exist");
    assert.equal(
      (db.prepare("SELECT COUNT(*) n FROM posts").get() as { n: number }).n,
      0,
      "no posts should have been created",
    );
  });

  it("rolls back the author when a POST fails", () => {
    // A null title violates NOT NULL, halfway through.
    assert.throws(() =>
      repo.createWithPosts(AUTHOR, ["ok", null as unknown as string]),
    );
    assert.equal(repo.count(), 0, "the author must not survive a failed post insert");
    assert.equal((db.prepare("SELECT COUNT(*) n FROM posts").get() as { n: number }).n, 0);
  });
});

describe("prepared statements", () => {
  it("prepares statements once, in the constructor", () => {
    const fresh = new DatabaseSync(":memory:");
    impl.migrate(fresh);

    const realPrepare = fresh.prepare.bind(fresh);
    let prepareCalls = 0;
    (fresh as unknown as { prepare: typeof fresh.prepare }).prepare = ((sql: string) => {
      prepareCalls++;
      return realPrepare(sql);
    }) as typeof fresh.prepare;

    const r = new impl.AuthorRepository(fresh);
    const afterConstruction = prepareCalls;

    for (let i = 1; i <= 10; i++) r.create({ email: `u${i}@x.com`, name: `U${i}` });
    for (let i = 1; i <= 10; i++) r.getById(i);

    const perCall = prepareCalls - afterConstruction;
    assert.ok(
      perCall <= 2,
      `${perCall} prepare() calls for 20 operations — prepare in the constructor, not per call`,
    );
    fresh.close();
  });
});
