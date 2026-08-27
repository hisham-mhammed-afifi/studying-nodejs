# 14 — Authentication

Everything here uses `node:crypto` — no dependencies. The goal isn't to make you roll your own auth in production (use a library, or a provider), it's to make the library's choices legible so you can tell a good one from a bad one, and so you can review the code that uses it.

> **A standing caveat.** Auth is the area where "I built it myself" ages worst. Understand these mechanisms; then use `@node-rs/argon2` or `oslo`, or an identity provider, for anything real. What follows is the reasoning, not a recommendation to ship it.

---

## 1. Passwords: never store them, and never hash them fast

A password hash's job is to be **slow**. That's the entire design goal.

Measured, single-threaded, on this machine (`01-hashing.ts` re-runs it on yours):

| | Rate |
|---|---|
| `sha256` | **~610,000 / sec** |
| `scrypt` (N=2^14) | **~33 / sec** |

**Roughly 19,000× slower.** For your login endpoint, 30ms is invisible. For an attacker with a leaked database and a wordlist, it's the difference between cracking every weak password over lunch and not bothering.

That's why SHA-256, MD5 and "SHA-256 with a salt" are all wrong for passwords: they're *designed* to be fast, and a GPU does billions per second.

### 1.1 `scrypt`, in Node

```ts
import { scrypt, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt) as
  (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;

const PARAMS = { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);                       // unique PER PASSWORD
  const key = await scryptAsync(password, salt, 64, PARAMS);
  // Store the parameters WITH the hash — see §1.3.
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}
```

| Parameter | Meaning |
|---|---|
| `N` | CPU/memory cost. Must be a power of 2. **This is the dial.** |
| `r` | Block size, 8 is standard |
| `p` | Parallelisation, 1 is standard |
| `maxmem` | Node's guard rail — see below |

Measured cost:

| N | Time |
|---|---|
| 2^14 | 34ms |
| 2^15 | 71ms |
| 2^16 | 141ms |

⚠ **Node's default `maxmem` is 32MB, and N=2^16 exceeds it**: `Invalid scrypt params: …memory limit exceeded`. You must raise `maxmem` explicitly for higher costs — a failure that only appears when you tune upward.

Aim for **50–250ms** per hash on your hardware. Then remember it's synchronous CPU work on the libuv thread pool (module 02 §5): four concurrent logins occupy all four default threads, so a login-heavy service wants `UV_THREADPOOL_SIZE` raised.

### 1.2 Use argon2id if you can

