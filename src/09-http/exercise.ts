/**
 * EXERCISE 09 — The HTTP toolkit every service needs
 *
 * These five utilities are what a framework's "body parser" and "graceful
 * shutdown plugin" actually are.
 *
 * Check yourself:  node scripts/test.ts 09
 * Solution:        ./solution.ts   (try first!)
 */

import type { IncomingMessage, RequestListener, Server, ServerResponse } from "node:http";

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

export interface ContentType {
  /** Lowercased mime type, e.g. "application/json". "" if absent. */
  mime: string;
  /** Lowercased charset, defaulting to "utf-8". */
  charset: string;
  /** All other parameters, lowercased keys, unquoted values. */
  params: Record<string, string>;
}

/**
 * TASK 1 — `parseContentType`
 *
 * "application/json; charset=UTF-8"       → { mime: "application/json", charset: "utf-8" }
 * 'multipart/form-data; boundary="--x--"' → params.boundary === "--x--"
 * undefined                               → { mime: "", charset: "utf-8", params: {} }
 *
 * Requirements:
 *   - mime and parameter KEYS lowercased; the mime trimmed.
 *   - Parameter VALUES keep their case, but lose surrounding double quotes.
 *   - charset lowercased, defaulting to "utf-8".
 *   - Tolerate extra whitespace and a trailing ";".
 */
export function parseContentType(_header: string | undefined): ContentType {
  return TODO("parseContentType");
}

export interface ReadBodyOptions {
  /** Hard cap. Exceeding it throws a 413 HttpError. */
  maxBytes: number;
}

/**
 * TASK 2 — `readBody`
 *
 * Read the whole request body as a Buffer, safely.
 *
 * Requirements:
 *   - Reject early when `content-length` already exceeds maxBytes (cheap),
 *     with HttpError(413, "PAYLOAD_TOO_LARGE").
 *   - ALSO count real bytes — content-length is client-supplied and can lie.
 *   - ⚠ Do NOT req.destroy() when bailing. That kills the connection before
 *     a 413 can be written, and the client sees a socket error instead of
 *     your status code. Just stop reading and throw; `sendJson` + the
 *     caller handle the connection teardown.
 *   - Exactly ONE Buffer.concat — no O(n²) accumulation (module 04 §7.1).
 *   - An empty body returns a zero-length Buffer, not an error.
 *   - If the request is aborted mid-read, throw HttpError(400, "ABORTED").
 */
export function readBody(_req: IncomingMessage, _options: ReadBodyOptions): Promise<Buffer> {
  return TODO("readBody");
}

export interface ParseJsonOptions extends ReadBodyOptions {
  /** Reject an empty body instead of returning undefined. Default true. */
  required?: boolean;
}

/**
 * TASK 3 — `parseJsonBody`
 *
 * Requirements:
 *   - Wrong/absent content-type → HttpError(415, "UNSUPPORTED_MEDIA_TYPE").
 *     Accept "application/json" and any "+json" suffix (application/ld+json).
 *   - Empty body + required → HttpError(400, "EMPTY_BODY").
 *     Empty body + !required → undefined.
 *   - Invalid JSON → HttpError(400, "INVALID_JSON"), with the parse error
 *     as `cause`.
 *   - Honours the charset parameter when decoding.
 *   - Propagates readBody's 413 unchanged.
 */
export function parseJsonBody<T = unknown>(
  _req: IncomingMessage,
  _options: ParseJsonOptions,
): Promise<T | undefined> {
  return TODO("parseJsonBody");
}

/**
 * TASK 4 — `sendJson`
 *
 * Requirements:
 *   - Sets status, `content-type: application/json; charset=utf-8`, and a
 *     CORRECT `content-length` — bytes, not characters (module 04 §3.1).
 *   - Merges any extra headers (lowercased keys).
 *   - Is a NO-OP if the response is already ended or headers already sent.
 *     A second end() emits an 'error' that crashes the process (§3.4).
 *   - 204 and 304 must send NO body and no content-length.
 *   - Returns true if it wrote, false if it was a no-op.
 */
export function sendJson(
  _res: ServerResponse,
  _status: number,
  _body: unknown,
  _headers?: Record<string, string | number>,
): boolean {
  return TODO("sendJson");
}

export interface GracefulServer {
  server: Server;
  /** The bound port. Only valid after listen(). */
  port: number;
  listen(port?: number, host?: string): Promise<number>;
  /**
   * Stop accepting, drain in-flight requests, then close.
   * Resolves once the server is fully closed.
   */
  shutdown(options?: { graceMs?: number }): Promise<void>;
  /** Flips false as soon as shutdown starts, for a health endpoint. */
  readonly healthy: boolean;
}

/**
 * TASK 5 — `createGracefulServer`
 *
 * Requirements:
 *   - Wraps `handler`, catching BOTH sync throws and async rejections —
 *     createServer does not await your handler, so a rejection is an
 *     unhandled rejection that kills the process (module 07 §4.1).
 *   - An HttpError → its statusCode and `{ code, message }`.
 *     Anything else → 500 `{ code: "INTERNAL" }`, never leaking the message.
 *   - If headers were already sent, destroy the socket instead — you cannot
 *     turn a 200 into a 500.
 *   - `healthy` is true after listen(), false from the moment shutdown starts.
 *   - shutdown() must:
 *       a) stop accepting new connections,
 *       b) let in-flight requests FINISH,
 *       c) REPEATEDLY closeIdleConnections() — calling it once does nothing,
 *          because a socket that is busy now goes idle a moment later and
 *          then holds the server for the full keepAliveTimeout (§7),
 *       d) closeAllConnections() after graceMs as a hard deadline,
 *       e) be idempotent.
 */
export function createGracefulServer(_handler: RequestListener): GracefulServer {
  return TODO("createGracefulServer");
}
