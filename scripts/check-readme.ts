/**
 * Typecheck the code blocks in every README.
 *
 *   node scripts/check-readme.ts          # check
 *   node scripts/check-readme.ts --list   # just list what would be checked
 *
 * WHY THIS EXISTS
 *
 * `tsc --noEmit` covers src/ and scripts/. It does not look inside markdown,
 * so the ~2,000 lines of TypeScript in the module READMEs — the code a learner
 * reads FIRST and copies — were verified by nothing at all.
 *
 * That is not hypothetical. It let a parameter property into
 * 05-streams/README.md, which is syntax Node's type stripping refuses to run:
 *
 *     class Counter { constructor(private max: number) {} }
 *     → SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]
 *
 * ...in the very file explaining the API, in a project whose root README says
 * parameter properties are unavailable and whose tsconfig sets
 * `erasableSyntaxOnly` to enforce it everywhere else.
 *
 * WHAT IT CHECKS
 *
 * Every block must PARSE and must be syntax Node can actually run — TS1xxx
 * diagnostics, which covers both malformed code and erasableSyntaxOnly
 * violations (TS1294: enums, namespaces, parameter properties, legacy
 * decorators).
 *
 * WHAT IT DELIBERATELY DOES NOT CHECK
 *
 * Type errors (TS2xxx). README snippets are fragments by design: they say
 * `res.setHeader(...)` without a `res` in scope, and that is fine — the
 * surrounding prose supplies the context. Demanding they typecheck in
 * isolation would mean padding every snippet with boilerplate that makes the
 * teaching worse, so the bar here is "this code is real and would run", not
 * "this code is a complete program".
 *
 * OPTING OUT
 *
 * A block whose whole point is to be wrong — showing a syntax error, or code
 * for a different runtime — can say so, and is skipped:
 *
 *     ```ts ignore
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");
const workDir = path.join(root, ".readme-check");

/** Languages worth checking. Anything else in a fence is left alone. */
const CHECKED = new Set(["ts", "typescript", "js", "javascript"]);

interface Block {
  /** README path, relative to the repo root. */
  source: string;
  /** 1-based line in the README where the code (not the fence) starts. */
  startLine: number;
  lang: string;
  code: string;
  /** Filename it gets in the work dir. */
  slug: string;
}

// ─── Find the READMEs ────────────────────────────────────────────────────────

function readmes(): string[] {
  const found = [path.join(root, "README.md")];
  const srcDir = path.join(root, "src");
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(srcDir, entry.name, "README.md");
    try {
      readFileSync(candidate);
      found.push(candidate);
    } catch {
      // A module without a README is not an error here.
    }
  }
  return found;
}

// ─── Extract fenced blocks ───────────────────────────────────────────────────

function extract(file: string): { blocks: Block[]; ignored: number } {
  const rel = path.relative(root, file).replaceAll("\\", "/");
  const lines = readFileSync(file, "utf8").split("\n");
  const blocks: Block[] = [];
  let ignored = 0;
  let n = 0;

  for (let i = 0; i < lines.length; i++) {
    // Opening fence: ```ts, ```ts ignore, ```js …
    const open = /^```(\w+)(.*)$/.exec(lines[i] ?? "");
    if (!open) continue;

    const lang = open[1]!.toLowerCase();
    const modifiers = (open[2] ?? "").trim();

    // Find the closing fence before deciding anything, so an unchecked
    // language (```bash, ```json) still advances i past its body.
    let end = i + 1;
    while (end < lines.length && lines[end]?.trimEnd() !== "```") end++;

    if (CHECKED.has(lang)) {
      if (/\bignore\b/.test(modifiers)) {
        ignored++;
      } else {
        const code = lines.slice(i + 1, end).join("\n");
        if (code.trim() !== "") {
          blocks.push({
            source: rel,
            startLine: i + 2, // 1-based, first line INSIDE the fence
            lang,
            code,
            slug: `${rel.replaceAll(/[^\w]/g, "_")}__${++n}.ts`,
          });
        }
      }
    }
    i = end;
  }

  return { blocks, ignored };
}

// ─── Run tsc over the extracted blocks ───────────────────────────────────────

interface Diagnostic {
  slug: string;
  line: number;
  column: number;
  code: string;
  message: string;
}

