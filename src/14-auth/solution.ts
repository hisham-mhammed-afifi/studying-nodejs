/**
 * SOLUTION 14 — reference implementation.
 */

import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import {
  type CookieOptions,
  CURRENT_PARAMS,
  type JWTClaims,
  type JWTResult,
  type ScryptParams,
  type Session,
  type SessionResult,
  type VerifyResult,
} from "./exercise.ts";

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptParams & { maxmem: number },
) => Promise<Buffer>;

// Node's default is 32MB, which caps N at 2^15. Raise it once, here, so the
// parameters are the only dial (01-hashing.ts §3).
const MAXMEM = 256 * 1024 * 1024;

// --- Task 1 ------------------------------------------------------------------

export function constantTimeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  // Length is not the secret — the attacker knows how long a token is —
  // but timingSafeEqual THROWS on a mismatch, so guard it (02-timing.ts §3).
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** Same idea for Buffers, used by the JWT verifier below. */
function bufferEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

// --- Task 2 ------------------------------------------------------------------

const KEY_LEN = 64;
const SALT_LEN = 16;

export async function hashPassword(
  password: string,
  params: ScryptParams = CURRENT_PARAMS,
): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  // NFC: "café" has two valid UTF-8 encodings and the user cannot see which
  // one their keyboard produced. Normalise on BOTH sides or verification
  // fails for reasons no support ticket will ever explain.
  const key = await scryptAsync(password.normalize("NFC"), salt, KEY_LEN, {
    ...params,
    maxmem: MAXMEM,
  });
  return [
    "scrypt",
    params.N,
    params.r,
    params.p,
    salt.toString("base64"),
    key.toString("base64"),
  ].join("$");
}

export async function verifyPassword(stored: string, password: string): Promise<VerifyResult> {
  const fail: VerifyResult = { valid: false, needsRehash: false };

  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return fail;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  // Number("") is 0 and Number("x") is NaN — both must be rejected, or
  // scrypt throws and a malformed row becomes a 500 instead of a 401.
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return fail;
  if (N < 2 || (N & (N - 1)) !== 0) return fail; // must be a power of two

  const salt = Buffer.from(parts[4]!, "base64");
  const expected = Buffer.from(parts[5]!, "base64");
  if (salt.length === 0 || expected.length === 0) return fail;

  let actual: Buffer;
  try {
    // The STORED parameters, not today's. That is why they are encoded.
    actual = await scryptAsync(password.normalize("NFC"), salt, expected.length, {
      N,
      r,
      p,
      maxmem: MAXMEM,
    });
  } catch {
    return fail;
  }

  return { valid: bufferEqual(actual, expected), needsRehash: N < CURRENT_PARAMS.N };
}

// --- Task 3 ------------------------------------------------------------------

/**
 * sha256, not scrypt. The input is 256 bits of CSPRNG output, so there is
 * nothing to brute-force and nothing for a slow hash to buy (01-hashing §7).
 */
const digest = (token: string) => createHash("sha256").update(token).digest("hex");

export class SessionStore {
  readonly entries = new Map<string, Session>();
  readonly ttlMs: number;

  constructor(ttlMs: number = 14 * 24 * 60 * 60 * 1000) {
    this.ttlMs = ttlMs;
  }

  createSession(userId: number, now: number = Date.now()): string {
    const token = randomBytes(32).toString("base64url");
    // Only the digest is stored. A dump of `entries` is worthless to a
    // reader — that is the entire point (03-sessions.ts §2).
    this.entries.set(digest(token), { userId, expiresAt: now + this.ttlMs });
    return token;
  }

  validateSession(token: string, now: number = Date.now()): SessionResult {
    const key = digest(token);
    const session = this.entries.get(key);
    if (!session) return { ok: false, reason: "unknown" };
    if (session.expiresAt <= now) {
      // Clean up what we happen to touch. A background sweep still has to
      // exist for sessions nobody comes back to (§6).
      this.entries.delete(key);
      return { ok: false, reason: "expired" };
    }
    return { ok: true, userId: session.userId };
  }

  revoke(token: string): void {
    this.entries.delete(digest(token));
  }

  revokeAllForUser(userId: number): number {
    let removed = 0;
    for (const [key, session] of this.entries) {
      if (session.userId === userId) {
        this.entries.delete(key); // safe: Map iteration tolerates deletion
        removed++;
      }
    }
    return removed;
  }

