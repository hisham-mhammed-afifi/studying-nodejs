/** Shared types for the module 10 demos. */

export interface Context {
  method: string;
  path: string;
  /** The matched route PATTERN ("/users/:id"), not the concrete path. */
  route?: string;
  params: Record<string, string>;
  status: number;
  body: unknown;
  /** Middleware scratch space — better than bolting properties onto req. */
  state: Record<string, unknown>;
  /** Demo-only: records the order things happened in. */
  trace: string[];
}

export type Next = () => Promise<void>;
export type Middleware = (ctx: Context, next: Next) => Promise<void> | void;

export function makeContext(method = "GET", path = "/"): Context {
  return { method, path, params: {}, status: 404, body: null, state: {}, trace: [] };
}

/**
 * The whole middleware engine, in ~15 lines. This is koa-compose.
 */
export function compose(middleware: readonly Middleware[]): (ctx: Context) => Promise<void> {
  return function run(ctx: Context): Promise<void> {
    // Guards against next() being called twice in one middleware, which
    // would run everything downstream a second time.
    let lastCalled = -1;

    function dispatch(i: number): Promise<void> {
      if (i <= lastCalled) {
        return Promise.reject(new Error(`next() called multiple times in middleware #${i - 1}`));
      }
      lastCalled = i;

      const fn = middleware[i];
      if (!fn) return Promise.resolve(); // end of the chain

      // Promise.resolve().then() turns a SYNCHRONOUS throw into a rejection,
      // so one .catch() at the call site covers sync and async failures alike.
      return Promise.resolve().then(() => fn(ctx, () => dispatch(i + 1)));
    }

    return dispatch(0);
  };
}
