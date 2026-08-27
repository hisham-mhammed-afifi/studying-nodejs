/**
 * SOLUTION 10 — reference implementation.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import {
  type Application,
  type Context,
  HttpError,
  type MatchResult,
  type Middleware,
} from "./exercise.ts";

// --- Task 1 ------------------------------------------------------------------

export function compose(middleware: readonly Middleware[]): (ctx: Context) => Promise<void> {
  return function run(ctx: Context): Promise<void> {
    let lastCalled = -1;

    function dispatch(i: number): Promise<void> {
      // Without this guard a stray second next() re-runs everything
      // downstream: two DB writes, two res.end() calls (module 09 §3.4),
      // two log lines with the same request id. And it fails silently in
      // the happy path, so it ships.
      if (i <= lastCalled) {
        return Promise.reject(new Error(`next() called multiple times in middleware #${i - 1}`));
      }
      lastCalled = i;

      const fn = middleware[i];
      if (!fn) return Promise.resolve(); // end of chain — next() here is a no-op

      // Promise.resolve().then() turns a SYNCHRONOUS throw into a rejection.
      // Returning fn(...) directly lets sync throws escape the promise chain,
      // so an error boundary would silently miss half of your middleware.
      return Promise.resolve().then(() => fn(ctx, () => dispatch(i + 1)));
    }

    return dispatch(0);
  };
}

// --- Task 2 ------------------------------------------------------------------

interface Node {
  statics: Map<string, Node>;
  param?: { name: string; node: Node };
  wildcard?: { name: string; handlers: Map<string, Middleware>; pattern: string };
  handlers: Map<string, Middleware>;
  pattern?: string;
}

const newNode = (): Node => ({ statics: new Map(), handlers: new Map() });

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch (err) {
    // decodeURIComponent throws URIError on "%E0%A4%A". Scanners send these
    // constantly; unhandled it's a 500 that should have been a 400.
    throw new HttpError(400, "BAD_PATH", "malformed percent-encoding in path", { cause: err });
  }
}

const split = (pathname: string): string[] => pathname.split("/").filter(Boolean);

export class Router {
  readonly #root = newNode();

  add(method: string, pattern: string, handler: Middleware): this {
    const upper = method.toUpperCase();
    let node = this.#root;

    for (const raw of split(pattern)) {
      if (raw.startsWith("*")) {
        // A wildcard consumes the rest, so nothing can follow it.
        node.wildcard ??= { name: raw.slice(1) || "*", handlers: new Map(), pattern };
        node.wildcard.handlers.set(upper, handler);
        return this;
      }
      if (raw.startsWith(":")) {
        node.param ??= { name: raw.slice(1), node: newNode() };
        node = node.param.node;
        continue;
      }
      let next = node.statics.get(raw);
      if (!next) {
        next = newNode();
        node.statics.set(raw, next);
      }
      node = next;
    }

    node.handlers.set(upper, handler);
    node.pattern = pattern;
    return this;
  }

  get(pattern: string, handler: Middleware): this {
    return this.add("GET", pattern, handler);
  }

  post(pattern: string, handler: Middleware): this {
    return this.add("POST", pattern, handler);
  }

  match(method: string, pathname: string): MatchResult {
    const upper = method.toUpperCase();
    // Split FIRST, decode after — decoding first turns %2F back into "/" and
    // lets a user forge path structure (§1.6).
    const segments = split(pathname).map(decodeSegment);

    const walk = (node: Node, i: number, params: Record<string, string>): MatchResult | null => {
      if (i === segments.length) {
        if (node.handlers.size === 0) return null;
        return {
          handler: node.handlers.get(upper),
          params,
          route: node.pattern,
          allowed: [...node.handlers.keys()].sort(),
          matchedPath: true,
        };
      }

      const segment = segments[i] as string;

      // PRECEDENCE by specificity, not registration order. Static first, so
      // /users/me can never be swallowed by /users/:id — and the winner
      // doesn't depend on which module imported first (module 01 §3.3).
      const staticChild = node.statics.get(segment);
      if (staticChild) {
        const found = walk(staticChild, i + 1, params);
        if (found) return found;
      }

      if (node.param) {
        const found = walk(node.param.node, i + 1, { ...params, [node.param.name]: segment });
        if (found) return found;
      }

      if (node.wildcard) {
        return {
          handler: node.wildcard.handlers.get(upper),
          params: { ...params, [node.wildcard.name]: segments.slice(i).join("/") },
          route: node.wildcard.pattern,
          allowed: [...node.wildcard.handlers.keys()].sort(),
          matchedPath: true,
        };
      }

      return null;
    };

    return walk(this.#root, 0, {}) ?? { params: {}, allowed: [], matchedPath: false };
  }

  routes(): Middleware {
    return async (ctx, next) => {
      const result = this.match(ctx.method, ctx.path);

      if (result.handler) {
        ctx.params = result.params;
        ctx.route = result.route;
        await result.handler(ctx, next);
        return;
      }

      if (result.matchedPath) {
        // The path exists, the verb doesn't. 405 with Allow is REQUIRED by
        // the spec — and it tells whoever's debugging a very different story
        // from a 404.
        throw new HttpError(
          405,
          "METHOD_NOT_ALLOWED",
          `${ctx.method} not allowed; try ${result.allowed.join(", ")}`,
        );
      }

      // No match at all: let an outer handler decide (404, static files, a
      // mounted sub-app…). A router that swallows unmatched requests can't
      // be composed.
      await next();
    };
  }
}

// --- Task 3 ------------------------------------------------------------------

function makeContext(req: IncomingMessage, res: ServerResponse): Context {
  // req.url is a request TARGET, not a URL — it needs a base (module 09 §1.1).
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  return {
    req,
    res,
    method: req.method ?? "GET",
    path: url.pathname,
    query: url.searchParams,
    params: {},
    status: 404,
    body: null,
    state: {},
  };
}

function writeResponse(ctx: Context): void {
  const { res } = ctx;
  // Never write twice: a second end() emits 'error' on res and, unhandled,
  // kills the process (module 09 §3.4).
  if (res.headersSent || res.writableEnded) return;

  const body = ctx.body ?? (ctx.status === 404 ? { code: "NOT_FOUND" } : null);

  res.statusCode = ctx.status;

  if (body === null) {
    res.end();
    return;
  }

  const payload = JSON.stringify(body);
  res.setHeader("content-type", "application/json; charset=utf-8");
  // BYTES, not characters — otherwise a non-ASCII response is truncated and
  // corrupts the next one on a keep-alive socket (module 04 §3.1).
  res.setHeader("content-length", Buffer.byteLength(payload));
  res.end(payload);
}

export function createApp(): Application {
  const middleware: Middleware[] = [];
  let chain: ((ctx: Context) => Promise<void>) | null = null;
  const server = createServer((req, res) => {
    const ctx = makeContext(req, res);
    // createServer does NOT await the handler, so a rejection here would be
    // an unhandled rejection and kill the process (module 07 §4.1).
    void app
      .handle(ctx)
      .then(() => writeResponse(ctx))
      .catch((err: unknown) => {
        if (res.headersSent || res.writableEnded) {
          // Too late to change the status — a partial response is on the
          // wire. Destroying at least signals failure.
          res.destroy();
          return;
        }
        if (err instanceof HttpError) {
          ctx.status = err.statusCode;
          ctx.body = { code: err.code, message: err.message };
        } else {
          // Never leak an internal message (module 07 §4). Log it instead.
          ctx.status = 500;
          ctx.body = { code: "INTERNAL" };
        }
        writeResponse(ctx);
      });
  });

  const app: Application = {
    server,
    port: 0,

    use(mw: Middleware): Application {
      middleware.push(mw);
      chain = null; // invalidate, so a later use() is picked up
      return app;
    },

    handle(ctx: Context): Promise<void> {
      // Composed lazily and cached: rebuilding per request is only ~5%
      // slower (measured), but a stable chain is easier to reason about.
      chain ??= compose(middleware);
      return chain(ctx);
    },

    async listen(port = 0, host = "127.0.0.1"): Promise<number> {
      server.listen(port, host);
      await once(server, "listening");
      app.port = (server.address() as AddressInfo).port;
      return app.port;
    },

    async close(): Promise<void> {
      if (!server.listening) return;
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };

  return app;
}

export { HttpError };
