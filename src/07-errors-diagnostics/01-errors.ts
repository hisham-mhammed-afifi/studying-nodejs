/**
 * 01 — Error anatomy, serialisation, and cause chains
 *
 * Run:  node src/07-errors-diagnostics/01-errors.ts
 */

console.log("=== 1. The four things an Error carries ===");
{
  const err = new Error("something failed");
  console.log("  name:   ", err.name);
  console.log("  message:", err.message);
  console.log("  stack:  ", err.stack?.split("\n")[1]?.trim(), "…");
  console.log("  cause:  ", err.cause);
}

console.log("\n=== 2. Error properties are NON-ENUMERABLE ===");
{
  const err = new Error("boom");
  console.log("  JSON.stringify(err):", JSON.stringify(err), "← everything vanished");
  console.log("  Object.keys(err):   ", JSON.stringify(Object.keys(err)));
  console.log("  message enumerable? ", Object.getOwnPropertyDescriptor(err, "message")?.enumerable);

  // But properties YOU add are enumerable:
  const custom = Object.assign(new Error("with code"), { code: "E_CUSTOM", statusCode: 400 });
  console.log("  with own props:     ", JSON.stringify(custom), "← code/statusCode survive");

  console.log(`
  This is why logger.info({ err }) prints {"err":{}} with a naive JSON
  serialiser. pino and bunyan special-case Error; a hand-rolled
  JSON.stringify does not. Serialise explicitly:
`);
}

console.log("=== 3. A serialiser that actually works ===");
{
  function serializeError(err: unknown, depth = 0): Record<string, unknown> {
    if (depth > 8) return { message: "[cause chain too deep]" };
    if (!(err instanceof Error)) return { value: String(err), type: typeof err };
    return {
      name: err.name,
      message: err.message,
      // Own enumerable props (code, statusCode, …) — spread these FIRST so
      // an accidental `name` property can't overwrite the real one.
      ...Object.fromEntries(Object.entries(err)),
      stack: err.stack?.split("\n").slice(0, 4).join("\n"),
      ...(err.cause !== undefined ? { cause: serializeError(err.cause, depth + 1) } : {}),
    };
  }

  const low = new Error("ECONNREFUSED 10.0.0.5:5432");
  const mid = Object.assign(new Error("query failed", { cause: low }), { code: "DB_ERROR" });
  const top = new Error("cannot load user 42", { cause: mid });

  console.log(JSON.stringify(serializeError(top), null, 2).split("\n").map((l) => "  " + l).join("\n"));

  // A subtlety worth knowing: HOW you set cause changes its enumerability.
  const viaCtor = new Error("a", { cause: low });
  const viaAssign = new Error("b");
  viaAssign.cause = low;
  console.log("\n  cause via constructor → enumerable:", Object.getOwnPropertyDescriptor(viaCtor, "cause")?.enumerable);
  console.log("  cause via assignment  → enumerable:", Object.getOwnPropertyDescriptor(viaAssign, "cause")?.enumerable);
  console.log("  so JSON.stringify gives:", JSON.stringify(viaCtor), "vs", JSON.stringify(viaAssign));
  console.log("  → don't rely on either. Serialise cause explicitly, as above.");
}

console.log("\n=== 4. cause: the chain that saves you ===");
{
  const low = new Error("ECONNREFUSED 10.0.0.5:5432");
  const mid = new Error("db.query failed", { cause: low });
  const top = new Error("cannot load user 42", { cause: mid });

  console.log("  top.cause.message:      ", (top.cause as Error).message);
  console.log("  top.cause.cause.message:", ((top.cause as Error).cause as Error).message);

  console.log(`
  Without cause you must choose: rethrow the low-level error (useful detail,
  no context — "ECONNREFUSED", but WHICH request?) or rewrap with a message
  (context, no detail — "cannot load user", but WHY?). cause gives you both,
  and console.error prints the whole chain automatically.

  Rule: every time you rewrap, pass the cause.

      throw new Error(\`Failed to load user \${id}\`, { cause: err });
`);
}

