/**
 * 02 — How to match, measured: linear regex vs trie (and ReDoS)
 *
 * Run:  node src/10-routing-middleware/02-matchers.ts
 */

const ROUTES = 500;
const LOOKUPS = 20_000;

// A realistic-ish route table: mostly static, some parameterised.
const patterns: string[] = [];
for (let i = 0; i < ROUTES; i++) {
  patterns.push(
    i % 3 === 0
      ? `/api/v1/resource${i}/:id`
      : i % 3 === 1
        ? `/api/v1/resource${i}/sub${i}/detail`
        : `/api/v1/resource${i}`,
  );
}

// The paths we'll look up — spread across the table, plus some misses.
const lookups: string[] = [];
for (let i = 0; i < LOOKUPS; i++) {
  const n = i % ROUTES;
  lookups.push(
    n % 3 === 0
      ? `/api/v1/resource${n}/12345`
      : n % 3 === 1
        ? `/api/v1/resource${n}/sub${n}/detail`
        : `/api/v1/resource${n}`,
  );
}

// ── Strategy A: a linear scan of compiled regexes (what Express does) ───────

interface RegexRoute {
  re: RegExp;
  keys: string[];
}

function compile(pattern: string): RegexRoute {
  const keys: string[] = [];
  const source = pattern
    .split("/")
    .filter(Boolean)
    .map((seg) => {
      if (seg.startsWith(":")) {
        keys.push(seg.slice(1));
        return "/([^/]+)";
      }
      // ⚠ ESCAPING IS MANDATORY. A route containing "." or "+" becomes a
      // wildcard otherwise — "/v1.0/x" would match "/v1X0/x".
      return "/" + seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("");
  return { re: new RegExp(`^${source}$`), keys };
}

const regexRoutes = patterns.map(compile);

function matchLinear(path: string): Record<string, string> | null {
  for (const route of regexRoutes) {
    const m = route.re.exec(path);
    if (!m) continue;
    const params: Record<string, string> = {};
    route.keys.forEach((k, i) => (params[k] = m[i + 1] as string));
    return params;
  }
  return null;
}

// ── Strategy B: a trie ──────────────────────────────────────────────────────

interface TrieNode {
  statics: Map<string, TrieNode>;
  param?: { name: string; node: TrieNode };
  terminal: boolean;
}

const newNode = (): TrieNode => ({ statics: new Map(), terminal: false });
const trie = newNode();

for (const pattern of patterns) {
  let node = trie;
  for (const seg of pattern.split("/").filter(Boolean)) {
    if (seg.startsWith(":")) {
      node.param ??= { name: seg.slice(1), node: newNode() };
      node = node.param.node;
    } else {
      let next = node.statics.get(seg);
      if (!next) {
        next = newNode();
        node.statics.set(seg, next);
      }
      node = next;
    }
  }
  node.terminal = true;
}

function matchTrie(path: string): Record<string, string> | null {
  const segments = path.split("/");
  const params: Record<string, string> = {};
  let node = trie;

  for (const seg of segments) {
    if (seg === "") continue;
    const staticChild = node.statics.get(seg);
    if (staticChild) {
      node = staticChild;
      continue;
    }
    if (node.param) {
      params[node.param.name] = seg;
      node = node.param.node;
      continue;
    }
    return null;
  }
  return node.terminal ? params : null;
}

// ── Measure ────────────────────────────────────────────────────────────────

function bench(label: string, fn: (p: string) => unknown): number {
  // Warm the JIT, or whichever runs first is unfairly penalised (module 02).
  for (const p of lookups.slice(0, 2_000)) fn(p);

  const t0 = performance.now();
  let hits = 0;
  for (const p of lookups) if (fn(p)) hits++;
  const ms = performance.now() - t0;

  console.log(
    `  ${label.padEnd(28)} ${ms.toFixed(0).padStart(6)}ms total   ${((ms * 1000) / LOOKUPS).toFixed(1).padStart(6)}µs per lookup   (${hits}/${LOOKUPS} matched)`,
  );
  return ms;
}

console.log(`${ROUTES} routes · ${LOOKUPS.toLocaleString()} lookups\n`);
console.log("=== 1. Linear regex scan vs trie ===");
const linearMs = bench("linear regex scan", matchLinear);
const trieMs = bench("trie", matchTrie);

console.log(`
  ${(linearMs / trieMs).toFixed(0)}× difference, and it grows with the route count:

    linear scan   O(routes × segments)   — every miss tests every regex
    trie          O(segments)            — independent of how many routes exist

  At 20 routes nobody notices. At 500 on a hot path it is real: ${((linearMs * 1000) / LOOKUPS).toFixed(0)}µs of
  pure routing on EVERY request, before your handler does anything.

  This is why Express is "slow" in benchmarks and Fastify is not. It isn't
  the framework being careless — it's an O(n) matcher with an ordered-routes
  API, which is a documented feature (module 10 §1.3).
`);

console.log("=== 2. The trie is also simpler ===");
console.log(`
  Look at compile() above. The regex version needs:

      seg.replace(/[.*+?^\${}()|[\\]\\\\]/g, "\\\\$&")

  …because a route like "/v1.0/status" contains a regex metacharacter. Miss
  that escape and "/v1X0/status" matches too. Every regex router has this
  bug at some point in its history.

  The trie compares strings with Map.get(). There is nothing to escape,
  nothing to backtrack, and no way to write a pattern that is accidentally
  a wildcard.
`);

console.log("=== 3. ⚠ ReDoS: why regex routes are a DoS vector ===");
{
  // Nested quantifiers → exponential backtracking on a non-matching input.
  const evil = /^(a+)+$/;
  console.log("  pattern: /^(a+)+$/   input: 'aaa…!' (never matches)\n");

  for (const n of [20, 24, 26, 28]) {
    const input = "a".repeat(n) + "!";
    const t0 = performance.now();
    evil.test(input);
    const ms = performance.now() - t0;
    console.log(`    ${String(n).padStart(2)} chars → ${ms.toFixed(0).padStart(5)}ms`);
    if (ms > 3_000) break;
  }

  console.log(`
  Each extra character roughly DOUBLES the time. 28 characters of user input
  froze this process for over a second — and while it runs, nothing else in
  the entire server happens (module 02 §6): no other requests, no health
  checks, no timers.

  A handful of concurrent requests like that is a complete outage, from a
  payload smaller than a tweet.

  Where this reaches you:
    • user-supplied patterns (search, filters, redirect rules)
    • route patterns built by concatenating unescaped strings
    • validation regexes for email / URL / phone copied off the internet
    • a dependency's route matcher

  Defences:
    • a trie, which cannot backtrack at all
    • linear-time patterns — no nested quantifiers, no (a|a)*
    • RE2 (via the re2 package) for anything user-supplied
    • run untrusted matching in a worker with a timeout (module 08)
`);
}

console.log("=== 4. Choosing ===");
console.log(`
  < 50 routes, not hot          anything works; use what reads best
  many routes, or a hot path    trie
  user-supplied patterns        RE2, or don't
  need full regex routes        keep them in a SEPARATE, short list checked
                                after the trie misses — so the common case
                                stays O(segments)

  And measure before optimising: if your handler takes 20ms, 70µs of routing
  is not your problem (module 02 §6.5).
`);
