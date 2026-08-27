/**
 * 03 — Writing responses
 *
 * Run:  node src/09-http/03-responses.ts
 */

import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer, sendJson } from "./_helpers.ts";

const dir = await mkdtemp(path.join(tmpdir(), "http09-"));
const bigFile = path.join(dir, "big.txt");
await writeFile(bigFile, "line of text\n".repeat(50_000)); // ~650KB

const app = await startServer((req, res) => {
  switch (req.url) {
    case "/auto-length":
      // ONE end() call → Node knows the size and sets content-length.
      res.end("hello");
      return;

    case "/chunked":
      // Multiple writes → the size is unknown when headers go out.
      res.write("a");
      res.write("b");
      res.end("c");
      return;

    case "/explicit-length": {
      const body = JSON.stringify({ msg: "héllo" });
      res.setHeader("content-type", "application/json");
      // Buffer.byteLength, NOT body.length (module 04 §3.1).
      res.setHeader("content-length", Buffer.byteLength(body));
      res.end(body);
      return;
    }

    case "/wrong-length": {
      const body = "héllo"; // 5 chars, 6 bytes
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.setHeader("content-length", body.length); // ✗ 5 — one byte short
      res.end(body);
      return;
    }

    case "/late-header":
      res.write("first ");
      try {
        res.setHeader("x-too-late", "1");
        res.end("second");
      } catch (err) {
        res.end(`| ${(err as NodeJS.ErrnoException).code}`);
      }
      return;

    case "/double-end":
      res.end("one");
      // A second end() emits an 'error' event on res. Unhandled, that
      // CRASHES the process (module 03 §2) — so we listen.
      res.on("error", (err: NodeJS.ErrnoException) => {
        console.log("    [server] res 'error' after double end():", err.code);
      });
      res.end("two");
      return;

    case "/guarded-end":
      res.end("one");
      if (!res.writableEnded) res.end("two"); // ✓ the guard
      console.log("    [server] guard prevented the second end() ✓");
      return;

    case "/stream-file":
      res.setHeader("content-type", "text/plain");
      // pipeline handles backpressure AND destroys the file stream if the
      // client disconnects. .pipe() would leak the fd (module 05 §5.1).
      void pipeline(createReadStream(bigFile), res).catch(() => {
        /* client hung up — nothing to do, pipeline already cleaned up */
      });
      return;

    case "/redirect":
      res.statusCode = 302;
      res.setHeader("location", "/auto-length");
      res.end();
      return;

    case "/no-content":
      // 204 must have NO body and no content-length.
      res.statusCode = 204;
      res.end();
      return;

    default:
      sendJson(res, 404, { error: "not found" });
  }
});

const head = async (p: string) => {
  const r = await fetch(app.url(p), { redirect: "manual" });
  return {
    status: r.status,
    cl: r.headers.get("content-length"),
    te: r.headers.get("transfer-encoding"),
    ct: r.headers.get("content-type"),
    body: await r.text(),
  };
};

console.log("=== 1. Node picks content-length or chunked for you ===");
{
  console.log("  res.end('hello')            →", await head("/auto-length"));
  console.log("  write().write().end()       →", await head("/chunked"));
  console.log(`
  One end() call: Node has the whole body, so it sets content-length.
  Several writes: the total is unknown when the headers must go out, so it
  falls back to transfer-encoding: chunked.

  Set content-length yourself when you know it — clients can show progress,
  and the connection is cheaper to reuse.
`);
}

console.log("=== 2. content-length must be BYTES ===");
{
  console.log("  Buffer.byteLength →", await head("/explicit-length"));
  const wrong = await head("/wrong-length");
  console.log("  body.length       →", { cl: wrong.cl, body: JSON.stringify(wrong.body) });
  console.log(`
  "héllo" is 5 characters but 6 bytes. Declaring 5 truncates the response:
  the client reads exactly content-length bytes and stops, so the last byte
  of the é is lost — and on a keep-alive connection the leftover byte
  corrupts the NEXT response on that socket.

      res.setHeader("content-length", Buffer.byteLength(body));   ✓
      res.setHeader("content-length", body.length);               ✗
`);
}

console.log("=== 3. Headers must precede the body ===");
{
  console.log("  late setHeader →", (await head("/late-header")).body);
  console.log(`
  Once any byte of the body is written, the headers are already on the wire.
  ERR_HTTP_HEADERS_SENT is the result.

  This bites hardest in error handlers, which run after a partial response:

      catch (err) {
        if (res.headersSent) { res.destroy(); return; }   // ← the guard
        sendJson(res, 500, { error: "internal" });
      }

  If headers are already sent you cannot turn a 200 into a 500. Destroying
  the socket at least signals failure instead of delivering a truncated
  body that looks successful.
`);
}

console.log("=== 4. end() exactly once ===");
{
  await head("/double-end");
  await new Promise((r) => setTimeout(r, 20));
  await head("/guarded-end");
  await new Promise((r) => setTimeout(r, 20));
  console.log(`
  A second end() emits 'error' (ERR_STREAM_WRITE_AFTER_END) on res. An
  unhandled 'error' event on an EventEmitter CRASHES THE PROCESS — so one
  handler that both returns a response and lets an error handler send one
  takes the whole server down.

  Guard it:  if (!res.writableEnded) { ... }
`);
}

console.log("=== 5. Streaming a file ===");
{
  const t0 = performance.now();
  const r = await fetch(app.url("/stream-file"));
  const firstByteMs = performance.now() - t0;
  const text = await r.text();
  console.log(`  ${(text.length / 1024).toFixed(0)}KB, te=${r.headers.get("transfer-encoding")}, first response in ${firstByteMs.toFixed(0)}ms`);
  console.log(`
      // ✗ loads the whole file into memory, delays the first byte
      res.end(await readFile(path));

      // ✓ constant memory, immediate first byte, backpressure handled
      await pipeline(createReadStream(path), res);

  pipeline also DESTROYS the file stream when the client disconnects.
  .pipe() leaks the fd on every abandoned download (module 05 §5.1).
`);
}

console.log("=== 6. Status codes that have rules ===");
{
  console.log("  302 redirect →", await head("/redirect"));
  const nc = await head("/no-content");
  console.log("  204          →", { status: nc.status, cl: nc.cl, bodyLength: nc.body.length });
  console.log(`
  204 No Content and 304 Not Modified must carry NO body. Node enforces
  this — writing a body to a 204 is silently dropped, which is confusing if
  you don't know the rule.

  Common mistakes:
    • 200 with an { error } payload — use the status code, that's what it's for
    • 500 for a client's bad input — that's 400/422, and it pollutes your
      error budget and pages someone at 3am
    • 401 (who are you?) vs 403 (I know you, and no)
    • 404 for "not found" vs 410 Gone for "deleted on purpose"
`);
}

await app.close();
await rm(dir, { recursive: true, force: true });
