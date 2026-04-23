// F-P4-08 invariant — every production call site that hits `fetch(`
// must carry an AbortSignal so a frozen upstream cannot hold a request
// handler open past its budget.
//
// Negative test: remove an AbortSignal from any production fetch and
// this suite fails. Verified against the pre-fix baseline by the
// session working against the failing-then-passing transitions in the
// five files touched by F-P4-08 (tellusAuthService, keycloakAdminService,
// tellusAuthV1 routes).
//
// This is a static code scan, so it runs in under 50 ms and covers the
// whole src/ tree regardless of whether a given call path has an
// integration test.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC_ROOT = path.resolve(__dirname, "../../../src");

function walk(dir: string, acc: string[]): void {
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, acc);
    else if (
      s.isFile() &&
      p.endsWith(".ts") &&
      !p.endsWith(".test.ts") &&
      !p.endsWith(".d.ts")
    ) {
      acc.push(p);
    }
  }
}

function findUnboundedFetches(files: string[]): string[] {
  const offenders: string[] = [];
  for (const f of files) {
    const txt = readFileSync(f, "utf8");
    const lines = txt.split(/\n/);
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      // Match `fetch(` when it is not a method call (e.g. `this.fetch(`
      // or `cache.fetch(`) or part of a larger identifier.
      if (!/(?:^|[^.\w])fetch\s*\(/.test(l)) continue;
      // Ignore comments.
      if (/^\s*\/\//.test(l)) continue;
      // Look ahead up to 15 lines — enough for the widest multi-line
      // `fetch(url, { … })` call we have in the codebase.
      const window = lines.slice(i, i + 15).join("\n");
      if (/signal\s*:/.test(window)) continue;
      offenders.push(`${path.relative(SRC_ROOT, f)}:${i + 1}: ${l.trim()}`);
    }
  }
  return offenders;
}

describe("F-P4-08 | every production fetch() carries an AbortSignal", () => {
  it("src/ has no unbounded fetch() call sites", () => {
    const files: string[] = [];
    walk(SRC_ROOT, files);
    const offenders = findUnboundedFetches(files);
    expect(
      offenders,
      `Found ${offenders.length} unbounded fetch() call site(s):\n` +
        offenders.join("\n") +
        "\nAdd `signal: AbortSignal.timeout(<ms>)` or a dedicated " +
        "AbortController that fires inside the route's budget.",
    ).toEqual([]);
  });
});
