/** Shared helpers for the module 13 demos. */

import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Run `fn` with a throwaway FILE database, then delete it.
 *
 * A file database, not :memory:, because several lessons here (transaction
 * cost, journal modes, locking) only exist when there is a disk to sync to.
 */
export async function withFileDb<T>(fn: (db: DatabaseSync, file: string) => Promise<T> | T): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "node-study-sqlite-"));
  const file = path.join(dir, "app.db");
  const db = new DatabaseSync(file);
  try {
    return await fn(db, file);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

/** An in-memory database, for demos where the disk is irrelevant. */
export function memoryDb(): DatabaseSync {
  return new DatabaseSync(":memory:");
}

/**
 * BEGIN / COMMIT / ROLLBACK around a SYNCHRONOUS function.
 *
 * Deliberately not async: an await inside a transaction lets other work
 * interleave on the same connection, and you can end up committing someone
 * else's half-finished changes. Do async work BEFORE you BEGIN.
 */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Already rolled back by SQLite (e.g. on a fatal error). Ignore, so
      // the ORIGINAL error is what propagates.
    }
    throw err;
  }
}

/** node:sqlite's error shape. `code` is always ERR_SQLITE_ERROR; errcode varies. */
export interface SqliteError extends Error {
  code?: string;
  errcode?: number;
  errstr?: string;
}

export function isSqliteError(err: unknown): err is SqliteError {
  return err instanceof Error && (err as SqliteError).code === "ERR_SQLITE_ERROR";
}

/** The constraint codes worth knowing by name. */
export const SQLITE = {
  BUSY: 5,
  CONSTRAINT_FOREIGNKEY: 787,
  CONSTRAINT_NOTNULL: 1299,
  CONSTRAINT_UNIQUE: 2067,
  CONSTRAINT_CHECK: 275,
} as const;