  rotate(oldToken: string | undefined, userId: number, now: number = Date.now()): string {
    // Delete FIRST. If the new token is somehow the same object graph, the
    // order still guarantees the old one cannot survive.
    if (oldToken !== undefined) this.revoke(oldToken);
    return this.createSession(userId, now);
  }

  sweep(now: number = Date.now()): number {
    let removed = 0;
    for (const [key, session] of this.entries) {
      if (session.expiresAt <= now) {
        this.entries.delete(key);
        removed++;
      }
    }
    return removed;
  }
}

// --- Task 4 ------------------------------------------------------------------

const ALG = "HS256";
const b64url = (input: string) => Buffer.from(input, "utf8").toString("base64url");

function hmac(input: string, secret: Buffer | string): Buffer {
  return createHmac("sha256", secret).update(input).digest();
}

export function signToken(claims: JWTClaims, secret: Buffer | string): string {
  const header = b64url(JSON.stringify({ alg: ALG, typ: "JWT" }));
  const payload = b64url(JSON.stringify(claims));
  const signature = hmac(`${header}.${payload}`, secret).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

export function verifyToken(
  token: string,
  secret: Buffer | string,
  now: number = Date.now(),
): JWTResult {
  // Step 1 — shape.
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [header, payload, signature] = parts as [string, string, string];

  // Step 2 — the algorithm WE require, checked against the header. Never
  // "read alg, then dispatch": that is alg:none and RS256→HS256 confusion
  // in one line (04-jwt.ts §3-4).
  let alg: unknown;
  try {
    alg = (JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as { alg?: unknown }).alg;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (alg !== ALG) return { ok: false, reason: "bad-algorithm" };

  // Step 3 — the signature, before a single claim is read.
  if (!bufferEqual(Buffer.from(signature, "base64url"), hmac(`${header}.${payload}`, secret))) {
    return { ok: false, reason: "bad-signature" };
  }

  // Step 4 — only now is the payload attacker-proof enough to parse.
  let claims: JWTClaims;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) return { ok: false, reason: "malformed" };
    claims = parsed as JWTClaims;
  } catch {
    return { ok: false, reason: "malformed" };
  }

  // exp is in SECONDS. Comparing it to Date.now() unscaled expires every
  // token in 1970 — or, the other way round, in the year 57000 (§5).
  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) {
    return { ok: false, reason: "expired" };
  }
  if (claims.exp * 1000 <= now) return { ok: false, reason: "expired" };

  return { ok: true, claims };
}

// --- Task 5 ------------------------------------------------------------------

export function serializeCookie(
  name: string,
  value: string,
  options: CookieOptions = {},
): string {
  const { maxAge, path = "/", domain, httpOnly = true, secure = true, sameSite = "Lax" } = options;
  //                                    ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  //  Safe by default: turning a protection OFF requires typing it.

  // __Host- is enforced by the BROWSER, which silently drops a cookie that
  // breaks the rules. Throwing here turns a silent auth failure in
  // production into a loud one in a test (05-cookies-csrf.ts §2).
  if (name.startsWith("__Host-")) {
    if (!secure) throw new Error("__Host- cookies must be Secure");
    if (domain !== undefined) throw new Error("__Host- cookies must not set Domain");
    if (path !== "/") throw new Error("__Host- cookies must use Path=/");
  }

  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (maxAge !== undefined) parts.push(`Max-Age=${Math.floor(maxAge)}`);
  if (domain !== undefined) parts.push(`Domain=${domain}`);
  parts.push(`Path=${path}`);
  if (httpOnly) parts.push("HttpOnly");
  if (secure) parts.push("Secure");
  parts.push(`SameSite=${sameSite}`);
  return parts.join("; ");
}

export function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;

  for (const pair of header.split(";")) {
    // Split on the FIRST "=" only: base64 padding puts "=" in values.
    const eq = pair.indexOf("=");
    if (eq < 1) continue; // no "=", or an empty name
    const name = pair.slice(0, eq).trim();
    if (name === "") continue;
    if (out.has(name)) continue; // duplicates are legal — first wins

    const raw = pair.slice(eq + 1).trim();
    let value = raw;
    try {
      value = decodeURIComponent(raw);
    } catch {
      // A lone "%" is a URIError. Keep the raw value rather than 500ing on
      // a header the client fully controls.
    }
    out.set(name, value);
  }
  return out;
}

export { CURRENT_PARAMS };