console.log("=== 5. Walking the chain ===");
{
  function* causes(err: unknown): Generator<Error> {
    let current: unknown = err;
    // A cycle guard matters: err.cause = err is rare but it hangs forever.
    const seen = new Set<unknown>();
    while (current instanceof Error && !seen.has(current)) {
      seen.add(current);
      yield current;
      current = current.cause;
    }
  }

  class TimeoutError extends Error {
    override readonly name = "TimeoutError";
  }

  const chain = new Error("checkout failed", {
    cause: new Error("payment provider unreachable", {
      cause: new TimeoutError("request timed out after 5000ms"),
    }),
  });

  console.log("  full chain:");
  for (const e of causes(chain)) console.log(`    ${e.name}: ${e.message}`);

  const root = [...causes(chain)].at(-1);
  console.log("  rootCause:", root?.message);

  const timeout = [...causes(chain)].find((e) => e instanceof TimeoutError);
  console.log("  findCause(TimeoutError):", timeout ? "found ✓" : "not found");

  console.log(`
  findCause is how you answer "was this ultimately a timeout?" without
  string-matching messages — which breaks the moment someone reworded one.
`);
}

console.log("=== 6. Custom error classes ===");
{
  class AppError extends Error {
    readonly code: string;
    readonly statusCode: number;
    readonly isOperational = true;

    constructor(message: string, opts: { code: string; statusCode?: number; cause?: unknown }) {
      super(message, { cause: opts.cause });
      // new.target is the ACTUAL constructor that was called, so every
      // subclass reports its own name without repeating this line.
      this.name = new.target.name;
      this.code = opts.code;
      this.statusCode = opts.statusCode ?? 500;
      // Omits the constructor frames, so the stack starts at the CALLER.
      Error.captureStackTrace?.(this, new.target);
    }
  }

  class NotFoundError extends AppError {
    constructor(resource: string, id: string, cause?: unknown) {
      super(`${resource} ${id} not found`, { code: "NOT_FOUND", statusCode: 404, cause });
    }
  }

  const err = new NotFoundError("user", "42");
  console.log("  name:      ", err.name, "← from new.target, not hardcoded");
  console.log("  code:      ", err.code);
  console.log("  statusCode:", err.statusCode);
  console.log("  instanceof NotFoundError:", err instanceof NotFoundError);
  console.log("  instanceof AppError:     ", err instanceof AppError);
  console.log("  instanceof Error:        ", err instanceof Error);
  console.log("  stack starts at:", err.stack?.split("\n")[1]?.trim());
  console.log("  (no NotFoundError/AppError constructor frames — captureStackTrace)");
}

console.log("\n=== 7. instanceof is not always available ===");
console.log(`
  err instanceof NotFoundError works inside ONE process with ONE copy of
  your module. It breaks when:

    • two copies of a package are installed (module 01 §3.3) — two class
      identities, so instanceof is false for an object that "is" one
    • the error crossed a worker_threads or child_process boundary — it was
      serialised, and came back a plain Error
    • the error came from a different realm (vm context)

  So for anything crossing a boundary, branch on a STRING CODE:

      if (err instanceof AppError && err.code === "NOT_FOUND") { ... }

  This is exactly why Node's own fs errors carry .code (module 06 §8)
  instead of exposing an error class per condition.
`);

console.log("=== 8. AggregateError ===");
{
  try {
    await Promise.any([Promise.reject(new Error("primary down")), Promise.reject(new Error("replica down"))]);
  } catch (err) {
    const agg = err as AggregateError;
    console.log("  name:  ", agg.name);
    console.log("  errors:", agg.errors.map((e: Error) => e.message));
  }
  console.log(`
  Promise.any rejects with an AggregateError only when ALL inputs reject.
  You can construct one yourself when several independent things failed:

      throw new AggregateError(failures, \`\${failures.length} writes failed\`);

  Compare Promise.allSettled, which never rejects and hands you every
  outcome — usually what you want for a batch job.
`);
}

console.log("=== 9. Never throw a non-Error ===");
{
  try {
    // eslint-disable-next-line no-throw-literal
    throw "user not found";
  } catch (err) {
    console.log("  typeof:", typeof err, "| has stack:", (err as { stack?: string }).stack !== undefined);
  }
  console.log(`
  A thrown string has no stack, no name, and no cause. You lose every tool
  in this module. Same for throwing plain objects.

  And in TypeScript, catch gives you 'unknown' — narrow before use:

      catch (err) {
        if (err instanceof Error) log(err.message);
        else log(String(err));       // ← someone WILL throw a string
      }
`);
}
