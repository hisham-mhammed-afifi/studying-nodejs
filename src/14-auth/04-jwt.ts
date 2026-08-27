/**
 * 14.4 — JWT, built and broken by hand.
 *
 *   node src/14-auth/04-jwt.ts
 *
 * A JWT is three base64url strings joined by dots. That's it. Building one
 * takes twenty lines; the interesting part is everything a verifier must
 * refuse.
 */

import {
  createHmac,
  generateKeyPairSync,
  randomBytes,
  sign as cryptoSign,
  timingSafeEqual,
  verify as cryptoVerify,
} from "node:crypto";

const SECRET = randomBytes(32); // in real life: from the environment (module 12)

const b64url = (input: string | Buffer) => Buffer.from(input as never).toString("base64url");
const unb64url = (s: string) => Buffer.from(s, "base64url").toString("utf8");

// ─────────────────────────────────────────────────────────────────────────────
// 1. Building one
// ─────────────────────────────────────────────────────────────────────────────

console.log("=== 1. A JWT, from scratch ===");

interface Claims {
  sub: string;
  iat: number;
  exp: number;
  iss?: string;
  aud?: string;
  [key: string]: unknown;
}

function signJWT(claims: Claims, secret: Buffer): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify(claims));
  const signingInput = `${header}.${payload}`;
  const signature = createHmac("sha256", secret).update(signingInput).digest("base64url");
  return `${signingInput}.${signature}`;
}

const now = Math.floor(Date.now() / 1000); // JWT time is in SECONDS
const jwt = signJWT(
  { sub: "user-42", role: "admin", iat: now, exp: now + 900, iss: "auth.example.com", aud: "api" },
  SECRET,
);

const [h, p, s] = jwt.split(".") as [string, string, string];
console.log(`  header    ${h}`);
console.log(`            → ${unb64url(h)}`);
console.log(`  payload   ${p.slice(0, 48)}…`);
console.log(`            → ${unb64url(p)}`);
console.log(`  signature ${s}`);
console.log(`  length    ${jwt.length} bytes — sent on EVERY request`);

console.log(`
  Note what just happened: the payload printed in plain text, and no key
  was involved in reading it. base64url is ENCODING, not encryption.

    ✗ { sub: 42, email, internalUserId, plan, isEmployee, ssn }
    ✓ { sub: 42, exp }   ← an identifier and a lifetime

  Anything in there is public, permanently, in the user's browser and in
  every proxy log the token passes through.
`);

// ─────────────────────────────────────────────────────────────────────────────
// 2. Verifying one — in the right order
// ─────────────────────────────────────────────────────────────────────────────

console.log("=== 2. Verification, in the only correct order ===");

const EXPECTED = { alg: "HS256", iss: "auth.example.com", aud: "api" } as const;

type VerifyResult = { ok: true; claims: Claims } | { ok: false; reason: string };

function verifyJWT(token: string, secret: Buffer): VerifyResult {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [header, payload, signature] = parts as [string, string, string];

  // STEP 1 — the algorithm YOU chose, checked against the header.
  // Never the other way round. See §3 and §4.
  let alg: unknown;
  try {
    alg = (JSON.parse(unb64url(header)) as { alg?: unknown }).alg;
  } catch {
    return { ok: false, reason: "malformed header" };
  }
  if (alg !== EXPECTED.alg) return { ok: false, reason: `alg ${String(alg)} not accepted` };

  // STEP 2 — the signature, before ANY claim is read.
  const expected = createHmac("sha256", secret).update(`${header}.${payload}`).digest();
  const actual = Buffer.from(signature, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return { ok: false, reason: "bad signature" };
  }

  // STEP 3 — only NOW is the payload trustworthy enough to parse.
  let claims: Claims;
  try {
    claims = JSON.parse(unb64url(payload)) as Claims;
  } catch {
    return { ok: false, reason: "malformed payload" };
  }

  // STEP 4 — the claims. exp is in SECONDS.
  if (typeof claims.exp !== "number") return { ok: false, reason: "no exp" };
  if (claims.exp * 1000 < Date.now()) return { ok: false, reason: "expired" };
  if (claims.iss !== EXPECTED.iss) return { ok: false, reason: "wrong issuer" };
  if (claims.aud !== EXPECTED.aud) return { ok: false, reason: "wrong audience" };

  return { ok: true, claims };
}

