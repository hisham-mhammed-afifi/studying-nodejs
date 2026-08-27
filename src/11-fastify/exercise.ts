/**
 * EXERCISE 11 — A small Fastify API, done properly
 *
 * Every requirement here is one of this module's warnings turned into a
 * test. Get them all and you have the skeleton of a real service.
 *
 * Check yourself:  node scripts/test.ts 11
 * Solution:        ./solution.ts   (try first!)
 */

import type { FastifyInstance } from "fastify";

const TODO = (what: string): never => {
  throw new Error(`TODO: implement ${what}`);
};

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export interface Note {
  id: string;
  title: string;
  body: string;
  authorId: string;
  /** Internal. MUST NOT reach a client. */
  internalScore: number;
}

export interface Store {
  list(): Note[];
  get(id: string): Note | undefined;
  create(input: { title: string; body: string; authorId: string }): Note;
  remove(id: string): boolean;
}

/**
 * TASK 1 — `createStore`
 *
 * An in-memory store. Ids are sequential strings starting at "1".
 * `internalScore` is set to `title.length` — it just needs to exist so the
 * response schema has something to strip.
 */
export function createStore(): Store {
  return TODO("createStore");
}

export interface BuildOptions {
  store?: Store;
  /** A token that grants access. Default "secret". */
  token?: string;
  /** Collects log lines instead of writing them, so tests can inspect. */
  onLog?: (line: string) => void;
}

/**
 * TASK 2 — `buildApp`
 *
 * A FACTORY that returns a configured, NOT-yet-listening instance — so
 * production can `listen()` and tests can `inject()` (§7).
 *
 * ── Schemas ────────────────────────────────────────────────────────────
 *   GET  /health              → 200 { status: "ok" }        (no auth)
 *   GET  /notes               → 200 { items: Note[] }
 *   GET  /notes/:id           → 200 Note | 404 error
 *   POST /notes               → 201 Note | 400 error
 *   DELETE /notes/:id         → 204 (no body) | 404 error
 *
 *   The Note response schema exposes ONLY id, title, body, authorId.
 *   `internalScore` must never appear in a response — rely on the schema
 *   (03 §1), not on hand-picking fields.
 *
 *   POST /notes body:
 *     required title (string, 1..100) and body (string, max 10000);
 *     optional authorId (string, default "anonymous");
 *     additionalProperties: false — mass-assignment defence (02 §3).
 *
 *   GET /notes querystring: limit (integer, 1..100, default 10).
 *     Coercion must make req.query.limit a NUMBER (02 §4).
 *
 * ── Auth ───────────────────────────────────────────────────────────────
 *   Everything under /notes requires `authorization: Bearer <token>`.
 *   /health must NOT.
 *
 *   Two requirements that the tests check:
 *     • Use plugin ENCAPSULATION so the hook applies only to the notes
 *       routes — not a path check inside a global hook (04 §2).
 *     • Put it in `onRequest`, so an unauthenticated request never has its
 *       body read (05 §2).
 *
 *   Missing/!Bearer/wrong token → 401 { code: "UNAUTHORIZED" }.
 *
 * ── Errors ─────────────────────────────────────────────────────────────
 *   setErrorHandler is MANDATORY — the default leaks err.message (06 §1).
 *     • err.validation      → 400 { code: "VALIDATION", message: "…", details: [...] }
 *                             where details is [{ path, issue }, …]
 *                             ⚠ If your 400 route schema doesn't DECLARE
 *                             `details`, the allowlist strips it (03 §4).
 *     • AppError / statusCode < 500 → that status, { code, message }
 *     • anything else       → 500 { code: "INTERNAL", message: "internal server error" }
 *                             and the original message must NOT appear
 *   Every error is passed to `onLog` as `${method} ${url}: ${err.message}`.
 *
 *   setNotFoundHandler → 404 { code: "NOT_FOUND", message: … }
 *
 * ── Decoration ─────────────────────────────────────────────────────────
 *   The store is decorated as `app.store` and must be visible from the
 *   ROOT instance — so it needs fastify-plugin semantics, not a plain
 *   encapsulated plugin (04 §3). (fastify-plugin isn't installed; set
 *   `Symbol.for("skip-override")` on the plugin function, as the demo does.)
 */
export function buildApp(_options?: BuildOptions): FastifyInstance {
  return TODO("buildApp");
}
