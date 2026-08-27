/**
 * 01 — What createServer actually hands you
 *
 * Run:  node src/09-http/01-anatomy.ts
 */

import { Readable, Stream, Writable } from "node:stream";
import { EventEmitter } from "node:events";
import { startServer, sendJson } from "./_helpers.ts";

const app = await startServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

  switch (url.pathname) {
    case "/inspect":
      sendJson(res, 200, {
        method: req.method,
        rawUrl: req.url,
        pathname: url.pathname,
        query: Object.fromEntries(url.searchParams),
        httpVersion: req.httpVersion,
        // Node lowercases every header KEY for you.
        headerKeys: Object.keys(req.headers).sort().slice(0, 8),
        // rawHeaders keeps the original casing, as a flat array.
        rawHeadersSample: req.rawHeaders.slice(0, 4),
        remoteAddress: req.socket.remoteAddress,
      });
      return;

    case "/types":
      sendJson(res, 200, {
        reqIsReadable: req instanceof Readable,
        resIsWritable: res instanceof Writable,
        resIsStream: res instanceof Stream,
        reqIsEventEmitter: req instanceof EventEmitter,
        resHasWritableApi: ["write", "end", "cork", "destroy"].every(
          (m) => typeof (res as unknown as Record<string, unknown>)[m] === "function",
        ),
      });
      return;

    case "/echo":
      // req is a Readable, res is a Writable — so this is a valid echo
      // server, and it streams with backpressure for free (module 05).
      req.pipe(res);
      return;

    case "/dup-headers":
      sendJson(res, 200, {
        // Repeated headers are JOINED with ", ".
        xTest: req.headers["x-test"] ?? null,
        // …except set-cookie, which is always an ARRAY.
        setCookieType: Array.isArray(req.headers["set-cookie"]) ? "array" : typeof req.headers["set-cookie"],
      });
      return;

    default:
      res.statusCode = 404;
      res.end();
  }
});

console.log("=== 1. req and res are STREAMS ===");
{
  const types = await (await fetch(app.url("/types"))).json();
  console.log(" ", types);
  console.log(`
  ⚠ Note resIsWritable: false. This surprised me too, so I checked:

      IncomingMessage → Readable → Stream → EventEmitter
      ServerResponse  → OutgoingMessage → Stream → EventEmitter
                        ^^^^^^^^^^^^^^^ NOT stream.Writable

  res QUACKS like a Writable — write(), end(), cork(), destroy(), 'drain',
  'finish' — and pipeline() accepts it. But it does not INHERIT from
  stream.Writable, so \`res instanceof Writable\` is false. Any code doing
  a duck-type check on Writable will silently reject a real response object.

  That aside, the mental model holds:

      req (IncomingMessage) = a Readable of the request BODY,
                              with the headers attached as properties
      res (ServerResponse)  = a Writable-SHAPED sink for the response BODY
      server                = an EventEmitter (and a net.Server)

  Everything from Part 1 applies directly. Bodies are Buffers (module 04),
  backpressure is real (module 05), an unhandled 'error' event on res
  crashes the process (module 03), and one blocking handler freezes EVERY
  connection (module 02).
`);
}

console.log("=== 2. req.url is NOT a URL ===");
{
  const info = (await (await fetch(app.url("/inspect?full=1&page=2"))).json()) as Record<string, unknown>;
  console.log("  req.url:  ", JSON.stringify(info["rawUrl"]));
  console.log("  pathname: ", info["pathname"]);
  console.log("  query:    ", info["query"]);

  try {
    new URL("/users/42?full=1");
  } catch (err) {
    console.log("  new URL('/users/42') →", (err as Error).constructor.name, "← no scheme, no host");
  }

  console.log(`
  req.url is the request TARGET: path + query only. It never contains the
  scheme or host, because those live in the Host header. To parse it you
  must supply a base:

      const url = new URL(req.url ?? "/", \`http://\${req.headers.host}\`);

  ⚠ That base comes from a CLIENT-CONTROLLED header. If you use url.host
  for anything security-relevant — building links, cache keys, redirects —
  validate it against an allowlist first.
`);
}

console.log("=== 3. Headers ===");
{
  const info = (await (await fetch(app.url("/inspect"))).json()) as Record<string, unknown>;
  console.log("  req.headers keys (lowercased):", info["headerKeys"]);
  console.log("  req.rawHeaders (original case):", info["rawHeadersSample"]);

  const dup = (await (
    await fetch(app.url("/dup-headers"), { headers: [["x-test", "a"], ["x-test", "b"]] })
  ).json()) as { xTest: string | null };
  console.log("  two x-test headers arrive as:", JSON.stringify(dup.xTest), "← joined with ', '");

  console.log(`
  Rules:
    • req.headers KEYS are lowercased. Always index with lowercase.
    • VALUES are strings; repeated headers are joined with ", ".
    • set-cookie is the exception — always an ARRAY, never joined.
    • req.rawHeaders is a FLAT array [name, value, name, value, …] with the
      original casing, if you need to see exactly what arrived.
`);
}

console.log("=== 4. The lifecycle ===");
{
  const traced = await startServer((req, res) => {
    const events: string[] = [];
    const mark = (name: string) => events.push(name);

    req.on("data", () => mark("req:data"));
    req.on("end", () => mark("req:end"));
    req.on("close", () => mark("req:close"));

    res.on("finish", () => mark("res:finish"));
    res.on("close", () => {
      mark("res:close");
      console.log("  observed order:", events.join(" → "));
      console.log("  res.writableFinished:", res.writableFinished, "← true means WE finished it");
    });

    req.resume();
    req.on("end", () => res.end("done"));
  });

  await fetch(traced.url("/"), { method: "POST", body: "hello" });
  await new Promise((r) => setTimeout(r, 50));
  await traced.close();

  console.log(`
    req 'data'/'end'  the body arriving (module 05 §3)
    req 'close'       the request stream is done — completed OR aborted
    res 'finish'      we called end() and it flushed
    res 'close'       the response is over, either way

  The pair that matters for cancellation:

      res.on("close", () => {
        if (!res.writableFinished) ac.abort();   // the CLIENT hung up
      });

  Without it, a user who navigates away leaves your database query running
  into a socket nobody is reading. See 05-errors-shutdown.ts.
`);
}

console.log("=== 5. The whole thing, streamed ===");
{
  const res = await fetch(app.url("/echo"), { method: "POST", body: "req.pipe(res) really works" });
  console.log("  echo response:", JSON.stringify(await res.text()));
  console.log(`
  One line, and it handles backpressure correctly, because both sides are
  genuine streams. (Use pipeline() rather than pipe() in real code, so a
  client disconnect tears down the source — module 05 §5.1.)
`);
}

await app.close();