console.log(`  genuine token    → ${JSON.stringify(verifyJWT(jwt, SECRET)).slice(0, 72)}…`);
console.log(`  wrong secret     → ${JSON.stringify(verifyJWT(jwt, randomBytes(32)))}`);
console.log(`  tampered payload → ${JSON.stringify(verifyJWT(`${h}.${b64url('{"sub":"user-1","role":"admin"}')}.${s}`, SECRET))}`);
console.log(`  not a jwt        → ${JSON.stringify(verifyJWT("garbage", SECRET))}`);

console.log(`
  The ORDER is load-bearing. Reading exp, sub or role before checking the
  signature means acting on data the attacker wrote. A shockingly common
  shape is:

    const { exp } = jwt.decode(token);        // ✗ decode ≠ verify
    if (exp < Date.now()/1000) return 401;
    const claims = jwt.verify(token, secret);

  …which at least still verifies. The worse version drops step 3 entirely
  and trusts decode(). Any library with a decode() that doesn't verify will
  eventually be used that way by someone on your team.
`);

// ─────────────────────────────────────────────────────────────────────────────
// 3. alg: none
// ─────────────────────────────────────────────────────────────────────────────

console.log("=== 3. The alg:none forgery ===");

// The JWT spec really does define "none" — an unsecured token with an empty
// signature. Every library shipped it. Several accepted it by default.
const forged = `${b64url(JSON.stringify({ alg: "none", typ: "JWT" }))}.${b64url(
  JSON.stringify({ sub: "user-1", role: "superadmin", exp: now + 99999, iss: EXPECTED.iss, aud: EXPECTED.aud }),
)}.`;

console.log(`  forged token: ${forged.slice(0, 56)}…  (note the trailing dot — empty signature)`);
console.log(`  payload:      ${unb64url(forged.split(".")[1]!)}`);

// ✗ The vulnerable verifier: it asks the TOKEN which algorithm to use.
function verifyVulnerable(token: string, secret: Buffer): Claims | null {
  const [header, payload, signature] = token.split(".") as [string, string, string];
  const alg = (JSON.parse(unb64url(header)) as { alg: string }).alg;
  if (alg === "none") return JSON.parse(unb64url(payload)) as Claims; // ← catastrophe
  const expected = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return signature === expected ? (JSON.parse(unb64url(payload)) as Claims) : null;
}

const owned = verifyVulnerable(forged, SECRET);
console.log(`  vulnerable verifier → ${JSON.stringify(owned)}`);
console.log(`  our verifier        → ${JSON.stringify(verifyJWT(forged, SECRET))}`);

console.log(`
  No key. No signature. Full admin. The attacker only had to base64 a JSON
  object, and the header politely told the server not to check anything.

  The fix is not "reject none". The fix is "never read alg from the token":

    ✗ jwt.verify(token, key)                            // library picks
    ✓ jwt.verify(token, key, { algorithms: ["HS256"] })  // you pick

  Pass that option even when your library defaults are safe — defaults
  change, libraries get swapped, and this line documents the intent.
`);

// ─────────────────────────────────────────────────────────────────────────────
// 4. Algorithm confusion: RS256 → HS256
// ─────────────────────────────────────────────────────────────────────────────

console.log("=== 4. Algorithm confusion, demonstrated ===");

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
// The PEM the identity provider publishes — anyone can fetch this.
const pubPem = publicKey.export({ type: "spki", format: "pem" }).toString();

// The legitimate RS256 token: signed with the PRIVATE key.
function signRS256(claims: Claims): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify(claims));
  const sig = cryptoSign("sha256", Buffer.from(`${header}.${payload}`), privateKey);
  return `${header}.${payload}.${sig.toString("base64url")}`;
}

const rsToken = signRS256({ sub: "user-42", role: "user", iat: now, exp: now + 900 });
console.log(`  legitimate RS256 token: ${rsToken.length} bytes`);

// ✗ A verifier that trusts the header and looks up the key by algorithm
//   FAMILY — the exact shape that made this a real CVE class.
function verifyConfusable(token: string): Claims | null {
  const [header, payload, signature] = token.split(".") as [string, string, string];
  const { alg } = JSON.parse(unb64url(header)) as { alg: string };

  if (alg === "RS256") {
    const ok = cryptoVerify(
      "sha256",
      Buffer.from(`${header}.${payload}`),
      publicKey,
      Buffer.from(signature, "base64url"),
    );
    return ok ? (JSON.parse(unb64url(payload)) as Claims) : null;
  }
  if (alg === "HS256") {
    // "It's symmetric, so the key is… the key we have." The public one.
    const expected = createHmac("sha256", pubPem).update(`${header}.${payload}`).digest("base64url");
    return signature === expected ? (JSON.parse(unb64url(payload)) as Claims) : null;
  }
  return null;
}

