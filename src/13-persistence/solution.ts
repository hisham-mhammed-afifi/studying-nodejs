/**
 * SOLUTION 13 — reference implementation.
 */

import type { DatabaseSync, StatementSync } from "node:sqlite";
import { isSqliteError, SQLITE, transaction } from "./_helpers.ts";
import {
  type Author,
  type AuthorWithPosts,
  ConflictError,
  type CreateAuthorInput,
  type ListOptions,
  NotFoundError,
  type Post,
  ValidationError,
} from "./exercise.ts";

// --- Task 1 ------------------------------------------------------------------

const MIGRATIONS: Array<{ name: string; up: string }> = [
  {
    name: "001_create_authors",
    up: `CREATE TABLE authors (
           id         INTEGER PRIMARY KEY,
           email      TEXT NOT NULL UNIQUE,
           name       TEXT NOT NULL,
           active     INTEGER NOT NULL DEFAULT 1,
           created_at TEXT NOT NULL
         )`,
  },
  {
    name: "002_create_posts",
    up: `CREATE TABLE posts (
           id        INTEGER PRIMARY KEY,
           author_id INTEGER NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
           title     TEXT NOT NULL,
           published INTEGER NOT NULL DEFAULT 0
         )`,
  },
  {
    // A foreign key does NOT create an index in SQLite. Without this,
    // every listWithPosts is a full scan of posts.
    name: "003_index_posts_author",
    up: `CREATE INDEX idx_posts_author ON posts(author_id)`,
  },
];

