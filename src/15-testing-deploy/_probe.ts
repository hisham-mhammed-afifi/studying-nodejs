/** Round 6 — confirm WHY close() waits, and that the sweep fixes it. */

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "probe15-"));
const file = path.join(dir, "drain.ts");

writeFileSync(
  file,
  `
import { createServer, get, Agent } from "node:http";
import { once } from "node:events";

const mode = process.argv[2]!;
const server = createServer((_req, res) => setTimeout(() => res.end("ok"), 1000));
server.listen(0);
await once(server, "listening");
const { port } = server.address() as { port: number };
const agent = new Agent({ keepAlive: true });

let client = "pending";
get({ port, agent }, (res) => { res.resume(); res.on("end", () => { client = "completed " + res.statusCode; }); })
  .on("error", (e: NodeJS.ErrnoException) => { client = "ERROR " + e.code; });
await new Promise((r) => setTimeout(r, 200));

const t0 = Date.now();
server.close(() => { console.log(mode + ": drained in " + (Date.now() - t0) + "ms, client=" + client); process.exit(0); });

if (mode === "sweep") {
  // Connections that BECOME idle after close() are not touched by close()
  // itself, so keep sweeping until the deadline.
  const sweep = setInterval(() => server.closeIdleConnections(), 50);
  const deadline = setTimeout(() => {
    console.log(mode + ": deadline hit, forcing");
    server.closeAllConnections();
  }, 5000);
  sweep.unref(); deadline.unref();
}
setTimeout(() => { console.log(mode + ": STILL OPEN after 12s, client=" + client); process.exit(1); }, 12000);
`,
);

for (const mode of ["none", "sweep"]) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [file, mode], { encoding: "utf8", timeout: 20000 });
  console.log(`${mode.padEnd(6)} (wall ${Date.now() - t0}ms) → ${(r.stdout + r.stderr).trim().split("\n").join(" | ")}`);
}

console.log("\nprobe dir:", dir);
