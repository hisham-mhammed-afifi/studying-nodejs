/**
 * 14.5 — Cookies and CSRF, over a real server.
 *
 *   node src/14-auth/05-cookies-csrf.ts
 *
 * Cookies are where auth meets the browser, and the browser enforces rules
 * you cannot see from Node. This file makes them visible.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { once } from "node:events";

// ─────────────────────────────────────────────────────────────────────────────
// 1. Serialising a cookie
// ─────────────────────────────────────────────────────────────────────────────

console.log("=== 1. The attributes, and what each one buys ===");

interface CookieOptions {
  maxAge?: number; // seconds
  path?: string;
  domain?: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

function serializeCookie(name: string, value: string, opts: CookieOptions = {}): string {
  // A cookie value cannot contain ; , or whitespace. encodeURIComponent is
  // the standard escape — and base64url values (14.3 §1) need none of it.
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(opts.maxAge)}`);
  if (opts.domain) parts.push(`Domain=${opts.domain}`);
  parts.push(`Path=${opts.path ?? "/"}`);
  if (opts.httpOnly !== false) parts.push("HttpOnly");
  if (opts.secure !== false) parts.push("Secure");
  parts.push(`SameSite=${opts.sameSite ?? "Lax"}`);
  return parts.join("; ");
}

const token = randomBytes(32).toString("base64url");
console.log(`  ${serializeCookie("__Host-session", token, { maxAge: 86400 })}`);
console.log(`
  Attribute     Stops                                            If you omit it
  ───────────   ──────────────────────────────────────────────   ───────────────
  HttpOnly      document.cookie — so XSS cannot READ the token   one XSS = every
                                                                 session stolen
  Secure        the cookie ever going over plain http            any coffee-shop
                                                                 network reads it
  SameSite=Lax  the cookie riding along on a cross-site POST     CSRF
  Path=/        (scoping; not really a security boundary)        —
  Max-Age       a cookie that outlives its session row           a token in the
                                                                 browser forever

  Note the defaults above are the SAFE ones: httpOnly and secure are on
  unless you pass false, sameSite is Lax unless you say otherwise. Build
  your helper that way round — the insecure choice should need typing.
`);

// ─────────────────────────────────────────────────────────────────────────────
// 2. The __Host- prefix
// ─────────────────────────────────────────────────────────────────────────────

console.log("=== 2. __Host- — a rule the BROWSER enforces ===");
console.log(`
  Everything in §1 is a promise you make to yourself. A cookie name
  starting with __Host- is different: the browser REFUSES to store it
  unless all of these hold:

      Secure is set
      Path=/
      Domain is ABSENT

  Rejected by the browser:
    ${serializeCookie("__Host-session", "x", { secure: false })}
    ${serializeCookie("__Host-session", "x", { domain: "example.com" })}
    ${serializeCookie("__Host-session", "x", { path: "/app" })}
  Accepted:
    ${serializeCookie("__Host-session", "x", { maxAge: 3600 })}

  Why "Domain absent" matters: with Domain=example.com, ANY subdomain can
  set that cookie — including the forgotten status page on a shared host,
  or the one a marketing tool controls. That is the delivery mechanism for
  session fixation (14.3 §5). No Domain means "this exact host only", and
  subdomains cannot write it.

  __Host- costs one prefix and closes a hole you cannot otherwise close
  from the server side. There is no downside except that the cookie is
  then genuinely unavailable to subdomains — which is the point.
`);

// ─────────────────────────────────────────────────────────────────────────────
// 3. Parsing — the header can carry more than one
// ─────────────────────────────────────────────────────────────────────────────

console.log("=== 3. Parsing ===");

function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=");
    if (eq < 1) continue; // no "=", or a name of length 0
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    // FIRST wins. A duplicate name (set by a subdomain, or on a different
    // path) must not silently override the real one.
    if (!out.has(name)) out.set(name, decodeURIComponent(value));
  }
  return out;
}

const messy = "theme=dark; __Host-session=abc%3Ddef; __Host-session=EVIL; ; malformed; a=b=c";
console.log(`  raw: ${messy}`);
for (const [k, v] of parseCookies(messy)) console.log(`    ${k.padEnd(16)} ${v}`);
console.log(`
  Three things that trip people up:
    • the header is one string, ";"-separated — split it yourself or use
      a library, but do not regex for one name (a cookie called
      "not-session" contains "session")
    • duplicates are LEGAL. Take the first, or reject the request outright.
    • a value may contain "=" (base64 padding), so split on the FIRST "="
      only — "a=b=c" is a="b=c", not a="b"
`);

// ─────────────────────────────────────────────────────────────────────────────
// 4. CSRF, and why SameSite mostly ends it
// ─────────────────────────────────────────────────────────────────────────────

console.log("=== 4. CSRF ===");
console.log(`
  The attack needs no XSS and no stolen token. evil.com serves:

      <form action="https://bank.example/transfer" method="POST">
        <input name="to" value="attacker"><input name="amount" value="10000">
      </form>
      <script>document.forms[0].submit()</script>

  The victim's browser attaches bank.example's cookies — because they are
  ITS cookies, and the browser does not care who caused the request. The
  server sees a perfectly authenticated transfer.

  Note what the attacker CANNOT do: read the response. This is a
  write-only attack, which is why it targets state changes.

  SameSite=Lax is the modern answer: the cookie is sent on top-level
  navigations (so links into your site still work) but NOT on cross-site
  POST, PUT, DELETE.

    Lax     the default you want
    Strict  also blocks the cookie on inbound LINKS — a user clicking your
            link from an email arrives logged out. Correct for a bank,
            annoying everywhere else.
    None    sends it everywhere; requires Secure; you are back to needing
            a token. Only for genuine cross-site embedding.

  Two traps:
    • Lax does not protect GET. If a GET changes state, SameSite will not
      save you — and it should not have to. Fix the verb.
    • Lax is a BROWSER behaviour. An old browser, or a non-browser client,
      does not apply it. Defence in depth below.
`);

// ─────────────────────────────────────────────────────────────────────────────
// 5. Double-submit, and the Origin check, on a live server
// ─────────────────────────────────────────────────────────────────────────────

console.log("=== 5. Two extra defences, live ===");

const ALLOWED_ORIGINS = new Set(["https://app.example.com", "http://localhost:3000"]);

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function checkCsrf(req: IncomingMessage): { ok: boolean; reason?: string } {
  // Safe methods do not change state, so they need no token — provided
  // that is actually TRUE of your handlers.
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return { ok: true };

  // Defence 1 — Origin. The browser sets it on every state-changing
  // request and a page cannot forge it.
  const origin = req.headers.origin;
  if (origin !== undefined && !ALLOWED_ORIGINS.has(origin)) {
    return { ok: false, reason: `origin ${origin} not allowed` };
  }

  // Defence 2 — double submit. The value is in a cookie AND a header.
  // evil.com can CAUSE the request but cannot READ the cookie to populate
  // the header, because of the same-origin policy.
  const cookies = parseCookies(req.headers.cookie);
  const fromCookie = cookies.get("csrf");
  const fromHeader = req.headers["x-csrf-token"];
  if (!fromCookie || typeof fromHeader !== "string") return { ok: false, reason: "csrf token missing" };
  if (!safeEqual(fromCookie, fromHeader)) return { ok: false, reason: "csrf token mismatch" };

  return { ok: true };
}

const server = createServer((req, res) => {
  if (req.url === "/login") {
    const session = randomBytes(32).toString("base64url");
    const csrf = randomBytes(32).toString("base64url");
    res.setHeader("set-cookie", [
      // The session cookie: unreadable by JavaScript.
      serializeCookie("__Host-session", session, { maxAge: 86400 }),
      // The CSRF cookie: deliberately NOT HttpOnly, because the page's own
      // JavaScript must read it to set the header. It is not a secret in
      // the same sense — it only has to be unguessable by ANOTHER origin.
      serializeCookie("csrf", csrf, { maxAge: 86400, httpOnly: false, secure: false }),
    ]);
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  const verdict = checkCsrf(req);
  res.statusCode = verdict.ok ? 200 : 403;
  res.end(JSON.stringify(verdict));
});

server.listen(0);
await once(server, "listening");
const { port } = server.address() as { port: number };
const base = `http://127.0.0.1:${port}`;

const login = await fetch(`${base}/login`);
const setCookies = login.headers.getSetCookie();
console.log(`  POST /login set ${setCookies.length} cookies:`);
for (const c of setCookies) console.log(`    ${c}`);

const csrfValue = decodeURIComponent(/csrf=([^;]+)/.exec(setCookies[1]!)![1]!);
const cookieHeader = `__Host-session=x; csrf=${encodeURIComponent(csrfValue)}`;

const cases: Array<[string, RequestInit]> = [
  ["no token at all (the CSRF form)", { method: "POST" }],
  ["cookie but no header", { method: "POST", headers: { cookie: cookieHeader } }],
  [
    "wrong header value",
    { method: "POST", headers: { cookie: cookieHeader, "x-csrf-token": "guessed" } },
  ],
  [
    "cookie + matching header",
    { method: "POST", headers: { cookie: cookieHeader, "x-csrf-token": csrfValue } },
  ],
  [
    "matching header, bad Origin",
    {
      method: "POST",
      headers: { cookie: cookieHeader, "x-csrf-token": csrfValue, origin: "https://evil.com" },
    },
  ],
  ["GET (safe method)", { method: "GET" }],
];

for (const [label, init] of cases) {
  const r = await fetch(`${base}/transfer`, init);
  console.log(`  ${label.padEnd(34)} ${r.status}  ${await r.text()}`);
}

server.close();

console.log(`
  The double-submit token does NOT have to be stored server-side, which is
  its whole appeal: the cookie IS the storage. Its security rests entirely
  on the same-origin policy — so it collapses the moment you have XSS, and
  so does everything else on this page.

  A stronger variant signs the CSRF value with the session:
    csrf = hmac(serverSecret, sessionId)
  Now an attacker who can set a cookie on your domain (a subdomain, §2)
  still cannot produce a value that matches the victim's session.
`);

// ─────────────────────────────────────────────────────────────────────────────
// 6. Cookie vs localStorage
// ─────────────────────────────────────────────────────────────────────────────

console.log("=== 6. The localStorage argument ===");

const sessionDigest = createHash("sha256").update(token).digest("hex").slice(0, 16);
console.log(`
                        HttpOnly cookie        localStorage
  readable by XSS       NO                     YES — one line of script
  sent automatically    YES                    no (you attach it)
  vulnerable to CSRF    yes → SameSite fixes   no
  works cross-domain    awkward                easy

  The common claim is "localStorage avoids CSRF, so it's safer". Compare
  the failure modes instead:

    XSS + localStorage → the attacker exfiltrates the token and replays it
                         from their own machine, at leisure, until it
                         expires. You cannot detect it.
    XSS + HttpOnly     → the attacker can still ACT as the user, but only
                         from inside that page, while it is open, and every
                         action goes through your server where you can see
                         and revoke it.

  Both are bad. One is much worse. And the CSRF that localStorage avoids is
  already solved by an attribute you type once.

  (session ${sessionDigest}… — the only form of the token
  that should ever appear in a log line.)
`);

export {};
