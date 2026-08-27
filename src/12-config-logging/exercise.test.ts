/**
 *   node scripts/test.ts 12
 *   node scripts/test.ts --solutions 12
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import type { Logger } from "pino";

import { type AppConfig, ConfigError, type LoggerOptions } from "./exercise.ts";

const modulePath = process.env["IMPL"] === "solution" ? "./solution.ts" : "./exercise.ts";

type Impl = {
  loadConfig(env: NodeJS.ProcessEnv): Readonly<AppConfig>;
  createLogger(options?: LoggerOptions): Logger;
  withRequestContext<T>(
    logger: Logger,
    fields: Record<string, unknown>,
    fn: () => T | Promise<T>,
  ): Promise<T>;
  getRequestLogger(): Logger | undefined;
};

let impl: Impl;
before(async () => {
  impl = (await import(modulePath)) as unknown as Impl;
});

/** The minimum a valid config needs. */
const REQUIRED = { DATABASE_URL: "postgres://localhost/app", API_TOKEN: "tok_abc" };

/** A logger writing into an array, so tests can inspect the JSON. */
function captureLogger(options: Omit<LoggerOptions, "destination"> = {}) {
  const lines: Record<string, unknown>[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _enc, cb) {
      for (const raw of chunk.toString().trim().split("\n")) {
        if (raw) lines.push(JSON.parse(raw) as Record<string, unknown>);
      }
      cb();
    },
  });
  return { logger: impl.createLogger({ level: "trace", ...options, destination }), lines };
}

describe("loadConfig — defaults and coercion", () => {
  it("applies every default", () => {
    const c = impl.loadConfig({ ...REQUIRED });
    assert.equal(c.PORT, 3000);
    assert.equal(c.HOST, "127.0.0.1");
    assert.equal(c.NODE_ENV, "development");
    assert.equal(c.LOG_LEVEL, "info");
    assert.equal(c.ENABLE_METRICS, false);
    assert.equal(c.REQUEST_TIMEOUT_MS, 30_000);
  });

  it("COERCES numbers — the env gives you strings", () => {
    const c = impl.loadConfig({ ...REQUIRED, PORT: "8080", REQUEST_TIMEOUT_MS: "5000" });
    assert.equal(c.PORT, 8080);
    assert.equal(typeof c.PORT, "number", "PORT must be a number, not the string from the env");
    assert.equal(c.REQUEST_TIMEOUT_MS, 5000);
    assert.equal(typeof c.REQUEST_TIMEOUT_MS, "number");
  });

  it("COERCES booleans, including the truthy string 'false'", () => {
    for (const [raw, expected] of [
      ["true", true],
      ["TRUE", true],
      ["1", true],
      ["yes", true],
      ["on", true],
      ["false", false],
      ["FALSE", false],
      ["0", false],
      ["no", false],
      ["off", false],
    ] as const) {
      const c = impl.loadConfig({ ...REQUIRED, ENABLE_METRICS: raw });
      assert.equal(c.ENABLE_METRICS, expected, `ENABLE_METRICS=${raw} should be ${expected}`);
      assert.equal(typeof c.ENABLE_METRICS, "boolean");
    }
  });

  it("accepts valid enums", () => {
    for (const env of ["development", "production", "test"] as const) {
      assert.equal(impl.loadConfig({ ...REQUIRED, NODE_ENV: env }).NODE_ENV, env);
    }
    for (const level of ["debug", "info", "warn", "error"] as const) {
      assert.equal(impl.loadConfig({ ...REQUIRED, LOG_LEVEL: level }).LOG_LEVEL, level);
    }
  });

  it("treats an empty string as unset", () => {
    const c = impl.loadConfig({ ...REQUIRED, PORT: "", HOST: "" });
    assert.equal(c.PORT, 3000);
    assert.equal(c.HOST, "127.0.0.1");
  });

  it("returns a FROZEN object", () => {
    const c = impl.loadConfig({ ...REQUIRED });
    assert.ok(Object.isFrozen(c));
  });
});

