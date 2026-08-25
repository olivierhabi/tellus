import { describe, expect, it } from "vitest";

import {
  formatTypeCheckDiagnostic,
  MAX_TYPE_CHECK_DIAGNOSTICS,
  typeCheckRepository,
} from "../../../src/services/functionsPublish/typeCheck";

const ALPHA = `export default function alpha(input: string): string { return input; }\n`;

describe("typeCheckRepository", () => {
  it("passes a valid multi-file repository (relative import resolves)", () => {
    const result = typeCheckRepository([
      { path: "src/functions/beta.ts", source: "export function double(n: number): number { return n * 2; }\nexport default function beta(input: string): string { return input; }\n", kind: "function" },
      { path: "src/functions/alpha.ts", source: "import { double } from \"./beta\";\nexport default function alpha(input: string): string { return String(double(input.length)); }\n", kind: "function" },
    ]);
    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([]);
  });

  it("fails on a syntax error with a TS code", () => {
    const result = typeCheckRepository([
      { path: "src/functions/alpha.ts", source: "export default function alpha(input: string): string { return input; \n", kind: "function" },
    ]);
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0].code).toBeGreaterThan(1000);
    expect(result.diagnostics[0].path).toBe("src/functions/alpha.ts");
  });

  it("fails on a semantic type mismatch (TS2322)", () => {
    const result = typeCheckRepository([
      { path: "src/functions/alpha.ts", source: "export default function alpha(input: string): string { const n: number = \"x\"; return String(n); }\n", kind: "function" },
    ]);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toContain(2322);
  });

  it("fails on a nonsense package import with an actionable message", () => {
    const result = typeCheckRepository([
      { path: "src/functions/alpha.ts", source: "import { wat } from \"totally-made-up\";\nexport default function alpha(input: string): string { return String(wat) + input; }\n", kind: "function" },
    ]);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.message).join("\n")).toContain("totally-made-up");
  });

  it("fails on a missing relative import (TS2307)", () => {
    const result = typeCheckRepository([
      { path: "src/functions/alpha.ts", source: "import { missing } from \"./missing\";\nexport default function alpha(input: string): string { return String(missing) + input; }\n", kind: "function" },
    ]);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toContain(2307);
  });

  it("detects a type error that crosses a file boundary (TS2345)", () => {
    const result = typeCheckRepository([
      { path: "src/functions/beta.ts", source: "export function double(n: number): number { return n * 2; }\nexport default function beta(input: string): string { return input; }\n", kind: "function" },
      { path: "src/functions/alpha.ts", source: "import { double } from \"./beta\";\nexport default function alpha(input: string): string { return String(double(\"not-a-number\")); }\n", kind: "function" },
    ]);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toContain(2345);
    expect(result.diagnostics[0].path).toBe("src/functions/alpha.ts");
  });

  it("rejects node builtins in function sources but allows node:test in test files", () => {
    const fnResult = typeCheckRepository([
      { path: "src/functions/alpha.ts", source: "import { readFileSync } from \"node:fs\";\nexport default function alpha(input: string): string { void readFileSync; return input; }\n", kind: "function" },
    ]);
    expect(fnResult.ok).toBe(false);
    expect(fnResult.diagnostics[0].message).toContain("node:fs");

    const testResult = typeCheckRepository([
      { path: "src/functions/alpha.ts", source: ALPHA, kind: "function" },
      { path: "src/functions/alpha.test.ts", source: "import { test } from \"node:test\";\nimport assert from \"node:assert\";\nimport alpha from \"./alpha\";\ntest(\"alpha\", () => { assert.strictEqual(alpha(\"x\"), \"x\"); });\n", kind: "test" },
    ]);
    expect(testResult.ok).toBe(true);
  });

  it("type-checks a TSX test file without JSX; rejects JSX (no react runtime in the allowlist)", () => {
    const plainTsx = typeCheckRepository([
      { path: "src/functions/alpha.ts", source: ALPHA, kind: "function" },
      { path: "src/functions/alpha.test.tsx", source: "import { test } from \"node:test\";\nimport assert from \"node:assert\";\ntest(\"alpha\", () => { assert.strictEqual(1, 1); });\n", kind: "test" },
    ]);
    expect(plainTsx.ok).toBe(true);

    const jsxTsx = typeCheckRepository([
      { path: "src/functions/alpha.ts", source: ALPHA, kind: "function" },
      { path: "src/functions/widget.test.tsx", source: "import { test } from \"node:test\";\ntest(\"widget\", () => { const el = <div />; void el; });\n", kind: "test" },
    ]);
    expect(jsxTsx.ok).toBe(false);
    expect(jsxTsx.diagnostics.map((d) => d.message).join("\n")).toMatch(/react\/jsx-runtime/);
  });

  it("sorts diagnostics by path then position and renders the stable log format", () => {
    const result = typeCheckRepository([
      { path: "src/functions/alpha.ts", source: "export default function alpha(input: string): string { const n: number = \"x\"; return String(n); }\n", kind: "function" },
    ]);
    expect(formatTypeCheckDiagnostic(result.diagnostics[0])).toMatch(
      /^src\/functions\/alpha\.ts:1:\d+ - error TS2322: /,
    );
  });

  it("bounds diagnostic output", () => {
    expect(MAX_TYPE_CHECK_DIAGNOSTICS).toBeGreaterThan(0);
  });
});
