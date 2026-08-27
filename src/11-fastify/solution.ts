/**
 * SOLUTION 11 — reference implementation.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { AppError, type BuildOptions, type Note, type Store } from "./exercise.ts";

/** Fastify's error shape: an Error with optional statusCode/code/validation. */
type FastifyError = Error & {
  statusCode?: number;
  code?: string;
  validation?: Array<{ instancePath?: string; message?: string }>;
};

// --- Task 1 ------------------------------------------------------------------

export function createStore(): Store {
  const notes = new Map<string, Note>();
  let nextId = 1;

  return {
    list: () => [...notes.values()],
    get: (id) => notes.get(id),
    create({ title, body, authorId }) {
      const note: Note = {
        id: String(nextId++),
        title,
        body,
        authorId,
        internalScore: title.length, // never exposed — see the response schema
      };
      notes.set(note.id, note);
      return note;
    },
    remove: (id) => notes.delete(id),
  };
}

// --- Task 2 ------------------------------------------------------------------

// The privacy boundary. internalScore is ABSENT, so it cannot be sent by
// any route using this schema — regardless of what the store returns
// (03 §1). This is a structural guarantee, not a habit.
const noteResponse = {
  type: "object",
  properties: {
    id: { type: "string" },
    title: { type: "string" },
    body: { type: "string" },
    authorId: { type: "string" },
  },
} as const;

// ⚠ A response schema is an ALLOWLIST, and that cuts both ways: I first
// wrote this without `details`, and the validation details were silently
// STRIPPED from every 400. The test caught it. Whatever you send must be
// declared here — including your error fields (03 §4).
const errorResponse = {
  type: "object",
  properties: {
    code: { type: "string" },
    message: { type: "string" },
    details: {
      type: "array",
      items: {
        type: "object",
        properties: { path: { type: "string" }, issue: { type: "string" } },
      },
    },
  },
} as const;

export function buildApp(options: BuildOptions = {}): FastifyInstance {
  const { store = createStore(), token = "secret", onLog } = options;

  const app = Fastify({ logger: false });

  // ── Infrastructure: SHARED, not encapsulated ────────────────────────────
  // A plain plugin's decorators are trapped in its own scope, so the root
  // instance would not see `app.store`. fastify-plugin marks a plugin to run
  // in the PARENT's scope; it does that by setting this symbol (04 §3).
  const storePlugin = async (parent: FastifyInstance) => {
    parent.decorate("store", store);
  };
  (storePlugin as unknown as Record<symbol, unknown>)[Symbol.for("skip-override")] = true;
  void app.register(storePlugin);

  // ── Errors: MANDATORY. The default leaks err.message (06 §1) ────────────
  app.setErrorHandler((err: FastifyError, req, reply) => {
    // The detail survives here and only here.
    onLog?.(`${req.method} ${req.url}: ${err.message}`);

    // Schema failures are the caller's fault and safe to describe — but map
    // them to OUR shape rather than leaking Ajv's wording.
    if (err.validation) {
      return reply.status(400).send({
        code: "VALIDATION",
        message: "request validation failed",
        details: err.validation.map((v) => ({ path: v.instancePath ?? "", issue: v.message ?? "" })),
      });
    }

    const status = err.statusCode ?? 500;

    // Module 07 §4's operational/programmer split: intentional errors carry
    // their message; anything else gets an opaque 500.
    if (status >= 500) {
      return reply.status(500).send({ code: "INTERNAL", message: "internal server error" });
    }
    return reply.status(status).send({ code: err.code ?? "ERROR", message: err.message });
  });

  app.setNotFoundHandler((req, reply) => {
    reply.status(404).send({ code: "NOT_FOUND", message: `no route for ${req.method} ${req.url}` });
  });

  // ── Public routes, at the root scope ────────────────────────────────────
  app.get(
    "/health",
    { schema: { response: { 200: { type: "object", properties: { status: { type: "string" } } } } } },
    async () => ({ status: "ok" }),
  );

  // ── Protected routes, in their OWN scope ────────────────────────────────
  // Encapsulation is what keeps the auth hook off /health. A global hook
  // with a path allowlist would work today and rot the first time someone
  // adds a public route and forgets to update the list (04 §2).
  void app.register(async (notes: FastifyInstance) => {
    // onRequest, NOT preHandler: an unauthenticated request must never have
    // its body read (05 §2). Rejecting here costs nothing.
    notes.addHook("onRequest", async (req, reply) => {
      const header = req.headers["authorization"];
      if (typeof header !== "string" || !header.startsWith("Bearer ")) {
        return reply.status(401).send({ code: "UNAUTHORIZED", message: "missing bearer token" });
      }
      if (header.slice("Bearer ".length) !== token) {
        return reply.status(401).send({ code: "UNAUTHORIZED", message: "invalid token" });
      }
    });

    notes.get("/", {
      schema: {
        querystring: {
          type: "object",
          properties: { limit: { type: "integer", minimum: 1, maximum: 100, default: 10 } },
        },
        response: {
          200: { type: "object", properties: { items: { type: "array", items: noteResponse } } },
        },
      },
    }, async (req) => {
      // limit is a NUMBER here — schema coercion did that (02 §4).
      const { limit } = req.query as { limit: number };
      return { items: store.list().slice(0, limit) };
    });

    notes.get("/:id", {
      schema: {
        params: { type: "object", properties: { id: { type: "string" } } },
        response: { 200: noteResponse, 404: errorResponse },
      },
    }, async (req) => {
      const { id } = req.params as { id: string };
      const note = store.get(id);
      if (!note) throw new AppError(404, "NOT_FOUND", `note ${id} not found`);
      // Returning the WHOLE note is safe: the schema is an allowlist.
      return note;
    });

    notes.post("/", {
      schema: {
        body: {
          type: "object",
          required: ["title", "body"],
          properties: {
            title: { type: "string", minLength: 1, maxLength: 100 },
            body: { type: "string", maxLength: 10_000 },
            authorId: { type: "string", default: "anonymous" },
          },
          // Mass-assignment defence: extra fields are STRIPPED, so a client
          // cannot smuggle { id: "1", internalScore: 999 } into create()
          // (02 §3).
          additionalProperties: false,
        },
        response: { 201: noteResponse, 400: errorResponse },
      },
    }, async (req, reply) => {
      const input = req.body as { title: string; body: string; authorId: string };
      return reply.status(201).send(store.create(input));
    });

    notes.delete("/:id", {
      schema: {
        params: { type: "object", properties: { id: { type: "string" } } },
        // 204 declared as an empty schema, so reply.send() type-checks.
        response: { 204: { type: "null" }, 404: errorResponse },
      },
    }, async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!store.remove(id)) throw new AppError(404, "NOT_FOUND", `note ${id} not found`);
      // 204 must carry no body (module 09 §3.6).
      return reply.status(204).send();
    });
  }, { prefix: "/notes" });

  // NOT listening. The caller decides: listen() in production, inject() in
  // tests. That one habit is what makes an app testable (06 §4).
  return app;
}

export { AppError };
