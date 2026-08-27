/**
 * Tests for exercise 14.
 *
 *   node scripts/test.ts 14              ← your exercise.ts
 *   node scripts/test.ts --solutions 14  ← the reference solution
 */

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { createHash, createHmac, randomBytes } from "node:crypto";
import type {
  CookieOptions,
  JWTClaims,
  JWTResult,
  ScryptParams,
  SessionStore as SessionStoreType,
  VerifyResult,
} from "./exercise.ts";

interface Impl {
  CURRENT_PARAMS: ScryptParams;
  constantTimeEqual(a: string, b: string): boolean;
  hashPassword(password: string, params?: ScryptParams): Promise<string>;
  verifyPassword(stored: string, password: string): Promise<VerifyResult>;
  SessionStore: new (ttlMs?: number) => SessionStoreType;
  signToken(claims: JWTClaims, secret: Buffer | string): string;
  verifyToken(token: string, secret: Buffer | string, now?: number): JWTResult;
  serializeCookie(name: string, value: string, options?: CookieOptions): string;
  parseCookies(header: string | undefined): Map<string, string>;
}

const modulePath = process.env["IMPL"] === "solution" ? "./solution.ts" : "./exercise.ts";
let impl: Impl;
before(async () => {
  impl = (await import(modulePath)) as unknown as Impl;
});

const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64url");

// ─────────────────────────────────────────────────────────────────────────────