function runTsc(blocks: Block[]): Diagnostic[] {
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });

  try {
    for (const b of blocks) writeFileSync(path.join(workDir, b.slug), `${b.code}\n`);

    // Inherit the project's real settings — erasableSyntaxOnly above all, but
    // also lib/target, so `console` and `Buffer` resolve and do not become
    // noise. The work dir sits INSIDE the repo so node_modules resolves.
    writeFileSync(
      path.join(workDir, "tsconfig.json"),
      JSON.stringify(
        {
          extends: "../tsconfig.json",
          compilerOptions: { noEmit: true, skipLibCheck: true },
          include: ["./*.ts"],
        },
        null,
        2,
      ),
    );

    const result = spawnSync("npx", ["tsc", "-p", workDir, "--pretty", "false"], {
      cwd: root,
      encoding: "utf8",
      shell: process.platform === "win32", // npx is a .cmd on Windows
    });

    const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    const diagnostics: Diagnostic[] = [];

    for (const line of out.split("\n")) {
      const m = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/.exec(line.trim());
      if (!m) continue;
      diagnostics.push({
        slug: path.basename(m[1]!),
        line: Number(m[2]),
        column: Number(m[3]),
        code: m[4]!,
        message: m[5]!,
      });
    }
    return diagnostics;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

/**
 * TS1108 — "A 'return' statement can only be used within a function body."
 *
 * Tolerated, because it is an artifact of extraction rather than a defect: a
 * snippet that shows the inside of a handler is the clearest way to teach the
 * handler, and wrapping every one in a dummy function to satisfy this checker
 * would make the docs worse to read. The code is correct where it is used.
 */
const TOLERATED = new Set(["TS1108"]);

/**
 * TS1xxx = the code cannot be parsed, or uses syntax Node's type stripping
 * refuses (TS1294). Both mean "this snippet cannot run", which is the bar.
 * TS2xxx = type/name resolution, which fragments fail by design.
 */
const isHardError = (code: string) => /^TS1\d{3}$/.test(code) && !TOLERATED.has(code);

/** Parse failures — as opposed to TS1294, a grammar rule on parseable code. */
const isParseError = (code: string) => isHardError(code) && code !== "TS1294";

/**
 * TWO PASSES, and the reason is not obvious.
 *
 * tsc abandons its grammar checks for the WHOLE PROGRAM as soon as any file
 * fails to parse. So one block containing `await ???` hides every
 * erasableSyntaxOnly violation in all the others — which is exactly how the
 * parameter property in 05-streams/README.md survived the first version of
 * this script. A single-pass checker would have reported 27 pseudo-code
 * complaints and quietly missed the one real bug.
 *
 * Pass 1 finds the unparseable blocks. Pass 2 re-runs without them, so the
 * grammar errors in everything else can finally surface.
 */
function typecheck(blocks: Block[]): Diagnostic[] {
  const first = runTsc(blocks);
  const broken = new Set(first.filter((d) => isParseError(d.code)).map((d) => d.slug));
  if (broken.size === 0) return first;

  const rest = blocks.filter((b) => !broken.has(b.slug));
  const second = rest.length > 0 ? runTsc(rest) : [];

  // Keep pass 1's parse errors, add everything pass 2 could newly see.
  return [...first.filter((d) => broken.has(d.slug)), ...second];
}

// ─── Report ──────────────────────────────────────────────────────────────────

const files = readmes();
const allBlocks: Block[] = [];
let totalIgnored = 0;

for (const file of files) {
  const { blocks, ignored } = extract(file);
  allBlocks.push(...blocks);
  totalIgnored += ignored;
}

const codeLines = allBlocks.reduce((n, b) => n + b.code.split("\n").length, 0);

if (process.argv.includes("--list")) {
  for (const b of allBlocks) {
    console.log(`  ${b.source}:${b.startLine}  (${b.lang}, ${b.code.split("\n").length} lines)`);
  }
  console.log(`\n${allBlocks.length} blocks, ${codeLines} lines, across ${files.length} READMEs`);
  process.exit(0);
}

console.log(
  `Checking ${allBlocks.length} code blocks (${codeLines} lines) from ${files.length} READMEs` +
    `${totalIgnored > 0 ? `, ${totalIgnored} marked ignore` : ""}…\n`,
);

const diagnostics = typecheck(allBlocks);
const bySlug = new Map(allBlocks.map((b) => [b.slug, b]));
const hard = diagnostics.filter((d) => isHardError(d.code));

for (const d of hard) {
  const b = bySlug.get(d.slug);
  if (!b) continue;
  // Map the temp file's line back to the README's.
  const readmeLine = b.startLine + d.line - 1;
  const offending = b.code.split("\n")[d.line - 1] ?? "";
  console.log(`${b.source}:${readmeLine}:${d.column}  ${d.code}`);
  console.log(`  ${d.message}`);
  console.log(`  → ${offending.trim()}\n`);
}

const softCount = diagnostics.length - hard.length;

if (hard.length === 0) {
  console.log(`✅ no unrunnable code in any README.`);
  if (softCount > 0) {
    console.log(
      `   (${softCount} type/name diagnostics ignored — README snippets are ` +
        `fragments by design; see the header of this file.)`,
    );
  }
} else {
  console.log(`❌ ${hard.length} block${hard.length === 1 ? "" : "s"} contain code that cannot run.`);
  console.log(`   These are TS1xxx: a parse error, or syntax Node's type stripping refuses.`);
  process.exitCode = 1;
}