// The attacker has only the PUBLIC key — which is public, by definition.
const attackerHeader = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
const attackerPayload = b64url(
  JSON.stringify({ sub: "user-42", role: "superadmin", iat: now, exp: now + 99999 }),
);
const attackerSig = createHmac("sha256", pubPem)
  .update(`${attackerHeader}.${attackerPayload}`)
  .digest("base64url");
const confused = `${attackerHeader}.${attackerPayload}.${attackerSig}`;

console.log(`  legit token through confusable verifier → ${JSON.stringify(verifyConfusable(rsToken))}`);
console.log(`  FORGED HS256 token, signed with the PUBLIC key →`);
console.log(`    ${JSON.stringify(verifyConfusable(confused))}`);
console.log(`  our verifier (alg pinned to HS256, secret ≠ pubkey) →`);
console.log(`    ${JSON.stringify(verifyJWT(confused, SECRET))}`);

console.log(`
  Read that again: the attacker escalated "user" to "superadmin" using
  nothing but a value you PUBLISH. RS256 assumes the verifier only holds
  the public key and therefore cannot forge — true, until the verifier is
  talked into treating that public key as an HMAC secret.

  Same one-line fix as §3: pin the algorithm. And keep signing keys and
  HMAC secrets in separate variables so they can never be swapped.
`);

// ─────────────────────────────────────────────────────────────────────────────
// 5. exp: the units bug
// ─────────────────────────────────────────────────────────────────────────────

console.log("=== 5. Seconds, not milliseconds ===");

const secs = Math.floor(Date.now() / 1000);
console.log(`  Math.floor(Date.now()/1000)  ${secs}   ← correct exp base`);
console.log(`  Date.now()                   ${Date.now()}   ← 1000× too large`);
console.log(`  as a date, if you use ms:    ${new Date(Date.now() * 1000).toISOString().split("T")[0]}  ← never expires`);
console.log(`  as a date, if you compare`);
console.log(`  seconds to Date.now():       ${new Date(secs).toISOString().slice(0, 10)}  ← 1970`);

console.log(`
  Two failure modes, both silent:
    exp set in ms   → a token that expires in the year ~57000. Never expires.
    exp compared to
    Date.now()      → every token looks expired since 1970. Nobody logs in.

  The second is caught in the first minute of testing. The FIRST one looks
  like everything works, and ships. Write the check once, in one helper:

    const expired = (claims) => claims.exp * 1000 < Date.now();

  Clock skew: allow a few seconds of tolerance between services, or a token
  minted on a machine 2s fast is rejected by one 2s slow.
`);

// ─────────────────────────────────────────────────────────────────────────────
// 6. The thing a JWT cannot do
// ─────────────────────────────────────────────────────────────────────────────

console.log("=== 6. Revocation ===");

const stolen = signJWT(
  { sub: "user-42", role: "admin", iat: now, exp: now + 3600, iss: EXPECTED.iss, aud: EXPECTED.aud },
  SECRET,
);
console.log(`  A token is stolen. The user changes their password, and you`);
console.log(`  delete every server-side session they have.`);
console.log(`  Is the stolen JWT still valid? ${verifyJWT(stolen, SECRET).ok}`);
console.log(`
  There is no server-side state to delete. The signature is
  still correct, exp is still in the future, so ANY verifier that sees it
  will accept it — for the full remaining lifetime.

  The four ways out, and what each costs:

    1. Short exp (5-15 min) + a refresh token
       The standard answer. The refresh token is stored server-side and
       IS revocable — so you have reinvented sessions, plus a JWT, and
       accepted a revocation window equal to exp.

    2. A denylist of revoked jti values
       Now every request hits a store to check. You have reinvented
       sessions, and kept the 800-byte header.

    3. A "tokens issued before T are invalid" timestamp per user
       Same lookup cost, but O(users) instead of O(tokens). Reasonable.

    4. Rotate the signing key
       Logs out everybody. Fine for an emergency, useless for one user.

  Nobody talks you out of a JWT with theory; they talk you out of it with
  requirement #3 on the ticket: "sign out on all devices".
`);

console.log(`
  When a JWT is genuinely the right tool:
    • service-to-service calls where a shared database is the wrong coupling
    • short-lived access tokens issued by an identity provider you don't run
    • cross-domain SSO, where a cookie cannot reach
  When it isn't:
    • "logged-in user on my own website", which is most of its actual use
`);

export {};
