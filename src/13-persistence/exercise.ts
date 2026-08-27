/**
 * EXERCISE 13 — A repository layer
 *
 * The boundary between "SQL and driver quirks" and "your domain model".
 * Every requirement is one of this module's warnings turned into a test.
 *
 * Check yourself:  node scripts/test.ts 13
 * Solution:        ./solution.ts   (try first!)
 */

import type { DatabaseSync } from "node:sqlite";

const TODO = (what: string): never => {
  throw new Error(`TODO: implement ${what}`);
};

// ─── Domain types: what the rest of the app sees ────────────────────────────
// Note these are JS-shaped: real booleans, real Dates, nested posts. The
// repository's whole job is turning driver rows into these.

export interface Author {
  id: number;
  email: string;
  name: string;
  active: boolean;
  createdAt: Date;
}

export interface Post {
  id: number;
  authorId: number;
  title: string;
  published: boolean;
}

export interface AuthorWithPosts extends Author {
  posts: Post[];
}

// ─── Errors: the domain's vocabulary, not the driver's ──────────────────────

export class NotFoundError extends Error {
  override readonly name = "NotFoundError";
  constructor(what: string, id: number | string) {
    super(`${what} ${id} not found`);
  }
}

export class ConflictError extends Error {
  override readonly name = "ConflictError";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

export class ValidationError extends Error {
  override readonly name = "ValidationError";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/**
 * TASK 1 — `migrate`
 *
 * Apply the schema below, idempotently.
 *
 *   authors: id INTEGER PK, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
 *            active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
 *   posts:   id INTEGER PK, author_id INTEGER NOT NULL REFERENCES authors(id)
 *            ON DELETE CASCADE, title TEXT NOT NULL,
 *            published INTEGER NOT NULL DEFAULT 0
 *   index:   idx_posts_author ON posts(author_id)
 *
 * Requirements:
 *   - Records applied migrations in a `_migrations` table (name, applied).
 *   - Calling it twice applies nothing the second time.
 *   - Each migration runs in its own TRANSACTION, so a failure leaves
 *     neither a partial schema nor a bookkeeping row (§5 of the demos).
 *   - Returns the names it applied THIS call, in order.
 */
export function migrate(_db: DatabaseSync): string[] {
  return TODO("migrate");
}

export interface CreateAuthorInput {
  email: string;
  name: string;
  active?: boolean;
}

export interface ListOptions {
  /** Keyset pagination: return authors with id > after. */
  after?: number;
  limit?: number;
  /** Only active authors. */
  activeOnly?: boolean;
}

/**
 * TASK 2 — `AuthorRepository`
 *
 * Requirements that the tests check:
 *
 *   PREPARED STATEMENTS
 *     Prepare every statement ONCE in the constructor, not per call (§4).
 *
 *   MAPPING
 *     - active: stored 0/1, exposed as a real boolean. Binding `true`
 *       throws, so convert (§3.2).
 *     - createdAt: stored as an ISO string, exposed as a Date (§3.6).
 *     - Returned objects must be ORDINARY objects — a caller doing
 *       `result instanceof Object` or `result.hasOwnProperty(...)` must
 *       work, which a raw row does not (§3.4).
 *     - Never expose column names (author_id) — the domain says authorId.
 *
 *   ERRORS
 *     Map driver errors at THIS boundary (§3.5), so no SQLite error and no
 *     SQL ever escapes:
 *       UNIQUE (2067)      → ConflictError
 *       FOREIGN KEY (787)  → ValidationError
 *       NOT NULL (1299)    → ValidationError
 *     A missing row on get/update/delete → NotFoundError.
 *
 *   QUERIES
 *     - listWithPosts must NOT be N+1: at most TWO queries regardless of
 *       how many authors are returned (§2). An author with no posts still
 *       appears, with `posts: []`.
 *     - list uses KEYSET pagination (`id > after`), not OFFSET (§4).
 *
 *   TRANSACTIONS
 *     - createWithPosts inserts an author and their posts ATOMICALLY: if
 *       any post fails, the author must not exist either (§3).
 */
export class AuthorRepository {
  constructor(_db: DatabaseSync) {
    TODO("AuthorRepository constructor");
  }

  create(_input: CreateAuthorInput): Author {
    return TODO("AuthorRepository#create");
  }

  /** Throws NotFoundError if absent. */
  getById(_id: number): Author {
    return TODO("AuthorRepository#getById");
  }

  /** Returns undefined if absent — for callers that expect a miss. */
  findByEmail(_email: string): Author | undefined {
    return TODO("AuthorRepository#findByEmail");
  }

  list(_options?: ListOptions): Author[] {
    return TODO("AuthorRepository#list");
  }

  /** At most TWO queries total. */
  listWithPosts(_options?: ListOptions): AuthorWithPosts[] {
    return TODO("AuthorRepository#listWithPosts");
  }

  /** Partial update. Throws NotFoundError if the author does not exist. */
  update(_id: number, _changes: { name?: string; active?: boolean }): Author {
    return TODO("AuthorRepository#update");
  }

  /** Throws NotFoundError if nothing was deleted. */
  delete(_id: number): void {
    return TODO("AuthorRepository#delete");
  }

  /** Atomic: the author and every post, or neither. */
  createWithPosts(_input: CreateAuthorInput, _titles: readonly string[]): AuthorWithPosts {
    return TODO("AuthorRepository#createWithPosts");
  }

  /** How many authors exist. Must be computed by SQL, not by counting rows in JS. */
  count(_options?: { activeOnly?: boolean }): number {
    return TODO("AuthorRepository#count");
  }
}
