// ---------------------------------------------------------------------------
// Single live-table writer (verification §1.5).
//
// Every funnel merge path — the DuckDB SQL tail, the out-of-process CLI
// merge AND the pure-TS / legacy-snapshot path — must reach the live
// object_instances table only through promoteMergeStaging (stage → verify
// → promote in one transaction). This guard scans src/services/funnel and
// fails if any other module writes object_instances directly or calls the
// unstaged model writers.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(process.cwd(), "src/services/funnel");
const WRITE_PATTERNS = [
  /\bINSERT\s+INTO\s+object_instances\b/i,
  /\bDELETE\s+FROM\s+object_instances\b/i,
  /\bUPDATE\s+object_instances\b/i,
  /\bbulkUpsertInstances\s*\(/,
  /\bdeleteInstance\s*\(/,
  /\bupsertInstance\s*\(/,
];
const ALLOWED = new Set(["mergeStaging.ts"]);

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return p.endsWith(".ts") ? [p] : [];
  });
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

describe("funnel live-table writers", () => {
  it("only mergeStaging.ts (promoteMergeStaging) writes object_instances", () => {
    const offenders: string[] = [];
    for (const file of walk(ROOT)) {
      const rel = path.relative(ROOT, file);
      if (ALLOWED.has(rel)) continue;
      const code = stripComments(fs.readFileSync(file, "utf8"));
      for (const re of WRITE_PATTERNS) {
        if (re.test(code)) offenders.push(`${rel}: ${re}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the pure-TS merge commits through commitMergedRowsViaStaging", () => {
    const code = stripComments(fs.readFileSync(path.join(ROOT, "mergeStage.ts"), "utf8"));
    const fn = code.slice(code.indexOf("export async function mergeChanges("), code.indexOf("export function assertStagedTail("));
    expect(fn).toMatch(/await commitMergedRowsViaStaging\(client, input, mergedRows\)/);
    const helper = code.slice(code.indexOf("export async function commitMergedRowsViaStaging("));
    expect(helper.slice(0, helper.indexOf("\n}\n"))).toMatch(
      /stageMergeRows[\s\S]*verifyMergeStaging[\s\S]*assertStagedTail[\s\S]*promoteMergeStaging/,
    );
  });
});
