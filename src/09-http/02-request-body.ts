/**
 * 02 — Reading request bodies safely
 *
 * Run:  node src/09-http/02-request-body.ts
 */

import type { IncomingMessage } from "node:http";
import { startServer, sendJson } from "./_helpers.ts";

const MAX = 1024; // deliberately tiny so the demo can exceed it

/** The correct shape: cap the size, decode ONCE at the end. */
async function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  // The client-declared length is a HINT. Reject obvious abuse cheaply…
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw Object.assign(new Error("content-length exceeds limit"), { statusCode: 413 });
  }

  // …but still count real bytes, because a hostile client will lie.
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    total += chunk.length;
    if (total > maxBytes) {
      // ⚠ Do NOT req.destroy() here. Destroying the socket kills the
      // connection before the response can be written, so the client sees a
      // network error instead of your 413 — see §5 below. Stop reading,
      // throw, and let the handler send a proper response with
      // `connection: close`.
      throw Object.assign(new Error(`body exceeded ${maxBytes} bytes`), { statusCode: 413 });
    }
    chunks.push(chunk);
  }
  // ONE allocation, and ONE decode point (module 04 §6, §7.1).
  return Buffer.concat(chunks, total);
}

interface ParsedType {
  mime: string;
  charset: string;
  params: Record<string, string>;
}

function parseContentType(header: string | undefined): ParsedType {
  const [type = "", ...rest] = (header ?? "").split(";");
  const params: Record<string, string> = {};
  for (const part of rest) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim().toLowerCase();
    // Values may be quoted: charset="utf-8"
    params[k] = part.slice(idx + 1).trim().replace(/^"|"$/g, "");
  }
  return { mime: type.trim().toLowerCase(), charset: params["charset"] ?? "utf-8", params };
}

const app = await startServer(async (req, res) => {
  try {
    if (req.url === "/raw") {
      const body = await readBody(req, MAX);
      sendJson(res, 200, { bytes: body.length, chars: body.toString("utf8").length });
      return;
    }

    if (req.url === "/json") {
      const ct = parseContentType(req.headers["content-type"]);
      if (ct.mime !== "application/json") {
        sendJson(res, 415, { error: "expected application/json", got: ct.mime || "(none)" });
        return;
      }
      const body = await readBody(req, MAX);
      if (body.length === 0) {
        // An empty body is NOT an empty object.
        sendJson(res, 400, { error: "empty body" });
        return;
      }
      try {
        sendJson(res, 200, { parsed: JSON.parse(body.toString(ct.charset as BufferEncoding)) });
      } catch (err) {
        sendJson(res, 400, { error: "invalid JSON", detail: (err as Error).message });
      }
      return;
    }

    if (req.url === "/form") {
      const body = await readBody(req, MAX);
      sendJson(res, 200, { fields: Object.fromEntries(new URLSearchParams(body.toString("utf8"))) });
      return;
    }

    if (req.url === "/naive") {
      // ✗ THE BUG: decoding each chunk independently.
      let text = "";
      for await (const chunk of req as AsyncIterable<Buffer>) text += chunk.toString();
      sendJson(res, 200, { text, hasReplacementChar: text.includes("�") });
      return;
    }

    res.statusCode = 404;
    res.end();
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (!res.headersSent) {
      // We stopped consuming the request body, so this connection cannot be
      // reused — there are unread bytes still arriving on it. Tell the client
      // to close it, and tear the socket down once the response has flushed.
      res.setHeader("connection", "close");
      sendJson(res, status, { error: (err as Error).message });
      res.on("finish", () => req.socket.destroy());
    }
  }
});

console.log("=== 1. There is no req.body ===");
console.log(`
  req.body is framework MIDDLEWARE (express.json(), fastify's parser), not
  something Node gives you. In plain Node the body is a stream that arrives
  AFTER the headers — which is the whole reason you can reject a 5GB upload
  by its headers without ever reading it.
`);