describe("loadConfig — validation", () => {
  const expectIssues = (env: NodeJS.ProcessEnv): string[] => {
    try {
      impl.loadConfig(env);
      assert.fail("expected a ConfigError");
    } catch (err) {
      assert.ok(err instanceof ConfigError, `expected ConfigError, got ${String(err)}`);
      return [...err.issues];
    }
  };

  it("requires DATABASE_URL and API_TOKEN", () => {
    const issues = expectIssues({});
    assert.ok(issues.some((i) => i.startsWith("DATABASE_URL:")));
    assert.ok(issues.some((i) => i.startsWith("API_TOKEN:")));
  });

  it("reports EVERY problem at once, not just the first", () => {
    const issues = expectIssues({
      PORT: "abc",
      NODE_ENV: "staging",
      LOG_LEVEL: "verbose",
      ENABLE_METRICS: "maybe",
    });
    for (const field of ["PORT", "NODE_ENV", "LOG_LEVEL", "ENABLE_METRICS", "DATABASE_URL", "API_TOKEN"]) {
      assert.ok(
        issues.some((i) => i.startsWith(`${field}:`)),
        `expected an issue for ${field}, got:\n  ${issues.join("\n  ")}`,
      );
    }
  });

  it("rejects a non-integer PORT", () => {
    assert.ok(expectIssues({ ...REQUIRED, PORT: "80.5" }).some((i) => i.startsWith("PORT:")));
    assert.ok(expectIssues({ ...REQUIRED, PORT: "abc" }).some((i) => i.startsWith("PORT:")));
  });

  it("rejects an out-of-range PORT", () => {
    assert.ok(expectIssues({ ...REQUIRED, PORT: "0" }).some((i) => i.startsWith("PORT:")));
    assert.ok(expectIssues({ ...REQUIRED, PORT: "70000" }).some((i) => i.startsWith("PORT:")));
  });

  it("rejects REQUEST_TIMEOUT_MS below 100", () => {
    assert.ok(expectIssues({ ...REQUIRED, REQUEST_TIMEOUT_MS: "50" }).some((i) => i.startsWith("REQUEST_TIMEOUT_MS:")));
  });

  it("rejects an unknown enum value", () => {
    assert.ok(expectIssues({ ...REQUIRED, NODE_ENV: "staging" }).some((i) => i.startsWith("NODE_ENV:")));
  });

  it("rejects a non-boolean ENABLE_METRICS", () => {
    assert.ok(expectIssues({ ...REQUIRED, ENABLE_METRICS: "maybe" }).some((i) => i.startsWith("ENABLE_METRICS:")));
  });

  it("the message names every field", () => {
    try {
      impl.loadConfig({ PORT: "abc" });
      assert.fail("expected a throw");
    } catch (err) {
      const msg = (err as Error).message;
      for (const field of ["PORT", "DATABASE_URL", "API_TOKEN"]) {
        assert.ok(msg.includes(field), `message should mention ${field}: ${msg}`);
      }
    }
  });
});

describe("loadConfig — redaction", () => {
  it("JSON.stringify redacts secret-looking keys", () => {
    const c = impl.loadConfig({
      ...REQUIRED,
      DATABASE_URL: "postgres://user:hunter2@db.internal/app",
      API_TOKEN: "tok_live_SECRET",
    });
    const json = JSON.stringify(c);
    assert.ok(!json.includes("hunter2"), "DATABASE_URL leaked through JSON.stringify");
    assert.ok(!json.includes("tok_live_SECRET"), "API_TOKEN leaked through JSON.stringify");
    assert.ok(json.includes("[REDACTED]"));
  });

  it("keeps non-secret fields readable", () => {
    const parsed = JSON.parse(JSON.stringify(impl.loadConfig({ ...REQUIRED, PORT: "8080" }))) as Record<string, unknown>;
    assert.equal(parsed["PORT"], 8080);
    assert.equal(parsed["NODE_ENV"], "development");
  });

  it("direct access still returns the real value", () => {
    const c = impl.loadConfig({ ...REQUIRED, API_TOKEN: "tok_real" });
    assert.equal(c.API_TOKEN, "tok_real", "redaction must not break actually USING the config");
  });

  it("toJSON is non-enumerable", () => {
    const c = impl.loadConfig({ ...REQUIRED });
    assert.ok(!Object.keys(c).includes("toJSON"));
    assert.ok(!JSON.stringify(c).includes("toJSON"));
  });
});

