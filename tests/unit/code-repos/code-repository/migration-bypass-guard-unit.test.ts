// ---------------------------------------------------------------------------
// tests/unit/code-repos/code-repository/migration-bypass-guard-unit.test.ts
//
// CI guard — fails if any integration test under tests/integration/code-repos/
// applies migration SQL via a non-hermetic call path.  Pins the post-mortem
// fix from 2026-05-04 in which production `code_repos_idempotency` was
// dropped twice by integration tests that ran migration 051's leading
// `DROP TABLE IF EXISTS code_repos_idempotency CASCADE` against a pool whose
// search_path was `<schema>, public`, causing the unqualified DROP to fall
// through to `public.code_repos_idempotency`.
//
// Allowed call paths (hermetic — see _helpers/pg.ts qualifyUnqualifiedDrops):
//   * ctx.applyMigration(relPath)         — reads file from disk
//   * ctx.applyMigrationSql(sql)          — accepts pre-loaded string
//
// Forbidden call paths (non-hermetic):
//   * ctx.query(sql_or_loader_call)       — pool path, no DROP rewrite
//   * ctx.exec(sql_or_loader_call)        — pool path, no DROP rewrite
//   * ctx.pool.query(sql_or_loader_call)  — bypasses ctx altogether
//   * Any equivalent on a `schema`/`openSchema` variable
//
// "loader_call" means: loadSql(...), loadMigration(...), readFileSync(...),
// or a reference to a module-level `UP_*`/`DOWN_*` constant that holds
// migration SQL.
//
// This test runs in the unit lane (no Postgres dependency).  It walks
// `tests/integration/code-repos/**/*.test.ts`, scans each file for the
// forbidden patterns, and reports every offending file:line with the full
// matched line and the matching pattern's name.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const TESTS_ROOT = path.resolve(REPO_ROOT, "tests/integration/code-repos");

interface ForbiddenPattern {
  name: string;
  // Regex that fires once per offending line.
  re: RegExp;
  // One-line explanation shown on violation.
  rationale: string;
}

