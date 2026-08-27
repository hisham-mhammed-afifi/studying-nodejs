/**
 * 14.3 — Sessions: opaque tokens and a server-side store.
 *
 *   node src/14-auth/03-sessions.ts
 *
 * The boring option, and the right default. This file builds one on
 * node:sqlite (module 13) so the storage decisions are visible.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

// ─────────────────────────────────────────────────────────────────────────────
// 1. Generating a token
// ─────────────────────────────────────────────────────────────────────────────

console.log("=== 1. Where the token comes from ===");

// ✗ Math.random() is NOT a CSPRNG. V8 uses xorshift128+, which is fast,
//   statistically excellent, and completely predictable from a few outputs.
const bad = Math.random().toString(36).slice(2);

// ✗ A UUID v4 has 122 bits of entropy — fine, actually — but it is
//   RECOGNISABLE, often logged, and people reuse them as public ids.
const uuid = randomUUID();

// ✓ 256 bits from the OS CSPRNG, URL-safe, no padding.
const token = randomBytes(32).toString("base64url");

console.log(`  Math.random()          ${bad.padEnd(46)} ~52 bits, PREDICTABLE`);
console.log(`  randomUUID()           ${uuid}  122 bits`);
console.log(`  randomBytes(32)        ${token}  256 bits`);
console.log(`
  base64url, not hex: same entropy, 43 chars instead of 64, and no "+/="
  to escape in a cookie or a URL (module 04 §6).

  Why 256 bits and not 64? Guessing is online, so an attacker is rate
  limited — but tokens also end up in logs, referer headers and screenshots.
  32 bytes costs nothing; there is no reason to economise.
`);

// ─────────────────────────────────────────────────────────────────────────────
// 2. Store the HASH, not the token
// ─────────────────────────────────────────────────────────────────────────────

const db = new DatabaseSync(":memory:");
db.exec(`
  CREATE TABLE sessions (
    token_hash  TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    last_seen   INTEGER NOT NULL,
    user_agent  TEXT
  );
  CREATE INDEX idx_sessions_user ON sessions(user_id);
`);

const TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const IDLE_MS = 60 * 60 * 1000; //  1 hour of inactivity

/** sha256 is right here: the input has 256 bits of entropy (01-hashing §7). */
const digest = (t: string) => createHash("sha256").update(t).digest("hex");

const insert = db.prepare(
  `INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen, user_agent)
   VALUES (?, ?, ?, ?, ?, ?)`,
);
const selectByHash = db.prepare("SELECT * FROM sessions WHERE token_hash = ?");
const touch = db.prepare("UPDATE sessions SET last_seen = ? WHERE token_hash = ?");
const deleteByHash = db.prepare("DELETE FROM sessions WHERE token_hash = ?");
const deleteByUser = db.prepare("DELETE FROM sessions WHERE user_id = ?");
const deleteExpired = db.prepare("DELETE FROM sessions WHERE expires_at < ?");

interface SessionRow {
  token_hash: string;
  user_id: number;
  created_at: number;
  expires_at: number;
  last_seen: number;
  user_agent: string | null;
}

function createSession(userId: number, userAgent?: string): string {
  const raw = randomBytes(32).toString("base64url");
  const now = Date.now();
  // Only the HASH is written. The raw token exists in memory here and in the
  // user's cookie — nowhere else, ever.
  insert.run(digest(raw), userId, now, now + TTL_MS, now, userAgent ?? null);
  return raw;
}

console.log("=== 2. What lands in the database ===");
const session = createSession(1, "Mozilla/5.0");
const stored = selectByHash.get(digest(session)) as unknown as SessionRow;
console.log(`  cookie value : ${session}`);
console.log(`  sessions row : ${stored.token_hash.slice(0, 32)}…`);
console.log(`
  A session token in your database is a PASSWORD EQUIVALENT: anyone who can
  read that table — a SQL injection, a leaked backup, an over-broad support
  tool, a stray log line — can impersonate every logged-in user without ever
  touching a password.

  Hashing at rest breaks that. The table becomes useless to a reader,
  because sha256 is one-way and the token is unguessable.

  You lose nothing: lookup is still a single indexed hit on the hash.
`);

// ─────────────────────────────────────────────────────────────────────────────
// 3. Validation: two clocks, and why no timingSafeEqual appears here
// ─────────────────────────────────────────────────────────────────────────────

console.log("=== 3. Validating ===");

type ValidationResult =
  | { ok: true; userId: number }
  | { ok: false; reason: "unknown" | "expired" | "idle" };

function validateSession(raw: string): ValidationResult {
  const hash = digest(raw);
  const row = selectByHash.get(hash) as unknown as SessionRow | undefined;

  // The lookup is by PRIMARY KEY, so this is not a byte-wise comparison an
  // attacker can time — SQLite compares an index key, and the value it
  // compares is a hash of the secret, not the secret.
  if (!row) return { ok: false, reason: "unknown" };

  const now = Date.now();
  if (row.expires_at < now) {
    deleteByHash.run(hash); // clean up as you go
    return { ok: false, reason: "expired" };
  }
  if (now - row.last_seen > IDLE_MS) {
    deleteByHash.run(hash);
    return { ok: false, reason: "idle" };
  }

  // Sliding window: active sessions stay alive. Note this is a WRITE on every
  // request — throttle it (only update if last_seen is > 60s old) or you
  // have turned every page view into a database write.
  if (now - row.last_seen > 60_000) touch.run(now, hash);

  return { ok: true, userId: row.user_id };
}

