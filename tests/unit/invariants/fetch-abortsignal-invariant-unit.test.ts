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
import ts from "typescript";
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
    const source = ts.createSourceFile(
      f,
      txt,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "fetch"
      ) {
        const options = node.arguments[1];
        const carriesSignal =
          options &&
          ts.isObjectLiteralExpression(options) &&
          options.properties.some(
            (property) =>
              (ts.isPropertyAssignment(property) ||
                ts.isShorthandPropertyAssignment(property)) &&
              property.name.getText(source) === "signal",
          );
        if (!carriesSignal) {
          const position = source.getLineAndCharacterOfPosition(
            node.getStart(source),
          );
          offenders.push(
            `${path.relative(SRC_ROOT, f)}:${position.line + 1}: ${node.expression.getText(source)}(`,
          );
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
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