console.log("=== 2. Reading it, with a cap ===");
{
  const ok = await fetch(app.url("/raw"), { method: "POST", body: "hello world" });
  console.log("  small body →", ok.status, await ok.json());

  const tooBig = await fetch(app.url("/raw"), { method: "POST", body: "x".repeat(MAX + 500) });
  console.log("  oversized  →", tooBig.status, await tooBig.json());

  console.log(`
  Two checks, and you need BOTH:

    1. content-length, to reject cheaply before reading anything
    2. a running byte count, because content-length is client-supplied and
       a hostile client will simply lie about it
`);
}

console.log("=== 2b. ⚠ How you bail out matters ===");
console.log(`
  The obvious implementation destroys the request as soon as the limit is
  hit:

      if (total > maxBytes) {
        req.destroy();                  // ✗
        throw new PayloadTooLargeError();
      }

  I wrote exactly that first, and the client got:

      TypeError: fetch failed
        [cause]: SocketError: other side closed  (UND_ERR_SOCKET)

  …instead of a 413. Destroying the socket killed the connection BEFORE the
  response could be written, so the caller sees a network error and cannot
  tell "too large" from "server crashed". Every retry policy then treats it
  as a transient failure and sends the huge body again.

  The correct sequence:

      1. stop reading and throw
      2. write a real 413, with \`connection: close\` — the connection can't
         be reused, because unread request bytes are still arriving on it
      3. destroy the socket only AFTER the response has flushed:

             res.setHeader("connection", "close");
             sendJson(res, 413, { error: "payload too large" });
             res.on("finish", () => req.socket.destroy());

  Now the client gets a clean 413 and stops sending.
`);

console.log("=== 3. Chunk boundaries corrupt text ===");
{
  // Force a split mid-character by sending the bytes in two pieces.
  const full = Buffer.from("héllo 😀 wörld");
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(full.subarray(0, 9)); // cuts the emoji in half
      c.enqueue(full.subarray(9));
      c.close();
    },
  });

  const naive = (await (
    await fetch(app.url("/naive"), {
      method: "POST",
      body: stream,
      // `duplex` is required for a streaming request body and is missing from
      // the DOM RequestInit type that @types/node pulls in.
      duplex: "half",
    } as RequestInit & { duplex: "half" })
  ).json()) as { text: string; hasReplacementChar: boolean };
  console.log("  per-chunk toString() →", JSON.stringify(naive.text));
  console.log("  contains U+FFFD:", naive.hasReplacementChar, "✗");

  const correct = await (
    await fetch(app.url("/raw"), { method: "POST", body: "héllo 😀 wörld" })
  ).json();
  console.log("  concat-then-decode   →", correct, "✓ 18 bytes, 14 characters");

  console.log(`
  This is module 04 §6 arriving in production. It NEVER shows up in testing
  with English text — only when a real user posts in Arabic, Japanese, or
  with an emoji, at a size that happens to straddle a chunk boundary.

  Rule: never call .toString() on a chunk. Buffer.concat first.
`);
}

console.log("=== 4. Content types ===");
{
  const json = await fetch(app.url("/json"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "héllo", n: 42 }),
  });
  console.log("  application/json →", json.status, await json.json());

  const wrongType = await fetch(app.url("/json"), {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "{}",
  });
  console.log("  text/plain       →", wrongType.status, await wrongType.json());

  const badJson = await fetch(app.url("/json"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json}",
  });
  console.log("  malformed JSON   →", badJson.status, ((await badJson.json()) as { error: string }).error);

  const empty = await fetch(app.url("/json"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "",
  });
  console.log("  empty body       →", empty.status, ((await empty.json()) as { error: string }).error);

  const form = await fetch(app.url("/form"), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ user: "ada", role: "admin" }),
  });
  console.log("  urlencoded       →", form.status, await form.json());
}

console.log(`
  Content-Type parsing details that matter:
    • the header can carry parameters: "application/json; charset=utf-8"
    • parameter values may be QUOTED: charset="utf-8"
    • compare the mime type case-INSENSITIVELY
    • a wrong type is 415 Unsupported Media Type, not 400
    • malformed JSON is 400; an empty body is 400, not {}

  multipart/form-data is genuinely hard — nested boundaries, per-part
  headers, streaming file parts. Use busboy. Do not hand-roll it.
`);

await app.close();