describe("Task 1 — constantTimeEqual", () => {
  it("matches equal strings", () => {
    assert.equal(impl.constantTimeEqual("abcdef", "abcdef"), true);
  });

  it("rejects different strings of the same length", () => {
    assert.equal(impl.constantTimeEqual("abcdef", "abcdeg"), false);
  });

  it("returns false rather than throwing on a length mismatch", () => {
    // timingSafeEqual throws ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH; a naive
    // implementation turns a short token into a 500.
    assert.equal(impl.constantTimeEqual("abc", "abcdef"), false);
    assert.equal(impl.constantTimeEqual("", "x"), false);
  });

  it("handles empty strings", () => {
    assert.equal(impl.constantTimeEqual("", ""), true);
  });

  it("compares bytes, not code units", () => {
    // "é" is 2 bytes in UTF-8 but 1 JS character.
    assert.equal(impl.constantTimeEqual("é", "é"), true);
    assert.equal(impl.constantTimeEqual("é", "e"), false); // 2 bytes vs 1
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("Task 2 — password hashing", () => {
  it("produces the documented format", async () => {
    const hash = await impl.hashPassword("hunter2");
    const parts = hash.split("$");
    assert.equal(parts.length, 6);
    assert.equal(parts[0], "scrypt");
    assert.equal(Number(parts[1]), impl.CURRENT_PARAMS.N);
    assert.equal(Number(parts[2]), impl.CURRENT_PARAMS.r);
    assert.equal(Number(parts[3]), impl.CURRENT_PARAMS.p);
    assert.equal(Buffer.from(parts[4]!, "base64").length, 16, "salt should be 16 bytes");
    assert.equal(Buffer.from(parts[5]!, "base64").length, 64, "key should be 64 bytes");
  });

  it("never stores the password", async () => {
    const hash = await impl.hashPassword("hunter2");
    assert.equal(hash.includes("hunter2"), false);
  });

  it("uses a fresh salt every time", async () => {
    const [a, b] = await Promise.all([impl.hashPassword("hunter2"), impl.hashPassword("hunter2")]);
    assert.notEqual(a, b, "same password must not produce the same hash twice");
    assert.notEqual(a.split("$")[4], b.split("$")[4], "the salt must differ");
  });

  it("verifies the correct password", async () => {
    const hash = await impl.hashPassword("correct horse battery staple");
    assert.deepEqual(await impl.verifyPassword(hash, "correct horse battery staple"), {
      valid: true,
      needsRehash: false,
    });
  });

  it("rejects the wrong password", async () => {
    const hash = await impl.hashPassword("hunter2");
    assert.equal((await impl.verifyPassword(hash, "hunter3")).valid, false);
    assert.equal((await impl.verifyPassword(hash, "")).valid, false);
    assert.equal((await impl.verifyPassword(hash, "hunter2 ")).valid, false);
  });

  it("verifies with the STORED parameters, not the current ones", async () => {
    // The whole reason the parameters are encoded: an old hash must still
    // verify after you raise the cost.
    const weak: ScryptParams = { N: 2 ** 12, r: 8, p: 1 };
    const legacy = await impl.hashPassword("hunter2", weak);
    assert.equal(legacy.split("$")[1], String(weak.N));
    const result = await impl.verifyPassword(legacy, "hunter2");
    assert.equal(result.valid, true, "a legacy hash must still verify");
    assert.equal(result.needsRehash, true, "and must be flagged for rehashing");
  });

  it("does not flag a current-cost hash for rehashing", async () => {
    const hash = await impl.hashPassword("hunter2");
    assert.equal((await impl.verifyPassword(hash, "hunter2")).needsRehash, false);
  });

  it("normalises unicode so 'café' verifies either way", async () => {
    const composed = "café"; // é as one code point
    const decomposed = "café"; // e + combining acute
    assert.notEqual(composed, decomposed, "the two spellings differ byte-wise");
    const hash = await impl.hashPassword(decomposed);
    assert.equal(
      (await impl.verifyPassword(hash, composed)).valid,
      true,
      "normalize('NFC') on both sides",
    );
  });

  it("returns false instead of throwing on a malformed stored hash", async () => {
    for (const bad of [
      "",
      "nonsense",
      "scrypt$1$2$3",
      "bcrypt$16384$8$1$c2FsdA==$aGFzaA==",
      "scrypt$notanumber$8$1$c2FsdA==$aGFzaA==",
      "scrypt$$$$$",
      "scrypt$16383$8$1$c2FsdA==$aGFzaA==", // N not a power of two
    ]) {
      const result = await impl.verifyPassword(bad, "hunter2");
      assert.deepEqual(result, { valid: false, needsRehash: false }, `input: ${bad}`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("Task 3 — SessionStore", () => {
  it("issues a 32-byte base64url token", () => {
    const store = new impl.SessionStore();
    const token = store.createSession(1);
    assert.match(token, /^[A-Za-z0-9_-]{43}$/, "base64url, no padding, 256 bits");
  });

  it("issues a different token every time", () => {
    const store = new impl.SessionStore();
    const tokens = new Set(Array.from({ length: 50 }, () => store.createSession(1)));
    assert.equal(tokens.size, 50);
  });

  it("stores the HASH, never the raw token", () => {
    const store = new impl.SessionStore();
    const token = store.createSession(7);
    assert.equal(store.entries.has(token), false, "the raw token must not be a key");
    assert.equal(
      store.entries.has(createHash("sha256").update(token).digest("hex")),
      true,
      "the sha256 hex digest should be the key",
    );
    assert.equal(
      JSON.stringify([...store.entries]).includes(token),
      false,
      "the raw token must not appear anywhere in the store",
    );
  });

  it("validates a live session", () => {
    const store = new impl.SessionStore();
    const token = store.createSession(42, 1000);
    assert.deepEqual(store.validateSession(token, 2000), { ok: true, userId: 42 });
  });

  it("rejects an unknown token", () => {
    const store = new impl.SessionStore();
    assert.deepEqual(store.validateSession("never-issued"), { ok: false, reason: "unknown" });
  });

  it("rejects and deletes an expired session", () => {
    const store = new impl.SessionStore(1000);
    const token = store.createSession(1, 0);
    assert.deepEqual(store.validateSession(token, 999), { ok: true, userId: 1 });
    assert.deepEqual(store.validateSession(token, 1001), { ok: false, reason: "expired" });
    assert.equal(store.entries.size, 0, "an expired row should be cleaned up");
    // Second look: the row is gone, so it reads as unknown.
    assert.deepEqual(store.validateSession(token, 1002), { ok: false, reason: "unknown" });
  });

  it("revokes one session", () => {
    const store = new impl.SessionStore();
    const a = store.createSession(1);
    const b = store.createSession(1);
    store.revoke(a);
    assert.equal(store.validateSession(a).ok, false);
    assert.equal(store.validateSession(b).ok, true, "the other session survives");
  });

  it("revokes every session for one user, and nobody else's", () => {
    const store = new impl.SessionStore();
    const laptop = store.createSession(3);
    const phone = store.createSession(3);
    const other = store.createSession(4);
    assert.equal(store.revokeAllForUser(3), 2);
    assert.equal(store.validateSession(laptop).ok, false);
    assert.equal(store.validateSession(phone).ok, false);
    assert.equal(store.validateSession(other).ok, true);
  });

  it("rotates on login — session fixation", () => {
    const store = new impl.SessionStore();
    const anonymous = store.createSession(0);
    const authed = store.rotate(anonymous, 42);
    assert.notEqual(authed, anonymous);
    assert.deepEqual(store.validateSession(anonymous), { ok: false, reason: "unknown" });
    assert.deepEqual(store.validateSession(authed), { ok: true, userId: 42 });
    assert.equal(store.entries.size, 1, "the old row must be gone, not just orphaned");
  });

  it("rotates with no previous token", () => {
    const store = new impl.SessionStore();
    const token = store.rotate(undefined, 5);
    assert.deepEqual(store.validateSession(token), { ok: true, userId: 5 });
  });

  it("sweeps only expired rows", () => {
    const store = new impl.SessionStore(1000);
    const old = Array.from({ length: 5 }, () => store.createSession(1, 0));
    const fresh = store.createSession(2, 5000);
    assert.equal(store.sweep(2000), 5);
    assert.equal(store.entries.size, 1);
    assert.equal(store.validateSession(fresh, 5001).ok, true);
    assert.equal(store.validateSession(old[0]!, 5001).ok, false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("Task 4 — HS256 tokens", () => {
  const SECRET = Buffer.from("a-secret-that-is-at-least-32-bytes-long");
  const future = Math.floor(Date.now() / 1000) + 3600;

  it("produces three base64url segments with an HS256 header", () => {
    const token = impl.signToken({ sub: "user-42", exp: future }, SECRET);
    const parts = token.split(".");
    assert.equal(parts.length, 3);
    assert.deepEqual(JSON.parse(Buffer.from(parts[0]!, "base64url").toString()), {
      alg: "HS256",
      typ: "JWT",
    });
    assert.match(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it("signs header.payload with HMAC-SHA256", () => {
    const token = impl.signToken({ sub: "user-42", exp: future }, SECRET);
    const [h, p, s] = token.split(".") as [string, string, string];
    const expected = createHmac("sha256", SECRET).update(`${h}.${p}`).digest("base64url");
    assert.equal(s, expected);
  });

  it("round-trips the claims", () => {
    const claims = { sub: "user-42", exp: future, role: "admin" };
    const result = impl.verifyToken(impl.signToken(claims, SECRET), SECRET);
    assert.equal(result.ok, true);
    assert.deepEqual(result.ok && result.claims, claims);
  });

  it("rejects a token signed with a different secret", () => {
    const token = impl.signToken({ sub: "x", exp: future }, SECRET);
    assert.deepEqual(impl.verifyToken(token, randomBytes(32)), {
      ok: false,
      reason: "bad-signature",
    });
  });

  it("rejects a tampered payload", () => {
    const token = impl.signToken({ sub: "user-42", exp: future, role: "user" }, SECRET);
    const [h, , s] = token.split(".") as [string, string, string];
    const swapped = `${h}.${b64url(JSON.stringify({ sub: "user-42", exp: future, role: "admin" }))}.${s}`;
    assert.deepEqual(impl.verifyToken(swapped, SECRET), { ok: false, reason: "bad-signature" });
  });

  it("REJECTS alg:none", () => {
    // The forgery: no key involved, empty signature.
    const forged = `${b64url(JSON.stringify({ alg: "none", typ: "JWT" }))}.${b64url(
      JSON.stringify({ sub: "user-1", role: "superadmin", exp: future }),
    )}.`;
    assert.deepEqual(impl.verifyToken(forged, SECRET), { ok: false, reason: "bad-algorithm" });
  });

  it("rejects any algorithm it did not choose", () => {
    for (const alg of ["RS256", "HS512", "none", "NONE", "", null, 42]) {
      const header = b64url(JSON.stringify({ alg, typ: "JWT" }));
      const payload = b64url(JSON.stringify({ sub: "x", exp: future }));
      // Even with a VALID HMAC over the segments — the algorithm check
      // must come first and must not be satisfiable by the token.
      const sig = createHmac("sha256", SECRET).update(`${header}.${payload}`).digest("base64url");
      assert.deepEqual(
        impl.verifyToken(`${header}.${payload}.${sig}`, SECRET),
        { ok: false, reason: "bad-algorithm" },
        `alg: ${String(alg)}`,
      );
    }
  });

  it("treats exp as SECONDS", () => {
    const now = 1_700_000_000_000; // ms
    const expSeconds = now / 1000 + 60;
    const token = impl.signToken({ sub: "x", exp: expSeconds }, SECRET);
    assert.equal(impl.verifyToken(token, SECRET, now).ok, true);
    // 61 seconds later it must be expired. If the implementation compared
    // exp directly against Date.now(), this would have been expired above.
    assert.deepEqual(impl.verifyToken(token, SECRET, now + 61_000), {
      ok: false,
      reason: "expired",
    });
  });

  it("rejects a missing or non-numeric exp", () => {
    for (const exp of [undefined, "soon", null, NaN]) {
      const token = impl.signToken({ sub: "x", exp } as unknown as JWTClaims, SECRET);
      assert.deepEqual(impl.verifyToken(token, SECRET), { ok: false, reason: "expired" });
    }
  });

  it("checks the signature BEFORE the claims", () => {
    // An expired token with a BAD signature must report the signature —
    // proving the claims were not read from unverified data.
    const past = Math.floor(Date.now() / 1000) - 3600;
    const token = impl.signToken({ sub: "x", exp: past }, SECRET);
    assert.deepEqual(impl.verifyToken(token, randomBytes(32)), {
      ok: false,
      reason: "bad-signature",
    });
  });

  it("never throws on garbage", () => {
    for (const bad of ["", "a", "a.b", "a.b.c.d", "...", "!!!.???.###", "a.b.c"]) {
      assert.doesNotThrow(() => impl.verifyToken(bad, SECRET), `input: ${JSON.stringify(bad)}`);
      assert.equal(impl.verifyToken(bad, SECRET).ok, false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("Task 5 — cookies", () => {
  it("is safe by default", () => {
    const cookie = impl.serializeCookie("session", "abc");
    assert.equal(cookie.includes("HttpOnly"), true);
    assert.equal(cookie.includes("Secure"), true);
    assert.equal(cookie.includes("SameSite=Lax"), true);
    assert.equal(cookie.includes("Path=/"), true);
  });

  it("emits attributes in order, with Max-Age as an integer", () => {
    const cookie = impl.serializeCookie("s", "v", {
      maxAge: 3600.7,
      domain: "example.com",
      sameSite: "Strict",
    });
    assert.equal(cookie, "s=v; Max-Age=3600; Domain=example.com; Path=/; HttpOnly; Secure; SameSite=Strict");
  });

  it("lets a caller turn protections off explicitly", () => {
    const cookie = impl.serializeCookie("csrf", "v", { httpOnly: false, secure: false });
    assert.equal(cookie.includes("HttpOnly"), false);
    assert.equal(cookie.includes("Secure"), false);
  });

  it("percent-encodes the value", () => {
    const cookie = impl.serializeCookie("s", "a b;c=d");
    assert.equal(cookie.startsWith("s=a%20b%3Bc%3Dd;"), true, cookie);
  });

  it("enforces the __Host- rules the browser would enforce silently", () => {
    assert.doesNotThrow(() => impl.serializeCookie("__Host-session", "v", { maxAge: 60 }));
    assert.throws(() => impl.serializeCookie("__Host-session", "v", { secure: false }), /Secure/);
    assert.throws(
      () => impl.serializeCookie("__Host-session", "v", { domain: "example.com" }),
      /Domain/,
    );
    assert.throws(() => impl.serializeCookie("__Host-session", "v", { path: "/app" }), /Path/);
  });

  it("parses a normal header", () => {
    const cookies = impl.parseCookies("theme=dark; session=abc123");
    assert.equal(cookies.get("theme"), "dark");
    assert.equal(cookies.get("session"), "abc123");
    assert.equal(cookies.size, 2);
  });

  it("returns an empty map for a missing header", () => {
    assert.equal(impl.parseCookies(undefined).size, 0);
    assert.equal(impl.parseCookies("").size, 0);
  });

  it("splits on the FIRST '=' only", () => {
    // base64 padding puts "=" inside values.
    assert.equal(impl.parseCookies("s=YWJjZA==").get("s"), "YWJjZA==");
    assert.equal(impl.parseCookies("a=b=c").get("a"), "b=c");
  });

  it("takes the FIRST occurrence of a duplicated name", () => {
    // A subdomain can set a second cookie with the same name; the real one
    // must not be silently overridden.
    assert.equal(impl.parseCookies("session=real; session=EVIL").get("session"), "real");
  });

  it("skips malformed entries", () => {
    const cookies = impl.parseCookies("good=1; ; nonsense; =novalue; also=2");
    assert.deepEqual([...cookies], [["good", "1"], ["also", "2"]]);
  });

  it("decodes percent-encoded values without throwing on bad input", () => {
    assert.equal(impl.parseCookies("s=a%20b").get("s"), "a b");
    assert.doesNotThrow(() => impl.parseCookies("s=100%"));
  });

  it("round-trips with serializeCookie", () => {
    const value = "a b;c=d/é";
    const setCookie = impl.serializeCookie("s", value);
    const header = setCookie.split(";")[0]!;
    assert.equal(impl.parseCookies(header).get("s"), value);
  });
});
