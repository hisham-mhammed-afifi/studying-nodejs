/**
 * Shared by the module-15 demos: write a throwaway test file and run it
 * under `node --test`, then show what the runner actually did.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "node-study-15-"));

export interface RunResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  ms: number;
  /** The `# tests / # pass / # fail` summary the TAP reporter prints. */
  summary: Record<string, number>;
}

export function runTestFile(
  name: string,
  source: string,
  args: string[] = [],
  timeoutMs = 15_000,
): RunResult {
  const file = path.join(dir, name);
  writeFileSync(file, source);
  const t0 = Date.now();
  // --no-warnings: node:sqlite and MockTimers each emit an ExperimentalWarning
  // on startup, and the TAP reporter folds them in with the test output.
  const r = spawnSync(process.execPath, ["--no-warnings", "--test", ...args, file], {
    encoding: "utf8",
    timeout: timeoutMs,
  });
  const stdout = r.stdout ?? "";
  const summary: Record<string, number> = {};
  for (const line of stdout.split("\n")) {
    const m = /^# (tests|pass|fail|skipped|todo|cancelled) (\d+)$/.exec(line.trim());
    if (m) summary[m[1]!] = Number(m[2]);
  }
  return {
    status: r.status,
    signal: r.signal,
    stdout,
    stderr: r.stderr ?? "",
    ms: Date.now() - t0,
    summary,
  };
}

/** The `ok 1 - name` / `not ok 2 - name # TODO` lines, trimmed. */
export function resultLines(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^(not )?ok \d+/.test(l));
}

/** TAP diagnostic comments — where the runner hides its warnings. */
export function comments(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("# ") && !/^# (tests|suites|pass|fail|skipped|todo|cancelled|duration_ms|start|end)/.test(l))
    .map((l) => l.slice(2));
}

export function verdict(r: RunResult): string {
  const s = r.summary;
  return `exit ${r.status}  (tests ${s["tests"] ?? "?"}, pass ${s["pass"] ?? "?"}, fail ${s["fail"] ?? "?"}, skipped ${s["skipped"] ?? 0}, todo ${s["todo"] ?? 0})`;
}
