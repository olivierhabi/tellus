// ---------------------------------------------------------------------------
// no-src-rooted-imports-unit.test.ts — import-hygiene invariant.
//
// REGRESSION (production 500 on GET-single, 2026-10-03):
// src/services/serving/pgObjectAsDoc.ts imported { query } from
// "../../../src/db". That resolves in dev (tsx from the repo root, where
// src/ exists) and typechecks fine, but after `tsc` emits to dist/ the
// same relative require points at <root>/src/db — which does not exist in
// the production image — so EVERY GET /api/v1/objects/:type/:pk crashed
// with `Cannot find module '../../../src/db'`.
//
// Rule: no file under src/ may import through a `src/` path segment
// (static import, dynamic import(), or require()). Intra-repo imports must
// be plain relative paths so they survive the src/ -> dist/ relocation.
// ---------------------------------------------------------------------------

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC_ROOT = resolve(__dirname, "../../../src");

// Matches: from "../..//src/x", import(".../src/x"), require(".../src/x").
// The segment must be a path segment (`src/` or trailing `src"`), so words
// like `srcFoo` do not trip the rule.
const SRC_SEGMENT_RE =
  /(?:from\s+|import\s*\(|require\s*\()\s*["'](?=[^"']*\/src\/|\.\.(\/\.\.)*\/src["'])[^"']*["']/;

function collectTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collectTsFiles(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe("import hygiene: no src/-rooted imports", () => {
  it("no file under src/ imports through a src/ path segment", () => {
    const offenders: string[] = [];
    for (const file of collectTsFiles(SRC_ROOT)) {
      const content = readFileSync(file, "utf8");
      const lines = content.split("\n");
      const bad = lines.some((line) => SRC_SEGMENT_RE.test(line));
      if (bad) offenders.push(file);
    }
    expect(offenders, "files importing through src/ (breaks dist/ layout)").toEqual([]);
  });

  it("pgObjectAsDoc resolves its db import from the serving directory", () => {
    const content = readFileSync(
      join(SRC_ROOT, "services/serving/pgObjectAsDoc.ts"),
      "utf8",
    );
    expect(content).toContain('from "../../db"');
    expect(content).not.toContain("src/db");
  });
});
