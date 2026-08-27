/**
 * SOLUTION 09 — reference implementation.
 */

import { createServer, type IncomingMessage, type RequestListener, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import {
  type ContentType,
  type GracefulServer,
  HttpError,
  type ParseJsonOptions,
  type ReadBodyOptions,
} from "./exercise.ts";

// --- Task 1 ------------------------------------------------------------------

export function parseContentType(header: string | undefined): ContentType {
  const [rawMime = "", ...rest] = (header ?? "").split(";");
  const params: Record<string, string> = {};

  for (const part of rest) {
    const idx = part.indexOf("=");
    if (idx === -1) continue; // tolerate a trailing ";" or a bare token
    const key = part.slice(0, idx).trim().toLowerCase();
    if (key === "") continue;
    // Values may be quoted: boundary="--x--". Strip only matching quotes.
    const value = part.slice(idx + 1).trim().replace(/^"(.*)"$/s, "$1");
    params[key] = value;
  }

  return {
    mime: rawMime.trim().toLowerCase(),
    charset: (params["charset"] ?? "utf-8").toLowerCase(),
    params,
  };
}

// --- Task 2 ------------------------------------------------------------------

export async function readBody(req: IncomingMessage, options: ReadBodyOptions): Promise<Buffer> {
  const { maxBytes } = options;

  // Cheap rejection first: if the client TELLS us it's too big, believe it
  // and stop before reading a single byte.
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new HttpError(413, "PAYLOAD_TOO_LARGE", `body exceeds ${maxBytes} bytes`);
  }

  const chunks: Buffer[] = [];
  let total = 0;

  try {
    for await (const chunk of req as AsyncIterable<Buffer>) {
      total += chunk.length;
      if (total > maxBytes) {
        // ⚠ NOT req.destroy(). Destroying the socket here kills the
        // connection before the 413 can be written, and the caller sees an
        // opaque socket error — indistinguishable from a crash, and
        // retryable-looking, so they send the huge body again.
        throw new HttpError(413, "PAYLOAD_TOO_LARGE", `body exceeds ${maxBytes} bytes`);
      }
      chunks.push(chunk);
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    // The iterator rejects if the client vanished mid-upload.
    throw new HttpError(400, "ABORTED", "request aborted", { cause: err });
  }

  // ONE allocation of exactly the right size (module 04 §7.1), and one
  // decode point later — never per chunk (module 04 §6).
  return Buffer.concat(chunks, total);
}

// --- Task 3 ------------------------------------------------------------------

function isJsonMime(mime: string): boolean {
  // application/json, application/ld+json, application/vnd.api+json, …
  return mime === "application/json" || mime.endsWith("+json");
}

export async function parseJsonBody<T = unknown>(
  req: IncomingMessage,
  options: ParseJsonOptions,
): Promise<T | undefined> {
  const { required = true } = options;
  const ct = parseContentType(req.headers["content-type"]);

  if (!isJsonMime(ct.mime)) {
    // 415, not 400: the request is well-formed, we just don't speak that type.
    throw new HttpError(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      `expected application/json, got ${ct.mime || "(none)"}`,
    );
  }

  const body = await readBody(req, options); // 413 propagates unchanged

  if (body.length === 0) {
    // An empty body is NOT {}. Silently returning an empty object is how a
    // PATCH with a dropped payload becomes "update nothing, report success".
    if (required) throw new HttpError(400, "EMPTY_BODY", "request body is empty");
    return undefined;
  }

  let text: string;
  try {
    text = body.toString(ct.charset as BufferEncoding);
  } catch {
    text = body.toString("utf8"); // unknown charset → best effort
  }

  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new HttpError(400, "INVALID_JSON", "request body is not valid JSON", { cause: err });
  }
}

// --- Task 4 ------------------------------------------------------------------

const BODYLESS_STATUSES = new Set([204, 304]);

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string | number> = {},
): boolean {
  // Guard first. A second end() emits 'error' (ERR_STREAM_WRITE_AFTER_END),
  // and an unhandled 'error' on an EventEmitter crashes the process
  // (module 03 §2). This one check prevents a whole class of outage.
  if (res.writableEnded || res.headersSent) return false;

  res.statusCode = status;
  for (const [name, value] of Object.entries(headers)) {
    res.setHeader(name.toLowerCase(), value);
  }

  if (BODYLESS_STATUSES.has(status)) {
    // 204/304 must carry no body and no content-length.
    res.removeHeader("content-type");
    res.removeHeader("content-length");
    res.end();
    return true;
  }

  const payload = JSON.stringify(body ?? null);
  res.setHeader("content-type", "application/json; charset=utf-8");
  // BYTES, not characters. "héllo".length is 5 but it's 6 bytes — declaring
  // 5 truncates the response and corrupts the next one on a keep-alive
  // socket (module 04 §3.1).
  res.setHeader("content-length", Buffer.byteLength(payload));
  res.end(payload);
  return true;
}

// --- Task 5 ------------------------------------------------------------------

export function createGracefulServer(handler: RequestListener): GracefulServer {
  let healthy = false;
  let shutdownPromise: Promise<void> | null = null;

  const server = createServer((req, res) => {
    // createServer does NOT await the handler, so an async rejection would
    // be an unhandled rejection and kill the process (module 07 §4.1).
    // Promise.resolve() normalises sync throws into the same path.
    void Promise.resolve()
      .then(() => handler(req, res))
      .catch((err: unknown) => {
        if (res.headersSent) {
          // Too late to change the status — a partial 200 is already on the
          // wire. Destroying at least signals failure instead of delivering
          // a truncated body that looks successful.
          res.destroy();
          return;
        }
        if (err instanceof HttpError) {
          sendJson(res, err.statusCode, { code: err.code, message: err.message });
        } else {
          // Never leak an internal message or stack to a client
          // (module 07 §4). Log it; send an opaque code.
          sendJson(res, 500, { code: "INTERNAL", message: "internal server error" });
        }
      });
  });

  const api: GracefulServer = {
    server,
    port: 0,

    get healthy() {
      return healthy;
    },

    async listen(port = 0, host = "127.0.0.1"): Promise<number> {
      server.listen(port, host);
      await once(server, "listening");
      api.port = (server.address() as AddressInfo).port;
      healthy = true;
      return api.port;
    },

    shutdown(options = {}): Promise<void> {
      // Idempotent: hand back the SAME promise so two SIGTERMs can't race
      // two shutdown sequences.
      shutdownPromise ??= doShutdown(options.graceMs ?? 10_000);
      return shutdownPromise;
    },
  };

  async function doShutdown(graceMs: number): Promise<void> {
    // Fail the health check FIRST, so a load balancer stops routing here
    // before anything closes.
    healthy = false;

    if (!server.listening && server.connections === 0) return;

    const closed = once(server, "close");
    server.close();

    // THE non-obvious part. closeIdleConnections() only closes sockets that
    // are idle AT THAT INSTANT. Called once at the start of shutdown it does
    // nothing — the socket is still busy — and then the request finishes,
    // the socket goes idle, and it holds the server for the full
    // keepAliveTimeout (5s by default). Measured: 6174ms vs 202ms.
    const sweeper = setInterval(() => server.closeIdleConnections(), 20);

    // Hard deadline for genuinely stuck requests. This DOES kill in-flight
    // work, so it must be last resort, not the primary mechanism.
    const deadline = setTimeout(() => server.closeAllConnections(), graceMs);

    try {
      await closed;
    } finally {
      clearInterval(sweeper);
      clearTimeout(deadline);
    }
  }

  return api;
}

// Re-exported so tests can construct one without importing two modules.
export { HttpError };
export type { Server };
