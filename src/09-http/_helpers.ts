/** Shared helpers for the module 09 demos. */

import { createServer, type IncomingMessage, type RequestListener, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

export interface TestServer {
  server: Server;
  port: number;
  url: (path?: string) => string;
  close: () => Promise<void>;
}

/**
 * Starts a throwaway server on an ephemeral port (0 = let the OS choose).
 * Always closes with closeAllConnections() so a demo can't hang on an idle
 * keep-alive socket — that trap gets its own section in 05-errors-shutdown.
 */
export async function startServer(
  handler: RequestListener,
  configure?: (server: Server) => void,
): Promise<TestServer> {
  const server = createServer(handler);
  configure?.(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const { port } = server.address() as AddressInfo;

  return {
    server,
    port,
    url: (p = "/") => `http://127.0.0.1:${port}${p}`,
    close: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}

/** Narrow `unknown` to a Node errno error. */
export function isErrno(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

/** Read a whole request body with a hard byte cap. Used by several demos. */
export async function readBodyCapped(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    total += chunk.length;
    if (total > maxBytes) {
      req.destroy();
      throw Object.assign(new Error(`body exceeded ${maxBytes} bytes`), { statusCode: 413 });
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

/** Send JSON with a correct byte-length header. */
export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  // Buffer.byteLength, never .length — module 04 §3.1.
  res.setHeader("content-length", Buffer.byteLength(payload));
  res.end(payload);
}