`scrypt` is good and built in. **Argon2id** is the current recommendation (it's the Password Hashing Competition winner, and resists GPU attacks better). It needs a dependency — `@node-rs/argon2` — but it's the right default for new systems. bcrypt remains acceptable; it caps input at 72 bytes, which is a real gotcha.

### 1.3 Store the parameters with the hash

```
scrypt$32768$8$1$<salt-b64>$<hash-b64>
```

Because cost must increase over time. With parameters embedded you can verify old hashes with their original settings and **re-hash on successful login**:

```ts
const { valid, needsRehash } = await verifyPassword(stored, given);
if (valid && needsRehash) await users.updateHash(id, await hashPassword(given));
```

Login is the only moment you'll ever have the plaintext. Use it.

---

## 2. Timing, honestly

`===` and `Buffer.equals` return as soon as they find a difference, so they leak how many leading bytes matched. Measured over 400,000 comparisons of a 512-byte secret:

| | differs at byte 0 | differs at byte 511 | ratio |
|---|---|---|---|
| `Buffer.equals` | 23ms | 25ms | **1.12×** |
| `timingSafeEqual` | 131ms | 118ms | 0.90× (noise) |

The leak is **real but small**, and across a network a single comparison is buried in jitter. An attacker needs many samples and statistics to extract it — which is entirely feasible for a determined one, and irrelevant for most.

The honest conclusion: this is not the vulnerability that will get you breached, but the defence is one function call and has no downside.

```ts
import { timingSafeEqual } from "node:crypto";

function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;   // it THROWS on length mismatch
  return timingSafeEqual(a, b);
}
```

Use it for session tokens, API keys, HMAC signatures, webhook secrets, password-reset tokens — anything an attacker can submit repeatedly.

⚠ Note the length guard. `timingSafeEqual` throws `ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH` on differing lengths, so the naive call is a crash waiting for a malformed token.

---

## 3. The bigger leak: user enumeration

```ts
// ✗ tells an attacker which emails are registered
if (!user) return reply.status(404).send({ error: "no such user" });
if (!valid) return reply.status(401).send({ error: "wrong password" });
```

Same status, same message, and — critically — **the same amount of work**:

```ts
// ✓ hash even when the user doesn't exist, so the timing matches
const user = await users.findByEmail(email);
const stored = user?.passwordHash ?? DUMMY_HASH;
const { valid } = await verifyPassword(stored, password);
if (!user || !valid) return reply.status(401).send({ code: "INVALID_CREDENTIALS" });
```

Without the dummy hash, a missing user returns in ~1ms and a real one in ~70ms. That 70× difference is trivially measurable over a network — far more so than §2's byte-level leak. **This is the timing attack that actually matters**, and it's the one people skip.

Registration and password reset leak the same way. "An email has been sent" for every address, always.

---

## 4. Sessions vs JWT

The most over-argued decision in web development. The honest summary:

| | Session (opaque token + server store) | JWT (signed, self-contained) |
|---|---|---|
| Revocation | **immediate** — delete the row | **impossible** until it expires |
| Server state | a row per session | none |
| Size | ~32 bytes | 300–800 bytes, on every request |
| Reading it | one indexed lookup | signature verify, no I/O |
| Contents visible to client | no | **yes** — base64, not encrypted |
| Failure mode | lose the store, everyone logs out | leak the key, forge anything |

**Default to sessions.** For a normal web app with a database you already query, an indexed lookup is microseconds, and being able to revoke a session — on logout, on password change, on "sign out everywhere", on a breach — is worth far more than saving one query.

JWTs earn their place for **stateless service-to-service** calls, short-lived access tokens paired with refresh tokens, and cross-domain SSO. They're a poor fit for "logged-in user on my website", which is what they're most often used for.

### 4.1 Session tokens: hash them at rest

A session token in your database is a **password equivalent**. Anyone with read access to that table can impersonate every logged-in user.

```ts
const token = randomBytes(32).toString("base64url");   // → the client
const lookup = createHash("sha256").update(token).digest("hex");  // → the database
```

SHA-256 is correct here, and scrypt would be wrong: the token already has 256 bits of entropy, so there's nothing to brute-force. Slow hashing defends against *guessable* inputs; a random token isn't one.

### 4.2 Rotate on privilege change

Regenerate the session id on login and on any privilege elevation. Otherwise **session fixation**: an attacker plants a known session id, waits for the victim to log in with it, and inherits the authenticated session.

---

## 5. JWT, if you must

A JWT is three base64url segments: `header.payload.signature`. The payload is **encoded, not encrypted** — anyone can read it. Never put anything secret in a JWT.

### 5.1 The `alg: none` attack

The original JWT spec allows `"alg": "none"` — a token with an empty signature. A verifier that trusts the header's `alg` accepts a forged token outright.

```ts
// ✗ the vulnerability, in one line
const alg = JSON.parse(header).alg;
if (alg === "none") return JSON.parse(payload);   // catastrophic
```

**Never read the algorithm from the token.** You decide it:

```ts
const EXPECTED_ALG = "HS256";
if (header.alg !== EXPECTED_ALG) throw new Error("unexpected algorithm");
```

### 5.2 Algorithm confusion (HS256 vs RS256)

If you verify with a library that picks the algorithm from the header, and your app uses RS256, an attacker can re-sign a token as **HS256 using your public key as the HMAC secret**. The public key is public — so the forgery verifies.

Same fix: pin the algorithm, and never let the token choose.

### 5.3 Always check `exp` — and check it yourself

```ts
if (typeof payload.exp !== "number" || payload.exp * 1000 < Date.now()) {
  throw new Error("token expired");
}
```

`exp` is in **seconds**, `Date.now()` in milliseconds. Getting that wrong by 1000× means tokens that expire in 1970 or in the year 57000. Verify the signature *first*, then the claims — an expired-token check on an unverified payload is meaningless.

Also validate `iss` and `aud` if you use them. A token minted for a different service is not a token for yours.

---

## 6. Cookies

```ts
res.setHeader("set-cookie", [
  `__Host-session=${token}`,
  "HttpOnly",          // JavaScript cannot read it → XSS can't steal it
  "Secure",            // HTTPS only
  "SameSite=Lax",      // not sent on cross-site POSTs → CSRF defence
  "Path=/",
  "Max-Age=86400",
].join("; "));
```

| Attribute | Defends against |
|---|---|
| `HttpOnly` | XSS reading the token |
| `Secure` | network interception |
| `SameSite=Lax` | most CSRF |
| `__Host-` prefix | subdomain injection — the browser *enforces* Secure + Path=/ + no Domain |

`SameSite=Lax` is the sensible default: sent on top-level navigations, not on cross-site POSTs. `Strict` breaks inbound links from other sites. `None` requires `Secure` and reopens CSRF.

### 6.1 CSRF

`SameSite=Lax` covers most of it. For state-changing requests that need more, the standard pattern is **double-submit**: a random value in both a cookie and a header/field, compared with `timingSafeEqual`. The attacker's site can *cause* a request but cannot *read* your cookie to populate the header.

The other reliable check is `Origin`: on any state-changing request, compare it against an allowlist.

> **Storing tokens in `localStorage` is worse than a cookie**, despite the common claim. `localStorage` is readable by any XSS; an `HttpOnly` cookie is not. The "CSRF" objection to cookies is answered by `SameSite`.

---

## 7. Brute force

Hashing slowly protects a *leaked database*. It does nothing for online guessing — that needs rate limiting:

- **Per account:** exponential backoff after failures. Lock temporarily, never permanently (that's a denial-of-service someone can trigger on your users).
- **Per IP:** catches spraying, but a NAT is one IP for a whole office.
- **Global:** a circuit breaker for credential-stuffing floods.
- **Never reveal** whether the lockout is because the account exists (§3).

Add MFA for anything that matters. It's the single largest improvement available, and it's more effective than every other item on this page combined.

---

## 8. Files in this module

| File | What it demonstrates |
|---|---|
| `01-hashing.ts` | why not SHA-256, scrypt params measured, the `maxmem` trap, rehashing |
| `02-timing.ts` | the byte-level leak measured, and the far bigger enumeration leak |
| `03-sessions.ts` | token generation, hashing at rest, expiry, rotation, fixation |
| `04-jwt.ts` | build and verify HS256 by hand; `alg:none` and confusion attacks |
| `05-cookies-csrf.ts` | cookie attributes, `__Host-`, `SameSite`, double-submit CSRF |
| `06-defences.ts` | rate limiting, lockout, and a login flow with everything wired up |
| `exercise.ts` | build the toolkit: hashing, sessions, tokens, constant-time compare |

```bash
node src/14-auth/index.ts
node scripts/test.ts 14
node scripts/test.ts --solutions 14
```

---

## 9. Check yourself

1. Why is "SHA-256 with a salt" wrong for passwords, given the salt defeats rainbow tables?
2. `scrypt` with N=2^16 throws. Why, and what's the fix?
3. Which timing leak is bigger — a byte-wise `equals`, or a login that skips hashing for unknown users?
4. Your session table leaks. Why does it matter less if you hashed the tokens, and why is SHA-256 the right hash there?
5. A JWT arrives with `"alg": "none"`. What must your verifier do?
6. Why is `exp: 1735689600` compared against `Date.now()` a bug?
7. `localStorage` or an `HttpOnly` cookie for a session token, and why?
8. Slow hashing protects against which attack, and *not* which?
