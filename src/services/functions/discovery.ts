// ---------------------------------------------------------------------------
// functions/discovery.ts — shared function-file discovery + identity rules.
//
// Single source of truth for "which repo paths are functions" and "what is a
// function's identity". Used by:
//   - codeRepository/admin/routes.ts  (GET /:rid/functions, POST invoke,
//     legacy tags fallback)
//   - functionsPublish/service.ts     (the durable publish worker)
//
// Convention (Foundry TSv2 parity — docs §Functions → TypeScript v2):
//   - Functions live under `<root>/src/functions/**` (the scaffold root is
//     typically `typescript-functions/`, but any ancestor is accepted).
//   - Files may be GROUPED INTO SUBDIRECTORIES; the function's identity is
//     its path relative to `src/functions/` WITHOUT the extension —
//     `src/functions/calc.ts` → "calc", `src/functions/orders/calc.ts` →
//     "orders/calc". Root-level files keep their historic basename identity
//     (backward-compatible with every previously published bundle).
//   - The file's basename must be a valid identifier and MUST equal the
//     default-exported function name (enforced at publish by
//     functionsPublish/service.ts#inspectPublishedFunction).
//   - Test/spec/declaration siblings (`.test.`, `.spec.`, `.d.ts`) are never
//     functions.
// ---------------------------------------------------------------------------

export type FunctionRuntime = "NODE_20" | "PY_311";

export interface ParsedFunctionPath {
  /** Identity: relative path under src/functions/ without extension. */
  readonly apiName: string;
  /** Relative path under src/functions/ WITH extension (for grouping). */
  readonly relativePath: string;
  /** Full repo-relative path. */
  readonly path: string;
  readonly runtime: FunctionRuntime;
}

// Nested layout: directories may contain letters, digits, `_` and `-`;
// the file stem must be a valid JS/Python identifier.
const FUNCTION_PATH_RE =
  /(^|\/)src\/functions\/((?:[A-Za-z0-9_-]+\/)*)([A-Za-z_][A-Za-z0-9_]*)\.(ts|py)$/;

const EXCLUDED_RE = /\.(test|spec)\.(ts|py)$|\.d\.ts$/;

/**
 * Classify a repo-relative path: returns the parsed identity for function
 * files, null for anything else (including test/spec/declaration siblings).
 */
export function parseFunctionPath(path: string): ParsedFunctionPath | null {
  if (EXCLUDED_RE.test(path)) return null;
  const m = FUNCTION_PATH_RE.exec(path);
  if (m === null) return null;
  const [, , subdirs, stem, ext] = m;
  return {
    apiName: `${subdirs}${stem}`,
    relativePath: `${subdirs}${stem}.${ext}`,
    path,
    runtime: ext === "py" ? "PY_311" : "NODE_20",
  };
}

/**
 * Identity validation for API inputs (invoke `apiName`). Either a plain
 * identifier (root-level function) or identifier-under-directories
 * (nested function).
 */
export const FUNCTION_IDENTITY_RE =
  /^([A-Za-z0-9_-]+\/)*[A-Za-z_][A-Za-z0-9_]*$/;
