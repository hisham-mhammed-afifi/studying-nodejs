/**
 * Tests for exercise 01.
 *
 *   node --test "src/01-modules/*.test.ts"                 → tests YOUR exercise.ts
 *   IMPL=solution node --test "src/01-modules/*.test.ts"   → tests the reference solution
 *
 * Node has a built-in test runner since v18 — no jest, no vitest, no config.
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { ConfigError, LOG_LEVELS, type AppConfig } from "./exercise.ts";

// Swap the implementation under test via env var. Dynamic import so the choice
// can be made at runtime — a static import would be fixed at parse time.
const modulePath = process.env["IMPL"] === "solution" ? "./solution.ts" : "./exercise.ts";

type Impl = {
  loadDefaults(): Promise<Record<string, unknown>>;
  buildConfig(d: Record<string, unknown>, env: NodeJS.ProcessEnv, baseDir: string): AppConfig;
  resolveInDataDir(config: AppConfig, userPath: string): string;
  loadConfig(env?: NodeJS.ProcessEnv): Promise<AppConfig>;
};

let impl: Impl;
before(async () => {
  impl = (await import(modulePath)) as unknown as Impl;
});

const BASE = path.resolve("/srv/app");

describe("loadDefaults", () => {
  it("reads defaults.json regardless of cwd", async () => {
    const original = process.cwd();
    try {
      // Move cwd somewhere unrelated. A cwd-based implementation breaks here.
      process.chdir(path.parse(original).root);
      const d = await impl.loadDefaults();
      assert.equal(d["port"], 3000);
      assert.equal(d["host"], "127.0.0.1");
      assert.equal(d["logLevel"], "info");
      assert.deepEqual(d["features"], []);
    } finally {
      process.chdir(original);
    }
  });
});

describe("buildConfig", () => {
  let defaults: Record<string, unknown>;
  before(async () => {
    defaults = await impl.loadDefaults();
  });

  it("uses defaults when env is empty", () => {
    const c = impl.buildConfig(defaults, {}, BASE);
    assert.equal(c.port, 3000);
    assert.equal(c.host, "127.0.0.1");
    assert.equal(c.logLevel, "info");
    assert.equal(c.dataDir, path.join(BASE, "data"));
    assert.deepEqual([...c.features], []);
  });

  it("env overrides defaults", () => {
    const c = impl.buildConfig(defaults, { APP_PORT: "8080", APP_HOST: "0.0.0.0" }, BASE);
    assert.equal(c.port, 8080);
    assert.equal(typeof c.port, "number", "port must be a number, not the string from env");
    assert.equal(c.host, "0.0.0.0");
  });

  it("accepts every valid log level", () => {
    for (const level of LOG_LEVELS) {
      assert.equal(impl.buildConfig(defaults, { APP_LOG_LEVEL: level }, BASE).logLevel, level);
    }
  });

  it("parses a comma-separated feature list, trimming and dropping empties", () => {
    const c = impl.buildConfig(defaults, { APP_FEATURES: " a, b ,,c " }, BASE);
    assert.deepEqual([...c.features], ["a", "b", "c"]);
  });

  it("resolves a relative dataDir against baseDir, not cwd", () => {
    const c = impl.buildConfig(defaults, { APP_DATA_DIR: "var/store" }, BASE);
    assert.equal(c.dataDir, path.join(BASE, "var", "store"));
  });

  it("honours an absolute dataDir", () => {
    const abs = path.resolve("/mnt/disk");
    const c = impl.buildConfig(defaults, { APP_DATA_DIR: abs }, BASE);
    assert.equal(c.dataDir, abs);
  });

  it("returns a frozen object", () => {
    const c = impl.buildConfig(defaults, {}, BASE);
    assert.ok(Object.isFrozen(c), "config should be frozen");
  });

  for (const [label, env] of [
    ["non-numeric port", { APP_PORT: "abc" }],
    ["empty port (Number('') === 0!)", { APP_PORT: "" }],
    ["fractional port", { APP_PORT: "80.5" }],
    ["port out of range", { APP_PORT: "70000" }],
    ["port zero", { APP_PORT: "0" }],
    ["empty host", { APP_HOST: "" }],
    ["unknown log level", { APP_LOG_LEVEL: "verbose" }],
    ["log level wrong case", { APP_LOG_LEVEL: "INFO" }],
  ] as const) {
    it(`rejects ${label}`, () => {
      assert.throws(() => impl.buildConfig(defaults, env, BASE), ConfigError);
    });
  }
});

describe("resolveInDataDir", () => {
  let config: AppConfig;
  before(async () => {
    config = impl.buildConfig(await impl.loadDefaults(), { APP_DATA_DIR: "/srv/data" }, BASE);
  });

  it("resolves a simple relative path", () => {
    assert.equal(impl.resolveInDataDir(config, "a.txt"), path.join("/srv/data", "a.txt"));
  });

  it("allows nested paths", () => {
    assert.equal(impl.resolveInDataDir(config, "x/y/z.txt"), path.join("/srv/data", "x/y/z.txt"));
  });

  it("allows .. that stays inside", () => {
    assert.equal(impl.resolveInDataDir(config, "x/../y.txt"), path.join("/srv/data", "y.txt"));
  });

  for (const bad of ["../secret", "../../etc/passwd", "/etc/passwd", "", ".", "a/../.."]) {
    it(`rejects ${JSON.stringify(bad)}`, () => {
      assert.throws(() => impl.resolveInDataDir(config, bad), ConfigError);
    });
  }
});

describe("loadConfig", () => {
  it("produces a usable config", async () => {
    const c = await impl.loadConfig({ APP_PORT: "9000" });
    assert.equal(c.port, 9000);
    assert.ok(path.isAbsolute(c.dataDir), "dataDir must be absolute");
  });

  it("bonus: memoises", async () => {
    const a = await impl.loadConfig({});
    const b = await impl.loadConfig({});
    assert.equal(a, b, "repeated calls should return the identical object");
  });
});
