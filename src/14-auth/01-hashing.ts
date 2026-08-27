/**
 * 14.1 — Password hashing.
 *
 *   node src/14-auth/01-hashing.ts
 *
 * The one-sentence version: a password hash must be SLOW, and every other
 * decision here follows from that.
 */

import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem?: number },
) => Promise<Buffer>;

// ─────────────────────────────────────────────────────────────────────────────
// 1. Why not SHA-256?
// ─────────────────────────────────────────────────────────────────────────────
// Not because it's "broken" — SHA-256 is a fine cryptographic hash. It is
// wrong for passwords because it is FAST, and speed is the attacker's asset.

console.log("=== 1. sha256 vs scrypt, measured ===");

const SHA_ROUNDS = 200_000;
let shaStart = performance.now();
for (let i = 0; i < SHA_ROUNDS; i++) {
  createHash("sha256").update(`password${i}`).digest();
}
const shaMs = performance.now() - shaStart;
const shaPerSec = Math.round(SHA_ROUNDS / (shaMs / 1000));

const SCRYPT_ROUNDS = 20;
const CHEAP = { N: 2 ** 14, r: 8, p: 1 };
const scryptStart = performance.now();
for (let i = 0; i < SCRYPT_ROUNDS; i++) {
  await scryptAsync(`password${i}`, randomBytes(16), 64, CHEAP);
}
const scryptMs = performance.now() - scryptStart;
const scryptPerSec = SCRYPT_ROUNDS / (scryptMs / 1000);

console.log(`  sha256 : ${shaPerSec.toLocaleString()} hashes/sec`);
console.log(`  scrypt : ${scryptPerSec.toFixed(0)} hashes/sec  (N=2^14)`);
console.log(`  ratio  : ${Math.round(shaPerSec / scryptPerSec).toLocaleString()}× slower`);
console.log(`
  Read that as an attacker with your leaked users table:
  the same wordlist takes ${Math.round(shaPerSec / scryptPerSec).toLocaleString()}× longer to run.
  And the numbers above are CPU-only — a GPU widens the gap for sha256 by
  orders of magnitude more, while scrypt's memory cost resists that.
`);

// ─────────────────────────────────────────────────────────────────────────────
// 2. The cost parameters
// ─────────────────────────────────────────────────────────────────────────────

console.log("=== 2. What N actually costs ===");

for (const exp of [12, 13, 14, 15, 16]) {
  const N = 2 ** exp;
  // scrypt's memory use is roughly 128 * N * r bytes. At N=2^16, r=8 that is
  // 64MB — over Node's DEFAULT maxmem of 32MB.
  const needed = 128 * N * 8;
  const t0 = performance.now();
  try {
    await scryptAsync("correct horse battery staple", randomBytes(16), 64, {
      N,
      r: 8,
      p: 1,
      // Comment this line out and watch 2^16 fail. See §3.
      maxmem: 256 * 1024 * 1024,
    });
    const ms = performance.now() - t0;
    const verdict = ms < 40 ? "too cheap" : ms < 300 ? "good" : "slow for a login";
    console.log(
      `  N=2^${exp} (${N.toString().padStart(5)})  ${ms.toFixed(0).padStart(4)}ms` +
        `  ~${(needed / 1024 / 1024).toFixed(0)}MB   ${verdict}`,
    );
  } catch (err) {
    console.log(`  N=2^${exp}  FAILED: ${(err as Error).message}`);
  }
}
console.log(`
  Target 50-250ms on YOUR hardware. Under 50ms is not enough work;
  over ~250ms and a burst of logins becomes a self-inflicted outage —
  scrypt runs on the libuv thread pool (module 02 §5), which is 4 threads
  by default. Four concurrent logins occupy all of them.
`);

// ─────────────────────────────────────────────────────────────────────────────
// 3. The maxmem trap
// ─────────────────────────────────────────────────────────────────────────────

console.log("=== 3. The failure you only hit when you tune UP ===");

try {
  await scryptAsync("x", randomBytes(16), 64, { N: 2 ** 16, r: 8, p: 1 });
  console.log("  (no error — your Node build has a larger default)");
} catch (err) {
  console.log(`  N=2^16 with default maxmem →`);
  console.log(`    ${(err as Error).message}`);
  console.log(`  Node's default maxmem is 32MB. 128 * 2^16 * 8 = 64MB.`);
  console.log(`  The fix is explicit: { N: 2**16, r: 8, p: 1, maxmem: 128 * 1024 * 1024 }`);
}
console.log(`
  Why this bites: your params work in dev, you raise the cost a year later
  after a security review, and login starts throwing in production only.
`);

// ─────────────────────────────────────────────────────────────────────────────
// 4. Salt: unique, per password, stored in the clear
// ─────────────────────────────────────────────────────────────────────────────

console.log("\n=== 4. The salt ===");

