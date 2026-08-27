/**
 * 14.6 — Rate limiting, lockout, and the whole flow assembled.
 *
 *   node src/14-auth/06-defences.ts
 *
 * scrypt protects a LEAKED database. It does nothing about someone typing
 * guesses at your login form. That needs counting.
 */

import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt) as (
  pw: string,
  salt: Buffer,
  len: number,
  opts: { N: number; r: number; p: number },
) => Promise<Buffer>;

const PARAMS = { N: 2 ** 14, r: 8, p: 1 }; // deliberately cheap, so this demo finishes

// ─────────────────────────────────────────────────────────────────────────────
// 1. What slow hashing does NOT buy you
// ─────────────────────────────────────────────────────────────────────────────

console.log("=== 1. Two different attacks ===");
console.log(`
  OFFLINE — the attacker has your users table
    They hash candidates on their own hardware, as fast as it goes.
    Your only defence is the cost of the hash. scrypt wins here (14.1 §1).

  ONLINE — the attacker has your login endpoint
    Every guess costs a round trip and you get to SEE it. The hash cost is
    almost irrelevant; what matters is how many guesses you allow.

  Credential stuffing is the online attack that actually happens: a list of
  email/password pairs leaked from somewhere else, replayed against you.
  The passwords are correct, so hash strength is beside the point entirely.
  Only counting — and MFA — stops it.
`);

// ─────────────────────────────────────────────────────────────────────────────
// 2. A fixed window, and why it leaks at the edge
// ─────────────────────────────────────────────────────────────────────────────

console.log("=== 2. Fixed window: simple, and wrong at the boundary ===");

class FixedWindow {
  readonly #hits = new Map<string, { count: number; resetAt: number }>();
  readonly #limit: number;
  readonly #windowMs: number;

  // NB: no `constructor(private limit: number)` — parameter properties are
  // not erasable syntax, so Node's type stripping rejects them (module 01).
  constructor(limit: number, windowMs: number) {
    this.#limit = limit;
    this.#windowMs = windowMs;
  }

  take(key: string, now = Date.now()): boolean {
    const entry = this.#hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.#hits.set(key, { count: 1, resetAt: now + this.#windowMs });
      return true;
    }
    if (entry.count >= this.#limit) return false;
    entry.count++;
    return true;
  }
}

const fixed = new FixedWindow(5, 1000);
const t = 10_000;
let allowed = 0;
for (let i = 0; i < 5; i++) if (fixed.take("ip", t + 900)) allowed++; // end of window 1
for (let i = 0; i < 5; i++) if (fixed.take("ip", t + 1100)) allowed++; // start of window 2
console.log(`  limit 5/second, but 10 requests in 200ms → ${allowed} allowed`);
console.log(`
  The counter resets on a wall-clock boundary, so an attacker who lines up
  with it gets 2× the limit in a fraction of a window. Fine for protecting
  a backend from load; not fine when the limit IS the security control.
`);

// ─────────────────────────────────────────────────────────────────────────────
// 3. A sliding window
// ─────────────────────────────────────────────────────────────────────────────

console.log("=== 3. Sliding window ===");

class SlidingWindow {
  readonly #hits = new Map<string, number[]>();
  readonly #limit: number;
  readonly #windowMs: number;

  constructor(limit: number, windowMs: number) {
    this.#limit = limit;
    this.#windowMs = windowMs;
  }

