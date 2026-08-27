/**
 * 14.2 — Timing attacks, measured honestly.
 *
 *   node src/14-auth/02-timing.ts
 *
 * Two leaks live in this file. The famous one is small. The one nobody
 * writes about is enormous. Guess which one most codebases fix.
 */

import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt) as (
  pw: string,
  salt: Buffer,
  len: number,
  opts: { N: number; r: number; p: number },
) => Promise<Buffer>;

// ─────────────────────────────────────────────────────────────────────────────
// 1. Why `===` leaks
// ─────────────────────────────────────────────────────────────────────────────
// String and Buffer comparison SHORT-CIRCUITS: it returns as soon as it finds
// a difference. So the time it takes tells you how many leading bytes matched.

console.log("=== 1. The leak, in principle ===");
console.log(`
  "aaaa" === "bbbb"   → 1 byte compared, then false
  "aaaa" === "aaab"   → 4 bytes compared, then false

  Byte 4 took longer. An attacker who can time you can therefore brute-force
  a secret ONE BYTE AT A TIME: 256 tries per byte instead of 256^n total.
  That turns an impossible search into a trivial one — in theory.
`);

// ─────────────────────────────────────────────────────────────────────────────
// 2. The leak, measured
// ─────────────────────────────────────────────────────────────────────────────

console.log("=== 2. The leak, in practice ===");

const SIZE = 512;
const secret = randomBytes(SIZE);

const differsEarly = Buffer.from(secret);
differsEarly[0] = secret[0]! ^ 0xff; // wrong at byte 0

const differsLate = Buffer.from(secret);
differsLate[SIZE - 1] = secret[SIZE - 1]! ^ 0xff; // wrong at the last byte

function time(fn: () => void, rounds: number): number {
  fn(); // warm up the JIT — the first calls are interpreted
  const t0 = performance.now();
  for (let i = 0; i < rounds; i++) fn();
  return performance.now() - t0;
}

const ROUNDS = 400_000;
const naiveEarly = time(() => void secret.equals(differsEarly), ROUNDS);
const naiveLate = time(() => void secret.equals(differsLate), ROUNDS);
const safeEarly = time(() => void timingSafeEqual(secret, differsEarly), ROUNDS);
const safeLate = time(() => void timingSafeEqual(secret, differsLate), ROUNDS);

const row = (label: string, e: number, l: number) =>
  `  ${label.padEnd(18)} ${e.toFixed(1).padStart(7)}ms ${l.toFixed(1).padStart(9)}ms   ${(l / e).toFixed(2)}×`;

console.log(`  ${" ".repeat(18)}  differs@0  differs@511   ratio`);
console.log(row("Buffer.equals", naiveEarly, naiveLate));
console.log(row("timingSafeEqual", safeEarly, safeLate));

console.log(`
  Be honest about what that shows. The naive ratio is real but SMALL, and
  it took ${ROUNDS.toLocaleString()} iterations in-process to see it. Across a network,
  one comparison is buried under jitter measured in milliseconds.

  So: this is not the thing that will breach you. But timingSafeEqual costs
  one function call and has no downside, so there is no argument for the
  short-circuiting version. Use it and move on to §4, which is the real bug.
`);

// ─────────────────────────────────────────────────────────────────────────────
// 3. Using timingSafeEqual without crashing
// ─────────────────────────────────────────────────────────────────────────────

console.log("=== 3. The length trap ===");

try {
  timingSafeEqual(Buffer.from("abc"), Buffer.from("abcd"));
} catch (err) {
  console.log(`  timingSafeEqual("abc", "abcd") throws:`);
  console.log(`    ${(err as NodeJS.ErrnoException).code}`);
  console.log(`    ${(err as Error).message}`);
}

console.log(`
  So the naive call is a 500 waiting for a malformed token. Guard the length:
`);

function constantTimeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  // Length is NOT secret here — the attacker knows how long a token is.
  // Leaking it is fine; crashing is not.
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

console.log(`  constantTimeEqual("abc", "abcd") → ${constantTimeEqual("abc", "abcd")}`);
console.log(`  constantTimeEqual("abc", "abc")  → ${constantTimeEqual("abc", "abc")}`);

console.log(`
  If the length genuinely IS secret, hash both sides to a fixed width first:

    const ha = createHash("sha256").update(a).digest();
    const hb = createHash("sha256").update(b).digest();
    return timingSafeEqual(ha, hb);      // always 32 bytes

  That is also the trick for comparing values you cannot guarantee are
  Buffers of equal length — HMAC digests, webhook signatures, API keys.
`);

const hashCompare = (a: string, b: string) =>
  timingSafeEqual(
    createHash("sha256").update(a).digest(),
    createHash("sha256").update(b).digest(),
  );
