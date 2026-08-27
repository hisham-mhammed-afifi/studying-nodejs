/** Shared helpers for the module 06 demos. */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Creates a temp directory, runs `fn` in it, and always cleans up.
 *
 * mkdtemp creates the directory ATOMICALLY with a random suffix. Building a
 * temp path yourself from Math.random() or a PID and then mkdir-ing it is a
 * classic symlink-attack vector — an attacker who can guess the name can
 * pre-create it as a symlink to somewhere you shouldn't be writing.
 */
export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "node-study-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Narrow `unknown` to a Node errno error, so `.code` is typed. */
export function isErrno(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

/** The `.code` of a thrown errno error, or "(no error)" if `fn` succeeded. */
export async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "(no error)";
  } catch (err) {
    return isErrno(err) ? (err.code ?? "(no code)") : `(not an errno: ${String(err)})`;
  }
}