  take(key: string, now = Date.now()): boolean {
    const cutoff = now - this.#windowMs;
    // Keep only the timestamps still inside the window.
    const recent = (this.#hits.get(key) ?? []).filter((ts) => ts > cutoff);
    if (recent.length >= this.#limit) {
      this.#hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.#hits.set(key, recent);
    return true;
  }

  /** Unbounded growth is a memory leak — an attacker can create keys. */
  sweep(now = Date.now()): number {
    const cutoff = now - this.#windowMs;
    let removed = 0;
    for (const [key, list] of this.#hits) {
      if (list.every((ts) => ts <= cutoff)) {
        this.#hits.delete(key);
        removed++;
      }
    }
    return removed;
  }

  get size(): number {
    return this.#hits.size;
  }
}

const sliding = new SlidingWindow(5, 1000);
allowed = 0;
for (let i = 0; i < 5; i++) if (sliding.take("ip", t + 900)) allowed++;
for (let i = 0; i < 5; i++) if (sliding.take("ip", t + 1100)) allowed++;
console.log(`  same 10 requests in 200ms → ${allowed} allowed`);
console.log(`  and after the window passes: ${sliding.take("ip", t + 2200) ? "allowed" : "blocked"}`);

for (let i = 0; i < 10_000; i++) sliding.take(`ip-${i}`, t);
console.log(`  10,000 distinct keys → map size ${sliding.size}`);
console.log(`  after sweep at t+5s  → map size ${(sliding.sweep(t + 5000), sliding.size)}`);
console.log(`
  Note the sweep. Any per-key limiter keyed on ATTACKER-CONTROLLED input —
  an IP, an email, an API key — is a memory leak the attacker can drive.
  Sweep on a timer (.unref() it), or use a bounded LRU.

  Also note this is per-PROCESS. Behind four workers (module 08) your
  "5 per minute" is really 20. A shared store — Redis, or a database table —
  is what makes the number mean anything.
`);

// ─────────────────────────────────────────────────────────────────────────────
// 4. Per-account backoff
// ─────────────────────────────────────────────────────────────────────────────

console.log("=== 4. Exponential backoff per account ===");

interface Attempts {
  failures: number;
  lockedUntil: number;
}

const attempts = new Map<string, Attempts>();
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 15 * 60 * 1000;
const FREE_ATTEMPTS = 3; // typos happen

function lockState(key: string, now = Date.now()): { locked: boolean; retryInMs: number } {
  const a = attempts.get(key);
  if (!a || a.lockedUntil <= now) return { locked: false, retryInMs: 0 };
  return { locked: true, retryInMs: a.lockedUntil - now };
}

function recordFailure(key: string, now = Date.now()): void {
  const a = attempts.get(key) ?? { failures: 0, lockedUntil: 0 };
  a.failures++;
  if (a.failures > FREE_ATTEMPTS) {
    const delay = Math.min(BASE_DELAY_MS * 2 ** (a.failures - FREE_ATTEMPTS - 1), MAX_DELAY_MS);
    a.lockedUntil = now + delay;
  }
  attempts.set(key, a);
}

function recordSuccess(key: string): void {
  attempts.delete(key);
}

let clock = 0;
for (let i = 1; i <= 10; i++) {
  recordFailure("alice@example.com", clock);
  const { locked, retryInMs } = lockState("alice@example.com", clock);
  const wait = locked ? `${(retryInMs / 1000).toFixed(0)}s` : "—";
  console.log(`  failure ${String(i).padStart(2)} → locked for ${wait.padStart(5)}`);
  clock += retryInMs; // the attacker waits exactly as long as they must
}
console.log(`  total wall-clock cost of 10 guesses: ${(clock / 60_000).toFixed(1)} minutes`);
recordSuccess("alice@example.com");
console.log(`  after a successful login, counter reset: ${JSON.stringify(lockState("alice@example.com", clock))}`);

console.log(`
  Three deliberate choices:
    • the first ${FREE_ATTEMPTS} failures cost nothing — real users mistype
    • the delay doubles, so a human retrying once waits a second while a
      script grinds up to the ${MAX_DELAY_MS / 60_000}-minute cap
    • it CAPS, and it is TEMPORARY. A permanent lock is a denial-of-service
      an attacker can trigger against any user whose email they know: fail
      four times on their account and they are locked out, not you.

  Reset on success — otherwise a user who once fumbled their password
  carries a penalty they cannot see or clear.
`);

// ─────────────────────────────────────────────────────────────────────────────
// 5. Which key to count on
// ─────────────────────────────────────────────────────────────────────────────

console.log("=== 5. Per-account is not enough by itself ===");
console.log(`
  Per ACCOUNT
    stops: someone hammering one user
    misses: PASSWORD SPRAYING — one common password ("Autumn2026!")
            against 50,000 accounts. Every account sees ONE failure.

  Per IP
    stops: spraying from one host
    misses: a botnet; and it punishes a whole office behind one NAT.
            Never lock an IP hard; slow it down.

  Global / per endpoint
    stops: a credential-stuffing flood
    misses: everything targeted. This is a circuit breaker, not a control.

  Run all three. And when you count per IP, get the address right:
  behind a proxy req.socket.remoteAddress is the PROXY. You need
  X-Forwarded-For — but only trusting the hop YOUR proxy added, because
  the client can send that header too (module 09 §3).
`);

// ─────────────────────────────────────────────────────────────────────────────
// 6. Everything, assembled
// ─────────────────────────────────────────────────────────────────────────────

console.log("=== 6. One login function, all defences on ===");

const salt = randomBytes(16);
const users = new Map<string, { id: number; hash: string }>();
users.set("alice@example.com", {
  id: 1,
  hash: (await scryptAsync("correct horse battery staple", salt, 64, PARAMS)).toString("hex"),
});

// Hashed once at startup, so an unknown user costs exactly what a known
// one costs (14.2 §4).
const DUMMY_HASH = (await scryptAsync(randomBytes(32).toString("hex"), salt, 64, PARAMS)).toString("hex");

const sessions = new Map<string, { userId: number; expiresAt: number }>();
const perIp = new SlidingWindow(20, 60_000);

type LoginOutcome =
  | { status: 200; cookie: string }
  | { status: 401; body: { code: "INVALID_CREDENTIALS" } }
  | { status: 429; body: { code: "TOO_MANY_ATTEMPTS" }; retryAfter: number };

async function login(email: string, password: string, ip: string): Promise<LoginOutcome> {
  // 1. Cheap checks first — never spend 70ms of CPU on a request you are
  //    going to reject anyway. That is how a login endpoint becomes a DoS
  //    amplifier against your own thread pool (14.1 §2).
  if (!perIp.take(ip)) {
    return { status: 429, body: { code: "TOO_MANY_ATTEMPTS" }, retryAfter: 60 };
  }
  const lock = lockState(email);
  if (lock.locked) {
    // Same body as any other 429 — do not reveal that this account exists
    // and is locked (14.2 §5).
    return { status: 429, body: { code: "TOO_MANY_ATTEMPTS" }, retryAfter: Math.ceil(lock.retryInMs / 1000) };
  }

  // 2. Always hash, whether or not the user exists.
  const user = users.get(email);
  const stored = user?.hash ?? DUMMY_HASH;
  const attempt = (await scryptAsync(password, salt, 64, PARAMS)).toString("hex");
  const matches = timingSafeEqual(Buffer.from(attempt), Buffer.from(stored));

  if (!user || !matches) {
    recordFailure(email);
    // One status, one code, for both "no such user" and "wrong password".
    return { status: 401, body: { code: "INVALID_CREDENTIALS" } };
  }

  // 3. Success: clear the counter, mint a NEW session (14.3 §5), store only
  //    its hash (14.3 §2), and set a locked-down cookie (14.5 §1).
  recordSuccess(email);
  const raw = randomBytes(32).toString("base64url");
  sessions.set(createHash("sha256").update(raw).digest("hex"), {
    userId: user.id,
    expiresAt: Date.now() + 14 * 24 * 3600_000,
  });
  return {
    status: 200,
    cookie: `__Host-session=${raw}; Max-Age=86400; Path=/; HttpOnly; Secure; SameSite=Lax`,
  };
}

async function show(label: string, email: string, password: string, ip = "203.0.113.9") {
  const t0 = performance.now();
  const out = await login(email, password, ip);
  const ms = (performance.now() - t0).toFixed(0).padStart(3);
  const body = "cookie" in out ? `${out.cookie.slice(0, 38)}…` : JSON.stringify(out.body);
  console.log(`  ${label.padEnd(28)} ${ms}ms  ${out.status}  ${body}`);
}

await show("wrong password", "alice@example.com", "hunter2");
await show("unknown user", "nobody@example.com", "hunter2");
await show("correct", "alice@example.com", "correct horse battery staple");

// Trip the per-account lock.
for (let i = 0; i < 5; i++) await login("alice@example.com", "wrong", "203.0.113.9");
await show("after 5 failures", "alice@example.com", "correct horse battery staple");

// Trip the per-IP limit from a different address.
for (let i = 0; i < 25; i++) await login(`u${i}@example.com`, "spray", "198.51.100.7");
await show("sprayer, 26th attempt", "alice@example.com", "x", "198.51.100.7");

console.log(`
  Look at the first two lines: same status, same body, same time. That is
  the whole of §14.2 in two rows of output.

  Line 4 is the uncomfortable one — the CORRECT password is rejected,
  because the account is locked. That is the cost of lockout, and why the
  free-attempt allowance and the cap in §4 matter. A user who is locked out
  by an attacker is a support ticket; a user locked out permanently is a
  churned customer.

  What is still missing, and matters more than anything above:
    • MFA. Nothing else on this page comes close.
    • Breached-password checks at registration (k-anonymity against
      Have I Been Pwned) — stops the credential stuffing before it starts.
    • Notifying the user: new device, password changed, MFA enrolled.
      Detection, when prevention has already failed.
    • Logging the DECISION, never the credential (module 12 §5).
`);

export {};