describe("createLogger", () => {
  it("writes NDJSON with the message and fields", () => {
    const { logger, lines } = captureLogger();
    logger.info({ userId: "u1", route: "/x" }, "hello");
    assert.equal(lines.length, 1);
    assert.equal(lines[0]!["msg"], "hello");
    assert.equal(lines[0]!["userId"], "u1");
  });

  it("respects the level", () => {
    const { logger, lines } = captureLogger({ level: "warn" });
    logger.debug("no");
    logger.info("no");
    logger.warn("yes");
    logger.error("yes");
    assert.equal(lines.length, 2);
  });

  it("binds base fields to every line", () => {
    const { logger, lines } = captureLogger({ base: { service: "api" } });
    logger.info("a");
    logger.info("b");
    assert.ok(lines.every((l) => l["service"] === "api"));
  });

  it("child loggers add fields", () => {
    const { logger, lines } = captureLogger();
    logger.child({ requestId: "r1" }).info({ step: "x" }, "in request");
    assert.equal(lines[0]!["requestId"], "r1");
    assert.equal(lines[0]!["step"], "x");
  });

  it("serializes an error with a STRUCTURED cause chain", () => {
    const { logger, lines } = captureLogger();
    const inner = Object.assign(new Error("gateway timeout"), { code: "ETIMEDOUT" });
    logger.error({ err: new Error("checkout failed", { cause: inner }) }, "failed");

    const err = lines[0]!["err"] as Record<string, unknown>;
    assert.equal(err["message"], "checkout failed", "the default serializer flattens cause into the message");
    const cause = err["cause"] as Record<string, unknown> | undefined;
    assert.ok(cause, "cause should be a nested object — use pino.stdSerializers.errWithCause");
    assert.equal(cause["message"], "gateway timeout");
    assert.equal(cause["code"], "ETIMEDOUT", "custom properties on the cause should survive");
  });

  it("redacts the configured paths", () => {
    const { logger, lines } = captureLogger();
    logger.info({ password: "hunter2" }, "a");
    logger.info({ session: { token: "tok_1" } }, "b");
    logger.info({ req: { headers: { authorization: "Bearer x", accept: "*/*" } } }, "c");

    const all = JSON.stringify(lines);
    assert.ok(!all.includes("hunter2"));
    assert.ok(!all.includes("tok_1"));
    assert.ok(!all.includes("Bearer x"));
    assert.ok(all.includes("*/*"), "non-secret headers should survive");
  });

  it("reduces a user object to id + emailDomain", () => {
    const { logger, lines } = captureLogger();
    logger.info(
      { user: { id: "u42", email: "ada@example.com", password: "hunter2", apiKey: "sk_live_x" } },
      "user loaded",
    );

    const user = lines[0]!["user"] as Record<string, unknown>;
    assert.equal(user["id"], "u42");
    assert.equal(user["emailDomain"], "example.com");
    const raw = JSON.stringify(lines[0]);
    assert.ok(!raw.includes("hunter2"), "the serializer should be an allowlist");
    assert.ok(!raw.includes("sk_live_x"), "an unanticipated secret field must not leak");
    assert.ok(!raw.includes("ada@example.com"), "the full address should not be logged");
  });

  it("handles a user without an email", () => {
    const { logger, lines } = captureLogger();
    logger.info({ user: { id: "u1" } }, "x");
    const user = lines[0]!["user"] as Record<string, unknown>;
    assert.equal(user["id"], "u1");
    assert.equal(user["emailDomain"], undefined);
  });
});

describe("request context", () => {
  it("provides a child logger inside the context", async () => {
    const { logger, lines } = captureLogger();
    await impl.withRequestContext(logger, { requestId: "r1" }, () => {
      impl.getRequestLogger()!.info("inside");
    });
    assert.equal(lines[0]!["requestId"], "r1");
  });

  it("is undefined outside a context", () => {
    assert.equal(impl.getRequestLogger(), undefined);
  });

  it("survives awaits, timers and Promise.all", async () => {
    const { logger, lines } = captureLogger();
    await impl.withRequestContext(logger, { requestId: "r1" }, async () => {
      await sleep(5);
      impl.getRequestLogger()!.info("after await");
      await Promise.all([
        (async () => {
          await sleep(1);
          impl.getRequestLogger()!.info("in Promise.all");
        })(),
      ]);
      await new Promise<void>((r) =>
        setTimeout(() => {
          impl.getRequestLogger()!.info("in setTimeout");
          r();
        }, 1),
      );
    });
    assert.equal(lines.length, 3);
    assert.ok(lines.every((l) => l["requestId"] === "r1"));
  });

  it("does not leak between concurrent contexts", async () => {
    const { logger, lines } = captureLogger();
    await Promise.all(
      [
        ["a", 20],
        ["b", 5],
        ["c", 12],
      ].map(([id, ms]) =>
        impl.withRequestContext(logger, { requestId: id as string }, async () => {
          await sleep(ms as number);
          impl.getRequestLogger()!.info({ tag: id }, "done");
        }),
      ),
    );
    assert.equal(lines.length, 3);
    for (const l of lines) {
      assert.equal(l["requestId"], l["tag"], "a line was correlated to the wrong request");
    }
  });

  it("nesting EXTENDS the fields", async () => {
    const { logger, lines } = captureLogger();
    await impl.withRequestContext(logger, { requestId: "r1" }, async () => {
      await impl.withRequestContext(logger, { component: "payments" }, () => {
        impl.getRequestLogger()!.info("nested");
      });
    });
    assert.equal(lines[0]!["requestId"], "r1", "the outer field should still be bound");
    assert.equal(lines[0]!["component"], "payments");
  });

  it("returns the function's value", async () => {
    const { logger } = captureLogger();
    const out = await impl.withRequestContext(logger, { requestId: "r1" }, async () => {
      await sleep(1);
      return 42;
    });
    assert.equal(out, 42);
  });

  it("propagates a rejection", async () => {
    const { logger } = captureLogger();
    await assert.rejects(
      () =>
        impl.withRequestContext(logger, { requestId: "r1" }, async () => {
          throw new Error("boom");
        }),
      /boom/,
    );
  });
});
