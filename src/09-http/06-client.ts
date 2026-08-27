/**
 * 06 — The HTTP client: fetch, http.request, agents
 *
 * Run:  node src/09-http/06-client.ts
 */

import { Agent, request } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { startServer, sendJson } from "./_helpers.ts";

const dir = await mkdtemp(path.join(tmpdir(), "http09c-"));

const app = await startServer(async (req, res) => {
  switch (req.url) {
    case "/ok":
      sendJson(res, 200, { ok: true });
      return;
    case "/boom":
      sendJson(res, 500, { error: "internal" });
      return;
    case "/notfound":
      sendJson(res, 404, { error: "missing" });
      return;
    case "/slow":
      await sleep(2_000);
      sendJson(res, 200, { ok: true });
      return;
    case "/big":
      res.setHeader("content-type", "application/octet-stream");
      for (let i = 0; i < 200; i++) res.write(Buffer.alloc(4096, 0x61));
      res.end();
      return;
    default:
      sendJson(res, 404, { error: "not found" });
  }
});

console.log("=== 1. ⚠ fetch does NOT reject on 4xx/5xx ===");
{
  const bad = await fetch(app.url("/boom"));
  console.log("  a 500 response →", { rejected: false, status: bad.status, ok: bad.ok });

  const missing = await fetch(app.url("/notfound"));
  console.log("  a 404 response →", { rejected: false, status: missing.status, ok: missing.ok });

  console.log(`
  fetch rejects ONLY on network failures, aborts, and malformed responses.
  An HTTP error IS a successful fetch — the server answered.

      // ✗ the single most common fetch bug
      const data = await (await fetch(url)).json();

      // ✓
      const res = await fetch(url);
      if (!res.ok) throw new Error(\`HTTP \${res.status} from \${url}\`);
      const data = await res.json();

  This is the opposite of axios, which throws on non-2xx by default —
  which is why people porting between them ship silent failures.
`);
}

console.log("=== 2. Always give it a deadline ===");
{
  const t0 = Date.now();
  const outcome = await fetch(app.url("/slow"), { signal: AbortSignal.timeout(300) })
    .then((r) => `HTTP ${r.status}`)
    .catch((e: Error) => `${e.name}: ${e.message}`);
  console.log(`  /slow with a 300ms timeout → ${outcome} after ${Date.now() - t0}ms`);

  console.log(`
  fetch has NO default timeout. Without a signal, a hung upstream holds your
  request — and your connection-pool slot — indefinitely.

      AbortSignal.timeout(5_000)                       // a deadline
      AbortSignal.any([req.signal, AbortSignal.timeout(5_000)])
                                                       // …or the client left

  ⚠ AbortSignal.timeout()'s internal timer is unref'd (module 03 §5.2), so
  it will not keep a script alive on its own.
`);
}

console.log("=== 3. Streaming a response body ===");
{
  const out = path.join(dir, "download.bin");

  const res = await fetch(app.url("/big"));
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

  // res.body is a WEB ReadableStream — convert at the boundary (module 05 §8).
  await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), createWriteStream(out));

  console.log(`  streamed ${((await stat(out)).size / 1024).toFixed(0)}KB to disk, constant memory ✓`);
  console.log(`
      // ✗ buffers the ENTIRE download before writing a byte
      await writeFile(out, Buffer.from(await res.arrayBuffer()));

      // ✓ constant memory, and pipeline cleans up if the connection drops
      await pipeline(Readable.fromWeb(res.body), createWriteStream(out));

  Fine for a 2KB JSON response; fatal for a 2GB file.
`);
}

console.log("=== 4. http.request, when you need the control ===");
{
  const agent = new Agent({ keepAlive: true, maxSockets: 10 });

  const body = await new Promise<string>((resolve, reject) => {
    const req = request({ port: app.port, host: "127.0.0.1", path: "/ok", agent }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (data += c));
      res.on("end", () => resolve(`HTTP ${res.statusCode} ${data}`));
    });
    req.on("error", reject);
    req.end();
  });
  console.log("  http.request →", body);
  agent.destroy();

  console.log(`
  Reach for http.request over fetch when you need:
    • a custom Agent — pool sizing, socket reuse, a proxy
    • the raw socket (upgrades, WebSockets, unix sockets)
    • per-request framing control, or to read trailers
    • to avoid undici's buffering for very large uploads

  Otherwise use fetch. It's standard, it's shorter, and it works the same
  in browsers and edge runtimes.
`);
}

console.log("=== 5. Agents and connection pooling ===");
{
  const agent = new Agent({ keepAlive: true, maxSockets: 2, maxFreeSockets: 2 });

  const hit = () =>
    new Promise<void>((resolve, reject) => {
      const r = request({ port: app.port, host: "127.0.0.1", path: "/ok", agent }, (res) => {
        res.resume();
        res.on("end", () => resolve());
      });
      r.on("error", reject);
      r.end();
    });

  await Promise.all(Array.from({ length: 8 }, hit));
  const sockets = Object.values(agent.sockets).flat().length;
  const free = Object.values(agent.freeSockets).flat().length;
  console.log(`  after 8 concurrent requests with maxSockets: 2 → ${sockets} active, ${free} pooled`);
  agent.destroy();

  console.log(`
  Agent options that matter:

    keepAlive: true      reuse sockets — the default for globalAgent since v19
    maxSockets           per host. Too low queues requests; too high floods
                         the upstream and burns file descriptors
    maxFreeSockets       idle sockets kept for reuse
    timeout              socket inactivity

  ⚠ maxSockets is a hidden concurrency limit. Set it to 5 and your 100
  parallel calls to one host quietly serialise 5 at a time — a "slow API"
  that is entirely your own client's doing.

  For fetch, the equivalent knob lives in undici:

      import { Agent, setGlobalDispatcher } from "undici";
      setGlobalDispatcher(new Agent({ connections: 50 }));
`);
}

console.log("=== 6. A client wrapper worth having ===");
console.log(`
  async function httpJson<T>(
    url: string,
    init: RequestInit & { timeoutMs?: number } = {},
  ): Promise<T> {
    const { timeoutMs = 5_000, signal, ...rest } = init;
    const combined = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs);

    let res: Response;
    try {
      res = await fetch(url, { ...rest, signal: combined });
    } catch (err) {
      // Wrap with context, keep the cause (module 07 §2).
      throw new Error(\`request to \${url} failed\`, { cause: err });
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw Object.assign(new Error(\`HTTP \${res.status} from \${url}\`), {
        status: res.status,
        detail: detail.slice(0, 500),      // cap it — don't log a 10MB error page
      });
    }
    return (await res.json()) as T;
  }

  It handles the four things everyone forgets: res.ok, a timeout, an error
  body for debugging, and a cause chain. Combine with withRetry from module
  07 — retrying only 429/5xx, with jitter.
`);

await app.close();
await rm(dir, { recursive: true, force: true });
