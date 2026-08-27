/**
 * EXERCISE 10 — Build the framework
 *
 * A trie router, a middleware engine, and an application that wires them to
 * node:http. About 200 lines for the parts of Express you actually use.
 *
 * Check yourself:  node scripts/test.ts 10
 * Solution:        ./solution.ts   (try first!)
 */

import type { IncomingMessage, Server, ServerResponse } from "node:http";

const TODO = (what: string): never => {
  throw new Error(`TODO: implement ${what}`);
};

export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;
  constructor(statusCode: number, code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export interface Context {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly method: string;
  /** Pathname only, no query string. */
  readonly path: string;
  readonly query: URLSearchParams;
  /** Decoded route parameters. Empty until the router matches. */
  params: Record<string, string>;
  /** The matched PATTERN ("/users/:id") — for metrics. Undefined if unmatched. */
  route?: string;
  status: number;
  body: unknown;
  /** Middleware scratch space. */
  state: Record<string, unknown>;
}

export type Next = () => Promise<void>;
export type Middleware = (ctx: Context, next: Next) => Promise<void> | void;

/**
 * TASK 1 — `compose`
 *
 * Turn a list of middleware into one function (the onion, §2.2).
 *
 * Requirements:
 *   - Runs them in order; each `next()` invokes the following one.
 *   - `next()` from the LAST middleware resolves — never throws.
 *   - A SYNCHRONOUS throw becomes a rejection, so one `.catch()` covers both.
 *   - Calling `next()` twice in one middleware REJECTS with an Error whose
 *     message contains "multiple times". (Otherwise everything downstream
 *     runs twice — two DB writes, two res.end() calls.)
 *   - Errors propagate outward through every `await next()`.
 *   - An empty array resolves.
 */
export function compose(_middleware: readonly Middleware[]): (ctx: Context) => Promise<void> {
  return TODO("compose");
}

export interface MatchResult {
  handler?: Middleware;
  params: Record<string, string>;
  route?: string;
  /** Methods registered at this path — for a 405's Allow header. */
  allowed: string[];
  /** True if the PATH matched, even when the method didn't. */
  matchedPath: boolean;
}

/**
 * TASK 2 — `Router`
 *
 * A trie. Segment kinds: static, `:param`, `*wildcard`.
 *
 * Requirements:
 *   - `add(method, pattern, handler)`; method is uppercased.
 *   - PRECEDENCE by specificity, NOT registration order:
 *         static  >  :param  >  *wildcard
 *     So "/users/me" wins over "/users/:id" however they were registered.
 *   - Params are DECODED. Split on "/" FIRST, then decode each segment —
 *     decoding first lets "%2F" forge a path separator (§1.6).
 *   - Malformed percent-encoding → HttpError(400, "BAD_PATH", …).
 *     `decodeURIComponent` throws URIError; never let that reach a handler.
 *   - A wildcard captures the remaining path, joined with "/", decoded.
 *   - `match()` distinguishes "no such path" from "wrong method":
 *       • nothing matched          → matchedPath: false, allowed: []
 *       • path matched, method not → matchedPath: true, allowed: [...]
 *   - `allowed` is sorted, for stable output.
 *   - Trailing slashes are ignored ("/users/" === "/users").
 *   - `routes()` returns a Middleware that matches, sets ctx.params and
 *     ctx.route, and calls the handler; on no match it calls next() so an
 *     outer 404 handler can run.
 */
export class Router {
  add(_method: string, _pattern: string, _handler: Middleware): this {
    return TODO("Router#add");
  }

  get(_pattern: string, _handler: Middleware): this {
    return TODO("Router#get");
  }

  post(_pattern: string, _handler: Middleware): this {
    return TODO("Router#post");
  }

  match(_method: string, _pathname: string): MatchResult {
    return TODO("Router#match");
  }

  routes(): Middleware {
    return TODO("Router#routes");
  }
}

export interface Application {
  use(mw: Middleware): Application;
  /** For tests: run the chain against a fake context, without a socket. */
  handle(ctx: Context): Promise<void>;
  listen(port?: number, host?: string): Promise<number>;
  close(): Promise<void>;
  readonly server: Server;
  /** Set by listen(). Mutable so the implementation can fill it in. */
  port: number;
}

/**
 * TASK 3 — `createApp`
 *
 * Wire the middleware chain to node:http.
 *
 * Requirements:
 *   - `use()` appends; the chain is composed lazily on first request (so
 *     order of registration is what matters, not order of composition).
 *   - Builds a Context: method, path (pathname only), query, empty params,
 *     status 404, body null, state {}.
 *   - After the chain resolves, WRITES the response from ctx.status/ctx.body:
 *       • body null/undefined → an empty body, and 404 → {"code":"NOT_FOUND"}
 *       • otherwise JSON, with a correct BYTE content-length (module 04 §3.1)
 *       • never write if headers were already sent or the response ended
 *   - Catches everything:
 *       • HttpError      → its statusCode + { code, message }
 *       • anything else  → 500 + { code: "INTERNAL" }, message NEVER leaked
 *       • headers already sent → destroy the socket (module 09 §3.1)
 *   - An async handler rejection must NOT become an unhandled rejection.
 *   - `handle(ctx)` runs the chain only — for unit tests, no socket needed.
 */
export function createApp(): Application {
  return TODO("createApp");
}