const same = "hunter2";
const a = await scryptAsync(same, randomBytes(16), 32, CHEAP);
const b = await scryptAsync(same, randomBytes(16), 32, CHEAP);
console.log(`  same password, two salts:`);
console.log(`    ${a.toString("hex").slice(0, 32)}…`);
console.log(`    ${b.toString("hex").slice(0, 32)}…`);
console.log(`  → identical? ${a.equals(b)}`);
console.log(`
  That is the salt's whole job:
    • two users with the same password get different hashes, so a breach
      does not reveal WHO shares a password
    • one precomputed rainbow table cannot cover every account
  The salt is NOT a secret. It is stored next to the hash. It stops
  precomputation; it does not stop cracking one hash at a time.
`);

// ─────────────────────────────────────────────────────────────────────────────
// 5. A real hash string: parameters travel WITH the hash
// ─────────────────────────────────────────────────────────────────────────────

console.log("=== 5. Encoding the parameters ===");

const CURRENT = { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };

interface Params {
  N: number;
  r: number;
  p: number;
  maxmem?: number;
}

async function hashPassword(password: string, params: Params = CURRENT): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password.normalize("NFC"), salt, 64, params);
  //          ^^^^^^^^^^^^^^^^^ Unicode normalisation: "café" typed two
  //          different ways is two different byte strings, and the user
  //          cannot see the difference. Normalise on hash AND on verify.
  return [
    "scrypt",
    params.N,
    params.r,
    params.p,
    salt.toString("base64"),
    key.toString("base64"),
  ].join("$");
}

interface VerifyResult {
  valid: boolean;
  /** True when the stored hash used weaker parameters than CURRENT. */
  needsRehash: boolean;
}

async function verifyPassword(stored: string, password: string): Promise<VerifyResult> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return { valid: false, needsRehash: false };

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4]!, "base64");
  const expected = Buffer.from(parts[5]!, "base64");

  // Verify with the hash's OWN parameters, not today's.
  const actual = await scryptAsync(password.normalize("NFC"), salt, expected.length, {
    N,
    r,
    p,
    maxmem: 256 * 1024 * 1024,
  });

  // Constant-time — see 02-timing.ts.
  const valid = actual.length === expected.length && timingSafeEqual(actual, expected);
  return { valid, needsRehash: N < CURRENT.N };
}

const encoded = await hashPassword("hunter2");
console.log(`  ${encoded.slice(0, 60)}…`);
console.log(`  correct password  → ${JSON.stringify(await verifyPassword(encoded, "hunter2"))}`);
console.log(`  wrong password    → ${JSON.stringify(await verifyPassword(encoded, "hunter3"))}`);
console.log(`  garbage in store  → ${JSON.stringify(await verifyPassword("nonsense", "hunter2"))}`);

// ─────────────────────────────────────────────────────────────────────────────
// 6. Upgrading cost, transparently
// ─────────────────────────────────────────────────────────────────────────────

console.log("\n=== 6. Rehash on login ===");

// A hash written years ago, when 2^12 seemed fine.
const legacy = await hashPassword("hunter2", { N: 2 ** 12, r: 8, p: 1 });
const result = await verifyPassword(legacy, "hunter2");
console.log(`  legacy hash (N=2^12) verifies: ${result.valid}`);
console.log(`  needsRehash: ${result.needsRehash}`);

if (result.valid && result.needsRehash) {
  const upgraded = await hashPassword("hunter2");
  console.log(`  → rewritten at N=${CURRENT.N}: ${upgraded.split("$")[1]}`);
}
console.log(`
  Successful login is the ONLY moment you hold the plaintext. If you don't
  rehash there, your oldest and most valuable accounts keep the weakest
  parameters forever — and those are exactly the accounts an attacker wants.

  In a repository (module 13) that is:
    const { valid, needsRehash } = await verifyPassword(user.passwordHash, given);
    if (!valid) throw new InvalidCredentials();
    if (needsRehash) users.updateHash(user.id, await hashPassword(given));
`);

// ─────────────────────────────────────────────────────────────────────────────
// 7. Which hash for which job
// ─────────────────────────────────────────────────────────────────────────────

console.log("=== 7. Slow hash vs fast hash — pick by ENTROPY ===");

const token = randomBytes(32).toString("base64url");
const t0 = performance.now();
const digest = createHash("sha256").update(token).digest("hex");
const fastMs = performance.now() - t0;

console.log(`  session token (256 bits of entropy)`);
console.log(`    sha256 → ${digest.slice(0, 24)}…  in ${fastMs.toFixed(3)}ms`);
console.log(`
  sha256 is CORRECT here and scrypt would be wrong. Slow hashing buys time
  against GUESSING, and a 256-bit random token cannot be guessed — there is
  no wordlist for it. Paying 70ms per request to hash a session token is
  pure cost with no benefit.

    input                          hash with
    ─────────────────────────────  ────────────────────────
    user-chosen password           scrypt / argon2id / bcrypt
    randomBytes(32) session token  sha256
    API key you generated          sha256
    a 6-digit OTP                  rate limiting, not a hash

  The last row matters: a 6-digit code has ~20 bits of entropy. No hash
  saves it — only attempt limits do.
`);

export {};
