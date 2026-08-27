/**
 * 06 — Web Streams, and interop with Node streams
 *
 * Run:  node src/05-streams/06-web-streams.ts
 */

import { Readable, Writable, Duplex } from "node:stream";
import { pipeline } from "node:stream/promises";
import { text } from "node:stream/consumers";

console.log("=== 1. Two stream families live in Node ===");
console.log(`
  Node streams          node:stream        Readable / Writable / Transform
  Web streams (WHATWG)  global             ReadableStream / WritableStream /
                                           TransformStream

  You meet web streams whenever you touch fetch, Blob, Response, or code
  shared with a browser. Everything in Node core speaks Node streams.
`);

console.log("  globals present:", {
  ReadableStream: typeof ReadableStream,
  TransformStream: typeof TransformStream,
  CompressionStream: typeof CompressionStream,
});

console.log("\n=== 2. fetch gives you a WEB stream ===");
{
  // No network needed — Response is the same machinery fetch uses.
  const res = new Response("hello from a Response body");
  console.log("  res.body is a:", res.body?.constructor.name);
  console.log("  is it a Node Readable?", res.body instanceof Readable);
  console.log(`
  So this does NOT work:
      await pipeline(res.body, createWriteStream("out"));   ✗ not a Node stream

  You have to convert at the boundary.
`);
}

console.log("=== 3. Converting: fromWeb / toWeb ===");
{
  const res = new Response("hello from a Response body");

  // web → Node
  const nodeReadable = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream);
  console.log("  Readable.fromWeb(...) →", nodeReadable.constructor.name);
  console.log("  content:", JSON.stringify(await text(nodeReadable)));

  // Node → web
  const web = Readable.toWeb(Readable.from(["a", "b", "c"]));
  console.log("  Readable.toWeb(...)   →", web.constructor.name);

  let out = "";
  for await (const chunk of web) out += chunk;
  console.log("  round-tripped:", JSON.stringify(out));

  console.log(`
  The full set:
      Readable.fromWeb(readableStream)     Readable.toWeb(readable)
      Writable.fromWeb(writableStream)     Writable.toWeb(writable)
      Duplex.fromWeb({readable, writable}) Duplex.toWeb(duplex)

  ${typeof Duplex.toWeb === "function" ? "(all available in this Node build)" : ""}
`);
}

console.log("=== 4. The practical recipe: stream a download to disk ===");
console.log(`
  import { Readable } from "node:stream";
  import { pipeline } from "node:stream/promises";
  import { createWriteStream } from "node:fs";

  const res = await fetch(url);
  if (!res.ok) throw new Error(\`HTTP \${res.status}\`);
  if (!res.body) throw new Error("no body");

  await pipeline(Readable.fromWeb(res.body), createWriteStream("out.bin"));

  Compare with the tempting one-liner:

      await writeFile("out.bin", Buffer.from(await res.arrayBuffer()));   ✗

  That buffers the entire download in memory before writing a single byte.
  Fine for a 2KB JSON response; fatal for a 2GB file.
`);

console.log("=== 5. TransformStream, the web equivalent ===");
{
  const upper = new TransformStream<string, string>({
    transform(chunk, controller) {
      controller.enqueue(chunk.toUpperCase());
    },
    flush() {
      /* end-of-input hook, same idea as Node's _flush */
    },
  });

  const src = new ReadableStream<string>({
    start(controller) {
      controller.enqueue("web ");
      controller.enqueue("streams");
      controller.close();
    },
  });

  let out = "";
  for await (const chunk of src.pipeThrough(upper)) out += chunk;
  console.log("  pipeThrough result:", JSON.stringify(out));
  console.log(`
  Note the different vocabulary for the same ideas:
      Node                        Web
      ────────────────────────    ──────────────────────────────
      push(chunk)                 controller.enqueue(chunk)
      push(null)                  controller.close()
      destroy(err)                controller.error(err)
      _flush(cb)                  flush(controller)
      pipeline(a, b, c)           a.pipeThrough(b).pipeTo(c)
      write() returns false       the promise from writer.write()
`);
}

console.log("=== 6. Built-in web transforms ===");
{
  // These are globals, and they're genuinely useful.
  const compressed = new Response("hello hello hello hello hello").body!.pipeThrough(
    new CompressionStream("gzip"),
  );
  const roundTripped = compressed.pipeThrough(new DecompressionStream("gzip"));
  console.log("  gzip round trip:", JSON.stringify(await new Response(roundTripped).text()));

  // TextDecoderStream is the streaming decoder from module 04, as a stream.
  const bytes = Buffer.from("héllo 😀");
  const split = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes.subarray(0, 8)); // splits the emoji
      c.enqueue(bytes.subarray(8));
      c.close();
    },
  });
  let decoded = "";
  for await (const s of split.pipeThrough(new TextDecoderStream())) decoded += s;
  console.log("  TextDecoderStream across a split character:", JSON.stringify(decoded), "✓");
}

console.log("\n=== 7. Backpressure, both ways ===");
console.log(`
  Node: write() returns a boolean; you wait for the 'drain' event.

      if (!w.write(chunk)) await once(w, "drain");

  Web: the writer's write() returns a PROMISE that resolves when there is
  room. Backpressure is just await — arguably the nicer design.

      const writer = writableStream.getWriter();
      await writer.write(chunk);        // ← this is the backpressure
      await writer.close();

  Same concept, and both are automatic if you use pipeline / pipeTo.
`);

console.log("=== 8. Which to use ===");
console.log(`
  Node streams for Node code. They are faster in Node, support object mode,
  and every core API (fs, http, zlib, crypto, child_process) speaks them.

  Web streams at the boundary: fetch bodies, Blob/File, Service Workers,
  and libraries shared with browser/Deno/Bun/edge runtimes.

  Convert once, at the edge — don't scatter fromWeb/toWeb through your code.

  One real difference to know: web streams have NO object mode. They are
  byte/chunk oriented, and while you can enqueue arbitrary values, the
  queuing strategy counts them differently. If you're streaming database
  rows, Node streams in object mode are the better fit.
`);

// Prove Writable.toWeb exists and works, so the table above isn't just prose.
{
  const collected: string[] = [];
  const nodeWritable = new Writable({
    objectMode: true,
    write(chunk: string, _enc, cb) {
      collected.push(chunk);
      cb();
    },
  });
  const webWritable = Writable.toWeb(nodeWritable);
  const writer = webWritable.getWriter();
  await writer.write("x");
  await writer.write("y");
  await writer.close();
  console.log("=== 9. Writable.toWeb round trip ===");
  console.log("  wrote via a web writer, collected in a Node Writable:", collected.join(","));
}

// And that a Node pipeline can consume a converted web source end-to-end.
{
  const web = new Response("final check").body!;
  const chunks: Buffer[] = [];
  await pipeline(
    Readable.fromWeb(web as import("node:stream/web").ReadableStream),
    new Writable({
      write(c: Buffer, _e, cb) {
        chunks.push(c);
        cb();
      },
    }),
  );
  console.log("  pipeline over a converted fetch body:", JSON.stringify(Buffer.concat(chunks).toString()));
}
