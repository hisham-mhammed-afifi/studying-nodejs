/**
 * 01 — Route matching: params, precedence, 404 vs 405
 *
 * Run:  node src/10-routing-middleware/01-routing.ts
 */

console.log("=== 1. Node has no built-in route matcher ===");
// Not in Node 22, and not in the TS lib either — hence the globalThis lookup.
const hasUrlPattern = typeof (globalThis as Record<string, unknown>)["URLPattern"];
console.log(`
  typeof URLPattern === "${hasUrlPattern}"

  The web has URLPattern, but it is not in Node 22. So a router is something
  you write or take a dependency on — there is no third option.

  Fortunately the useful subset is small:

      /users                static     matches exactly
      /users/:id            parameter  one segment, captured
      /files/*path          wildcard   the rest of the path, captured
`);

// ─────────────────────────────────────────────────────────────────────────────
// A minimal trie router. Each node has static children, an optional param
// child, and an optional wildcard.
// ─────────────────────────────────────────────────────────────────────────────

interface Node {
  statics: Map<string, Node>;
  param?: { name: string; node: Node };
  wildcard?: { name: string; handlers: Map<string, string> };
  handlers: Map<string, string>; // method → a label, standing in for a handler
}

const newNode = (): Node => ({ statics: new Map(), handlers: new Map() });

function add(root: Node, method: string, pattern: string, label: string): void {
  let node = root;
  for (const raw of pattern.split("/").filter(Boolean)) {
    if (raw.startsWith("*")) {
      node.wildcard ??= { name: raw.slice(1), handlers: new Map() };
      node.wildcard.handlers.set(method, label);
      return; // a wildcard consumes the rest, so nothing can follow it
    }
    if (raw.startsWith(":")) {
      node.param ??= { name: raw.slice(1), node: newNode() };
      node = node.param.node;
      continue;
    }
    let next = node.statics.get(raw);
    if (!next) {
      next = newNode();
      node.statics.set(raw, next);
    }
    node = next;
  }
  node.handlers.set(method, label);
}

interface MatchResult {
  label?: string;
  params: Record<string, string>;
  /** Methods registered at the matched path — for a 405's Allow header. */
  allowed: string[];
  matchedPath: boolean;
}

function match(root: Node, method: string, pathname: string): MatchResult {
  const segments = pathname.split("/").filter(Boolean).map(decodeSegment);

  function walk(node: Node, i: number, params: Record<string, string>): MatchResult | null {
    if (i === segments.length) {
      if (node.handlers.size === 0) return null;
      return {
        label: node.handlers.get(method),
        params,
        allowed: [...node.handlers.keys()],
        matchedPath: true,
      };
    }

    const segment = segments[i] as string;

    // PRECEDENCE, and it is deliberate: static, then param, then wildcard.
    // Registration order is irrelevant — otherwise /users/me silently becomes
    // { id: "me" } depending on which file imported first.
    const staticChild = node.statics.get(segment);
    if (staticChild) {
      const found = walk(staticChild, i + 1, params);
      if (found) return found;
    }

    if (node.param) {
      const found = walk(node.param.node, i + 1, { ...params, [node.param.name]: segment });
      if (found) return found;
    }

    if (node.wildcard) {
      return {
        label: node.wildcard.handlers.get(method),
        params: { ...params, [node.wildcard.name]: segments.slice(i).join("/") },
        allowed: [...node.wildcard.handlers.keys()],
        matchedPath: true,
      };
    }

    return null;
  }

  return walk(root, 0, {}) ?? { params: {}, allowed: [], matchedPath: false };
}

function decodeSegment(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    // Malformed percent-encoding. A scanner WILL send this.
    throw Object.assign(new Error("malformed percent-encoding"), { statusCode: 400 });
  }
}

// ─────────────────────────────────────────────────────────────────────────────

const router = newNode();
add(router, "GET", "/users", "listUsers");
add(router, "POST", "/users", "createUser");
add(router, "GET", "/users/me", "currentUser"); // static
add(router, "GET", "/users/:id", "getUser"); // param
add(router, "DELETE", "/users/:id", "deleteUser");
add(router, "GET", "/users/:id/posts/:postId", "getPost");
add(router, "GET", "/files/*path", "serveFile");

const show = (method: string, path: string) => {
  const r = match(router, method, path);
  const status = r.label ? 200 : r.matchedPath ? 405 : 404;
  const extra = r.label
    ? Object.keys(r.params).length
      ? ` params=${JSON.stringify(r.params)}`
      : ""
    : r.matchedPath
      ? ` Allow: ${r.allowed.join(", ")}`
      : "";
  console.log(`  ${method.padEnd(7)} ${path.padEnd(30)} → ${status} ${(r.label ?? "—").padEnd(12)}${extra}`);
};

console.log("=== 2. Matching ===");
show("GET", "/users");
show("POST", "/users");
show("GET", "/users/42");
show("DELETE", "/users/42");
show("GET", "/users/42/posts/7");
show("GET", "/files/a/b/c.txt");

console.log("\n=== 3. Precedence: static beats param ===");
show("GET", "/users/me");
show("GET", "/users/mets");
console.log(`
  /users/me matched the STATIC route even though /users/:id was registered
  first and also matches. That is a deliberate rule:

      static  >  parameter  >  wildcard

  Express matches in REGISTRATION order instead, which is why its docs say
  "define specific routes first". That works until two files register routes
  and the winner depends on import order (module 01 §3.3).

  Specificity ordering has no such failure mode, and is what Fastify, Hono
  and most modern routers do.
`);

console.log("=== 4. 404 vs 405 ===");
show("PUT", "/users/42");
show("GET", "/nope");
console.log(`
  PUT /users/42 matched the PATH but not the METHOD → 405 Method Not
  Allowed, and the spec REQUIRES an Allow header listing what is supported.

  GET /nope matched nothing → 404.

  The distinction matters to whoever is debugging: 404 says "this resource
  does not exist", 405 says "it exists, you used the wrong verb". Collapsing
  both into 404 sends people hunting for the wrong bug.
`);

console.log("=== 5. ⚠ Decode AFTER splitting ===");
{
  const encoded = "/users/" + encodeURIComponent("a/b");
  console.log("  encodeURIComponent('a/b') →", encoded);
  console.log("  split then decode:", encoded.split("/").filter(Boolean).map(decodeSegment));
  console.log("  decode then split:", decodeURIComponent(encoded).split("/").filter(Boolean));
  console.log(`
  Decoding first turns %2F back into a "/" and the path gains a segment —
  a user can forge path structure and reach routes you never registered.

  Always split on "/" FIRST, then decode each segment.
`);

  try {
    decodeSegment("%E0%A4%A");
  } catch (err) {
    console.log("  malformed input '%E0%A4%A' →", (err as Error).message, `(${(err as { statusCode: number }).statusCode})`);
  }
  console.log(`
  decodeURIComponent THROWS a URIError on malformed input. Unhandled, that's
  a 500 for a URL some scanner sent — noise in your error budget for a
  request that deserved a 400.
`);
}

console.log("=== 6. Wildcards ===");
show("GET", "/files/deeply/nested/path.txt");
console.log(`
  A wildcard captures the REST of the path, so nothing can follow it in a
  pattern. Mostly useful for static file serving and catch-alls.

  ⚠ If you serve files from a wildcard, the captured value is attacker-
  controlled: "/files/../../etc/passwd". Run it through the realpath-based
  containment check from module 06 §6 before touching the disk.
`);