export function migrate(db: DatabaseSync): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    id      INTEGER PRIMARY KEY,
    name    TEXT NOT NULL UNIQUE,
    applied TEXT NOT NULL
  )`);

  const done = new Set(
    (db.prepare("SELECT name FROM _migrations").all() as Array<{ name: string }>).map((r) => r.name),
  );
  const record = db.prepare("INSERT INTO _migrations (name, applied) VALUES (?, ?)");
  const applied: string[] = [];

  // Sort explicitly: never rely on array or filesystem order (module 06 §3.1).
  for (const m of [...MIGRATIONS].sort((a, b) => a.name.localeCompare(b.name))) {
    if (done.has(m.name)) continue;
    // Schema change + bookkeeping in ONE transaction, so a failure can
    // never record a migration that did not fully apply.
    transaction(db, () => {
      db.exec(m.up);
      record.run(m.name, new Date().toISOString());
    });
    applied.push(m.name);
  }
  return applied;
}

// --- Task 2 ------------------------------------------------------------------

/** The raw shape SQLite returns: snake_case, 0/1 flags, ISO strings. */
interface AuthorRow {
  id: number;
  email: string;
  name: string;
  active: number;
  created_at: string;
}

interface PostRow {
  id: number;
  author_id: number;
  title: string;
  published: number;
}

/**
 * node:sqlite types every row as Record<string, SQLOutputValue>, because it
 * cannot know your schema. Narrowing to a row interface therefore needs a
 * cast — so keep it in ONE place rather than scattering `as unknown as`
 * through the queries.
 *
 * This is the same boundary as `req.body as CreateUser` (module 12 §2): the
 * cast is a claim, and the SCHEMA is what makes it true. Here the migration
 * is the schema.
 */
const asRow = <T>(row: unknown): T => row as T;
const asRows = <T>(rows: unknown): T[] => rows as T[];

/**
 * The mapping boundary. Three jobs, all of them load-bearing:
 *   1. 0/1 → boolean, ISO string → Date  (SQLite has neither type)
 *   2. snake_case → camelCase            (don't leak column names)
 *   3. null-prototype row → plain object (§3.4 — instanceof and
 *      hasOwnProperty are broken on a raw row)
 */
function toAuthor(row: AuthorRow): Author {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    active: row.active === 1,
    createdAt: new Date(row.created_at),
  };
}

function toPost(row: PostRow): Post {
  return {
    id: row.id,
    authorId: row.author_id,
    title: row.title,
    published: row.published === 1,
  };
}

/** Turn a driver error into the domain's vocabulary (module 07 §3). */
function mapDbError(err: unknown, context: string): never {
  if (isSqliteError(err)) {
    switch (err.errcode) {
      case SQLITE.CONSTRAINT_UNIQUE:
        throw new ConflictError(`${context}: already exists`, { cause: err });
      case SQLITE.CONSTRAINT_FOREIGNKEY:
        throw new ValidationError(`${context}: referenced row does not exist`, { cause: err });
      case SQLITE.CONSTRAINT_NOTNULL:
      case SQLITE.CONSTRAINT_CHECK:
        throw new ValidationError(`${context}: invalid value`, { cause: err });
    }
  }
  // Not ours to translate — rethrow so a real bug is not disguised as a 400.
  throw err;
}

export class AuthorRepository {
  readonly #db: DatabaseSync;

  // Prepared ONCE. prepare() compiles the SQL; doing it per call was 4-5×
  // slower in 01-basics.ts §4.
  readonly #insert: StatementSync;
  readonly #byId: StatementSync;
  readonly #byEmail: StatementSync;
  readonly #update: StatementSync;
  readonly #delete: StatementSync;
  readonly #insertPost: StatementSync;
  readonly #postsByAuthors: Map<number, StatementSync> = new Map();

  constructor(db: DatabaseSync) {
    this.#db = db;
    this.#insert = db.prepare(
      "INSERT INTO authors (email, name, active, created_at) VALUES (?, ?, ?, ?) RETURNING *",
    );
    this.#byId = db.prepare("SELECT * FROM authors WHERE id = ?");
    this.#byEmail = db.prepare("SELECT * FROM authors WHERE email = ?");
    this.#update = db.prepare(
      "UPDATE authors SET name = ?, active = ? WHERE id = ? RETURNING *",
    );
    this.#delete = db.prepare("DELETE FROM authors WHERE id = ?");
    this.#insertPost = db.prepare("INSERT INTO posts (author_id, title) VALUES (?, ?) RETURNING *");
  }

  create(input: CreateAuthorInput): Author {
    try {
      const row = this.#insert.get(
        input.email,
        input.name,
        // A JS boolean cannot be bound (§3.2).
        input.active === false ? 0 : 1,
        new Date().toISOString(),
      );
      return toAuthor(asRow<AuthorRow>(row));
    } catch (err) {
      return mapDbError(err, `author ${input.email}`);
    }
  }

  getById(id: number): Author {
    const row = this.#byId.get(id);
    if (!row) throw new NotFoundError("author", id);
    return toAuthor(asRow<AuthorRow>(row));
  }

  findByEmail(email: string): Author | undefined {
    const row = this.#byEmail.get(email);
    return row ? toAuthor(asRow<AuthorRow>(row)) : undefined;
  }

  list(options: ListOptions = {}): Author[] {
    const { after = 0, limit = 50, activeOnly = false } = options;
    // KEYSET pagination: WHERE id > ?, not OFFSET. OFFSET walks the rows it
    // skips, and shifts if a row is inserted mid-pagination (§4).
    const sql = activeOnly
      ? "SELECT * FROM authors WHERE id > ? AND active = 1 ORDER BY id LIMIT ?"
      : "SELECT * FROM authors WHERE id > ? ORDER BY id LIMIT ?";
    return asRows<AuthorRow>(this.#db.prepare(sql).all(after, limit)).map(toAuthor);
  }

  listWithPosts(options: ListOptions = {}): AuthorWithPosts[] {
    // Query 1: the authors.
    const authors = this.list(options);
    if (authors.length === 0) return [];

    // Query 2: ALL their posts, in one IN (...). This is the N+1 fix (§2).
    // IN rather than a JOIN so the author columns are not repeated once
    // per post.
    const ids = authors.map((a) => a.id);
    const posts = this.#postsFor(ids);

    const byAuthor = new Map<number, Post[]>();
    for (const post of posts) {
      byAuthor.set(post.authorId, [...(byAuthor.get(post.authorId) ?? []), post]);
    }

    // An author with no posts still appears, with an empty array.
    return authors.map((a) => ({ ...a, posts: byAuthor.get(a.id) ?? [] }));
  }

  #postsFor(ids: readonly number[]): Post[] {
    if (ids.length === 0) return [];
    // A statement is tied to its placeholder COUNT, so cache by length —
    // most calls reuse the same page size (02-binding.ts §6).
    let stmt = this.#postsByAuthors.get(ids.length);
    if (!stmt) {
      const placeholders = ids.map(() => "?").join(",");
      stmt = this.#db.prepare(
        `SELECT * FROM posts WHERE author_id IN (${placeholders}) ORDER BY id`,
      );
      this.#postsByAuthors.set(ids.length, stmt);
    }
    return asRows<PostRow>(stmt.all(...ids)).map(toPost);
  }

  update(id: number, changes: { name?: string; active?: boolean }): Author {
    const current = this.getById(id); // throws NotFoundError if absent
    try {
      const row = this.#update.get(
        changes.name ?? current.name,
        (changes.active ?? current.active) ? 1 : 0,
        id,
      );
      return toAuthor(asRow<AuthorRow>(row));
    } catch (err) {
      return mapDbError(err, `author ${id}`);
    }
  }

  delete(id: number): void {
    // changes: 0 is NOT an error in SQLite — turn it into one if the caller
    // cares (01-basics.ts §2).
    const { changes } = this.#delete.run(id);
    if (changes === 0) throw new NotFoundError("author", id);
  }

  createWithPosts(input: CreateAuthorInput, titles: readonly string[]): AuthorWithPosts {
    // Synchronous by construction — no await can sneak in and interleave
    // another handler's statements into this transaction (04 §4).
    return transaction(this.#db, () => {
      const author = this.create(input);
      const posts = titles.map((title) => toPost(asRow<PostRow>(this.#insertPost.get(author.id, title))));
      return { ...author, posts };
    });
  }

  count(options: { activeOnly?: boolean } = {}): number {
    // COUNT in SQL. Pulling every row to count them in JS moves N rows
    // across the boundary to produce one number (06 §5).
    const sql = options.activeOnly
      ? "SELECT COUNT(*) AS n FROM authors WHERE active = 1"
      : "SELECT COUNT(*) AS n FROM authors";
    return (this.#db.prepare(sql).get() as { n: number }).n;
  }
}

export { ConflictError, NotFoundError, ValidationError };