console.log(`  hashCompare("short", "much longer") → ${hashCompare("short", "much longer")}`);

// ─────────────────────────────────────────────────────────────────────────────
// 4. The leak that actually matters: user enumeration
// ─────────────────────────────────────────────────────────────────────────────

console.log("\n=== 4. The leak that actually matters: user enumeration ===");

const users = new Map<string, string>();
const CHEAP = { N: 2 ** 14, r: 8, p: 1 };
const realSalt = randomBytes(16);
users.set("alice@example.com", (await scryptAsync("hunter2", realSalt, 64, CHEAP)).toString("hex"));

// ✗ The version almost everyone writes.
async function loginNaive(email: string, password: string): Promise<string> {
  const stored = users.get(email);
  if (!stored) return "404 no such user"; // returns in microseconds
  const attempt = await scryptAsync(password, realSalt, 64, CHEAP);
  return attempt.toString("hex") === stored ? "200 ok" : "401 wrong password";
}

// ✓ Always do the same work, always say the same thing.
const DUMMY = (await scryptAsync(randomBytes(32).toString("hex"), randomBytes(16), 64, CHEAP))
  .toString("hex");

async function loginSafe(email: string, password: string): Promise<string> {
  const stored = users.get(email) ?? DUMMY;
  const attempt = await scryptAsync(password, realSalt, 64, CHEAP);
  const ok = users.has(email) && timingSafeEqual(
    Buffer.from(attempt.toString("hex")),
    Buffer.from(stored),
  );
  return ok ? "200 ok" : "401 invalid credentials";
}

async function probe(fn: (e: string, p: string) => Promise<string>, email: string) {
  const t0 = performance.now();
  const res = await fn(email, "guess");
  return { ms: performance.now() - t0, res };
}

const naiveKnown = await probe(loginNaive, "alice@example.com");
const naiveUnknown = await probe(loginNaive, "nobody@example.com");
const safeKnown = await probe(loginSafe, "alice@example.com");
const safeUnknown = await probe(loginSafe, "nobody@example.com");

console.log(`  naive:`);
console.log(`    alice@example.com   ${naiveKnown.ms.toFixed(1).padStart(6)}ms  ${naiveKnown.res}`);
console.log(`    nobody@example.com  ${naiveUnknown.ms.toFixed(1).padStart(6)}ms  ${naiveUnknown.res}`);
console.log(`    → ${(naiveKnown.ms / naiveUnknown.ms).toFixed(0)}× difference, and DIFFERENT status codes`);
console.log(`  safe:`);
console.log(`    alice@example.com   ${safeKnown.ms.toFixed(1).padStart(6)}ms  ${safeKnown.res}`);
console.log(`    nobody@example.com  ${safeUnknown.ms.toFixed(1).padStart(6)}ms  ${safeUnknown.res}`);
console.log(`    → ${(safeKnown.ms / safeUnknown.ms).toFixed(2)}× difference, identical response`);

console.log(`
  Read the ratio with a grain of salt: the user store here is a Map, so the
  "unknown user" path returns in microseconds. Swap in a real database and
  it costs ~1ms, putting the ratio nearer 70×. Either way the shape is the
  same and it is not subtle.

  Compare that with §2. There the leak was ${(naiveLate / naiveEarly).toFixed(2)}× and needed ${ROUNDS.toLocaleString()}
  in-process samples to surface. This one is tens-to-thousands of × and is
  visible in ONE request from a coffee shop. Yet it's the one that gets
  skipped, because it looks like an ordinary early return.

  What it gives an attacker: a validated list of your users. That list is
  sold, credential-stuffed, and phished. For some services — a dating site,
  a medical service, a political org — merely CONFIRMING an account exists
  is itself the harm.
`);

// ─────────────────────────────────────────────────────────────────────────────
// 5. Every endpoint that touches an identifier leaks it
// ─────────────────────────────────────────────────────────────────────────────

console.log("=== 5. The other three places you leak it ===");
console.log(`
  Login is the one people remember. These three are usually wide open:

  Registration
    ✗ 409 "email already registered"
    ✓ 200 "check your inbox" — and email the EXISTING owner a
      "someone tried to register with your address" notice instead

  Password reset
    ✗ 404 "we have no account with that email"
    ✓ 200 "if that address is registered, a link is on its way"
      (and take the same time either way — send via a queue, not inline)

  Rate limiting / lockout
    ✗ 429 "account locked after 5 attempts"  ← confirms the account exists
    ✓ 429 with the same body for every address

  The rule: an unauthenticated caller must not be able to distinguish
  "wrong" from "does not exist" — not by status, body, headers, or time.

  The cost of getting it right is a dummy hash and a shared error string.
  Note the tension with UX: "no account with that email" is genuinely more
  helpful. That's the trade, and for a login form it is not a close call.
`);

export {};