console.log(`  valid token      → ${JSON.stringify(validateSession(session))}`);
console.log(`  unknown token    → ${JSON.stringify(validateSession("not-a-real-token"))}`);

// Force an expiry to show the path.
const expiring = createSession(2);
db.prepare("UPDATE sessions SET expires_at = ? WHERE token_hash = ?").run(
  Date.now() - 1,
  digest(expiring),
);
console.log(`  expired token    → ${JSON.stringify(validateSession(expiring))}`);
console.log(`  (and again)      → ${JSON.stringify(validateSession(expiring))}  ← row was deleted`);

console.log(`
  Two clocks, not one:
    expires_at — an absolute cap. "You will log in again in 14 days."
    last_seen  — idle timeout. A forgotten session on a shared machine dies.
  A banking app makes both short; a note-taking app makes both long. What
  you must not do is have neither.
`);

// ─────────────────────────────────────────────────────────────────────────────
// 4. Revocation — the thing a JWT cannot do
// ─────────────────────────────────────────────────────────────────────────────

console.log("=== 4. Revocation ===");

const laptop = createSession(3, "Chrome/Mac");
const phone = createSession(3, "Safari/iOS");
const tablet = createSession(3, "Safari/iPad");
const count = () =>
  (db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = 3").get() as { n: number }).n;

console.log(`  user 3 has ${count()} sessions`);

// Log out of this device.
deleteByHash.run(digest(phone));
console.log(`  after logout on phone: ${count()} — ${JSON.stringify(validateSession(phone))}`);

// "Sign out everywhere" — the button you press after a password change,
// a breach notification, or a stolen laptop.
deleteByUser.run(3);
console.log(`  after sign-out-everywhere: ${count()}`);
console.log(`  laptop: ${JSON.stringify(validateSession(laptop))}`);
console.log(`  tablet: ${JSON.stringify(validateSession(tablet))}`);

console.log(`
  One DELETE and every stolen token is dead — instantly, everywhere.
  This is the entire argument for sessions. Look at 04-jwt.ts §6 for what
  the same requirement costs with a self-contained token.

  Storing user_agent (and IP, and created_at) is what powers a
  "devices signed in" screen. Cheap to add, and users expect it.
`);

// ─────────────────────────────────────────────────────────────────────────────
// 5. Session fixation, and rotating on login
// ─────────────────────────────────────────────────────────────────────────────

console.log("=== 5. Fixation ===");
console.log(`
  The attack, in four steps:
    1. Attacker visits your site and gets an anonymous session token T
       (you issue one to track a shopping cart, a locale, a CSRF secret)
    2. Attacker gets the victim to use T — a crafted link, an XSS,
       a subdomain that can set cookies on the parent domain
    3. Victim logs in. You keep T and just attach user_id to it.
    4. The attacker's copy of T is now an AUTHENTICATED session.

  The fix is one line: issue a NEW token on login and delete the old one.
`);

function loginRotating(anonymousToken: string | undefined, userId: number): string {
  if (anonymousToken) deleteByHash.run(digest(anonymousToken));
  return createSession(userId);
}

const anon = createSession(0);
console.log(`  anonymous token : ${anon.slice(0, 16)}…`);
const authed = loginRotating(anon, 42);
console.log(`  after login     : ${authed.slice(0, 16)}…  (different)`);
console.log(`  old token now   : ${JSON.stringify(validateSession(anon))}`);
console.log(`
  Rotate on: login, logout, password change, email change, MFA enrolment,
  and any elevation of privilege. Anywhere the ANSWER to "who is this?"
  changes, the token should change with it.

  Carry over only the data that is safe to carry — a cart, a theme — never
  anything that implies authorisation.
`);

// ─────────────────────────────────────────────────────────────────────────────
// 6. Cleanup: expired rows do not remove themselves
// ─────────────────────────────────────────────────────────────────────────────

console.log("=== 6. Sweeping ===");

for (let i = 0; i < 500; i++) createSession(1000 + i);
db.prepare("UPDATE sessions SET expires_at = ? WHERE user_id > 1000").run(Date.now() - 1);

const before = (db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n;
const { changes } = deleteExpired.run(Date.now());
const after = (db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n;

console.log(`  ${before} rows → deleted ${changes} expired → ${after} remain`);
console.log(`
  Nothing deletes them for you. §3 cleans up rows it happens to touch, but
  a user who never comes back leaves a row forever. Run this on a timer:

    setInterval(() => deleteExpired.run(Date.now()), 60 * 60 * 1000).unref();
                                                                    ^^^^^^^
    .unref() so the sweep does not hold the process open (module 02 §4)
    and does not block a graceful shutdown (module 09 §7).

  In a multi-process deployment this belongs in ONE place — a cron job or
  a leader — not in every worker (module 08 §6).
`);

db.close();
export {};