// Each pattern catches a distinct bypass shape.  Patterns are conservative:
// they only fire when a known query/exec call path is paired with a known
// migration-SQL source (loader call, readFileSync, or UP_/DOWN_ constant).
//
// Adding a new pattern: add the row, ensure the rationale tells the
// reviewer exactly which call path to use instead.
const FORBIDDEN_PATTERNS: ForbiddenPattern[] = [
  {
    name: "ctx.query(loaderCall)",
    re: /\b(?:ctx|schema|openSchema|downSchema)\.query\s*\(\s*(?:loadSql|loadMigration|readFileSync)\b/,
    rationale:
      "Use ctx.applyMigrationSql(<sql>) or ctx.applyMigration(<relPath>) so the hermetic DROP-qualifier rewrites unqualified DROPs to the test schema.",
  },
  {
    name: "ctx.exec(loaderCall)",
    re: /\b(?:ctx|schema|openSchema|downSchema)\.exec\s*\(\s*(?:loadSql|loadMigration|readFileSync)\b/,
    rationale: "Same as ctx.query(loaderCall) — switch to ctx.applyMigrationSql(<sql>).",
  },
  {
    name: "ctx.query(UP_*|DOWN_*)",
    re: /\b(?:ctx|schema|openSchema|downSchema)\.query\s*\(\s*(?:UP|DOWN)_[A-Z0-9_]+\s*\)/,
    rationale:
      "Module constants like UP_054 / DOWN_054 hold migration SQL — pass them to ctx.applyMigrationSql() to engage the DROP rewriter.",
  },
  {
    name: "ctx.pool.query(loaderCall|UP|DOWN)",
    re: /\b(?:ctx|schema|openSchema|downSchema)\.pool\.query\s*\(\s*(?:loadSql|loadMigration|readFileSync|UP_[A-Z0-9_]+|DOWN_[A-Z0-9_]+)\b/,
    rationale:
      "Direct pool.query() bypasses both ctx and the DROP rewriter.  Always go through ctx.applyMigrationSql().",
  },
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      out.push(...walk(full));
    } else if (entry.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

interface Violation {
  file: string;
  line: number;
  text: string;
  pattern: ForbiddenPattern;
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
}

function scanFile(absPath: string): Violation[] {
  const out: Violation[] = [];
  const lines = readFileSync(absPath, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip pure comment lines so the rationale text inside the helper's
    // own warnings doesn't trip the guard recursively.  Tests rarely hide
    // bypass calls inside multi-line comments, and a code-review will
    // catch the rare case where they do.
    if (isCommentLine(line)) continue;
    for (const p of FORBIDDEN_PATTERNS) {
      if (p.re.test(line)) {
        out.push({
          file: path.relative(REPO_ROOT, absPath),
          line: i + 1,
          text: line.trim(),
          pattern: p,
        });
      }
    }
  }
  return out;
}

describe("CI guard — no migration-apply bypass in integration tests", () => {
  it("every *.test.ts under tests/integration/code-repos/ uses ctx.applyMigration[Sql] only", () => {
    const files = walk(TESTS_ROOT);
    expect(files.length).toBeGreaterThan(10); // sanity: walk found the tests

    const violations = files.flatMap(scanFile);

    if (violations.length > 0) {
      const grouped = violations.reduce<Record<string, Violation[]>>((acc, v) => {
        (acc[v.pattern.name] ||= []).push(v);
        return acc;
      }, {});

      const report = Object.entries(grouped)
        .map(([patternName, vs]) => {
          const rationale = vs[0]!.pattern.rationale;
          const lines = vs
            .map((v) => `    ${v.file}:${v.line}\n      ${v.text}`)
            .join("\n");
          return `\n  Pattern: ${patternName}\n  Why:     ${rationale}\n${lines}`;
        })
        .join("\n");

      throw new Error(
        [
          `Migration-apply bypass detected in ${violations.length} location(s).`,
          `These call paths skip the hermetic DROP rewriter and CAN drop production tables.`,
          `Replace with ctx.applyMigrationSql(<sql>) or ctx.applyMigration(<relPath>).`,
          `See decisions/code-repository/* for the post-mortem.`,
          report,
        ].join("\n"),
      );
    }
  });

  it("FORBIDDEN_PATTERNS fires on synthetic bypass examples (sanity)", () => {
    // Self-test of the patterns themselves — ensures the guard regexes
    // continue to catch real-world shapes if someone refactors.
    const examples: { line: string; expected: string }[] = [
      { line: "  await ctx.query(loadSql('foo'));", expected: "ctx.query(loaderCall)" },
      { line: "  await ctx.query(loadMigration('051'));", expected: "ctx.query(loaderCall)" },
      { line: "  await ctx.query(readFileSync(p));", expected: "ctx.query(loaderCall)" },
      { line: "  await openSchema.query(UP_054);", expected: "ctx.query(UP_*|DOWN_*)" },
      { line: "  await schema.pool.query(UP_SQL);", expected: "ctx.pool.query(loaderCall|UP|DOWN)" },
      { line: "  await downSchema.pool.query(DOWN_SQL);", expected: "ctx.pool.query(loaderCall|UP|DOWN)" },
      { line: "  await ctx.exec(loadSql('x'));", expected: "ctx.exec(loaderCall)" },
    ];
    for (const { line, expected } of examples) {
      const matched = FORBIDDEN_PATTERNS.find((p) => p.re.test(line));
      expect(matched, `expected ${expected} to fire on:\n  ${line}`).toBeDefined();
      expect(matched!.name).toBe(expected);
    }
  });

  it("FORBIDDEN_PATTERNS does NOT fire on the safe forms (sanity)", () => {
    // The hermetic call paths must not trip the guard.  This is the
    // contract: anything in this list is allowed verbatim.
    const safe = [
      "  await ctx.applyMigration('src/migrations/051_code_repos_audit.sql');",
      "  await ctx.applyMigrationSql(UP_054);",
      "  await ctx.applyMigrationSql(loadMigration('051_code_repos_audit.sql'));",
      "  await ctx.applyMigrationSql(readFileSync(p));",
      "  await schema.applyMigrationSql(UP_SQL);",
      "  await ctx.query('SELECT 1');", // plain non-migration query
      "  const sql = readFileSync(p);", // plain assignment
      "  // ctx.query(loadSql(...)) is forbidden — see ADR", // comment
    ];
    for (const line of safe) {
      const matched = FORBIDDEN_PATTERNS.find((p) => p.re.test(line));
      // The comment line is filtered upstream by isCommentLine — so the
      // raw regex match is acceptable; the per-file scan ignores comments.
      if (line.trimStart().startsWith("//")) continue;
      expect(
        matched,
        `expected no pattern to fire on safe form:\n  ${line}\n  but matched: ${matched?.name}`,
      ).toBeUndefined();
    }
  });
});
