// ---------------------------------------------------------------------------
// typeCheck.ts — real TypeScript semantic checking for functions-publish.
//
// Replaces the old `ts.transpileModule` lint, which was single-file emit-only
// and never resolved imports: a nonsense import or a cross-file type error
// used to sail through the lint stage. Here we build a real `ts.Program`
// over the repository's function + test sources and fail on syntactic AND
// semantic diagnostics (module resolution included).
//
// Module-resolution policy (narrowest correct allowlist, no `declare module
// "*"` and no arbitrary `any` stubs for invented modules):
//
//   * Repository-local relative imports — resolved on a real temp-dir
//     mirror of the repo sources; a missing relative import is TS2307.
//   * Platform SDK modules — the same allowlist the runtime require-shim
//     resolves (functionRuntime.ts:168-175): @foundry/functions,
//     @foundry/functions-api, @foundry/ontology-api, @ontology/sdk,
//     @osdk/functions, @osdk/client. The generated SDK's declarations are
//     not known at publish time, so these are the ONLY specifiers whose
//     TS2307 (unresolved module) is filtered out — imports of allowlisted
//     modules bind as `any`, exactly matching the runtime require-shim.
//     Every other unresolved module keeps its TS2307 and fails the stage.
//   * node:test / node:assert — allowed in test files only, with minimal
//     REAL typings (no `any`), so test files type-check honestly.
//   * Everything else (invented packages, node builtins in function
//     sources) is rejected by an explicit specifier gate BEFORE the program
//     runs, and would also fail module resolution (TS2307) as a backstop.
//
// TSX: .tsx test files parse (jsx: ReactJSX), but the JSX runtime module
// (`react/jsx-runtime`) is not in the allowlist — JSX usage fails with a
// clear diagnostic. TSX without JSX type-checks normally.
// ---------------------------------------------------------------------------

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import ts from "typescript";

export interface TypeCheckSourceFile {
  /** Repo-relative POSIX path, e.g. `typescript-functions/src/functions/a.ts`. */
  readonly path: string;
  readonly source: string;
  readonly kind: "function" | "test";
}

export interface TypeCheckDiagnostic {
  readonly path: string | null;
  readonly line: number | null;
  readonly column: number | null;
  /** TypeScript diagnostic code, or 0 for allowlist-gate diagnostics. */
  readonly code: number;
  readonly message: string;
}

export interface TypeCheckResult {
  readonly ok: boolean;
  /** Sorted (path, position, code) and bounded to MAX_TYPE_CHECK_DIAGNOSTICS. */
  readonly diagnostics: readonly TypeCheckDiagnostic[];
  /** Number of diagnostics omitted because of the bound. */
  readonly truncatedCount: number;
}

/** Upper bound on diagnostics returned/logged per run — output stays sane. */
export const MAX_TYPE_CHECK_DIAGNOSTICS = 50;

/**
 * Modules the functions runtime actually resolves (see the require-shim
 * allowlist in functionRuntime.ts). Everything else must fail the stage.
 */
const PLATFORM_MODULE_SPECIFIERS: ReadonlySet<string> = new Set([
  "@foundry/functions",
  "@foundry/functions-api",
  "@foundry/ontology-api",
  "@ontology/sdk",
  "@osdk/functions",
  "@osdk/client",
]);

/** Node built-ins permitted inside test files only. */
const TEST_MODULE_SPECIFIERS: ReadonlySet<string> = new Set([
  "node:test",
  "node:assert",
  "node:assert/strict",
]);

const NODE_TEST_STUB = `\
export declare function test(name: string, fn: () => void | Promise<void>): void;
export declare function describe(name: string, fn: () => void): void;
export declare function it(name: string, fn: () => void | Promise<void>): void;
`;

const NODE_ASSERT_STUB = `\
declare function assert(value: unknown, message?: string): asserts value;
declare namespace assert {
  function equal(actual: unknown, expected: unknown, message?: string): void;
  function strictEqual(actual: unknown, expected: unknown, message?: string): void;
  function deepStrictEqual(actual: unknown, expected: unknown, message?: string): void;
  function ok(value: unknown, message?: string): asserts value;
  function throws(fn: () => unknown, message?: string): void;
  function rejects(fn: () => unknown | Promise<unknown>, message?: string): Promise<void>;
}
export = assert;
`;

/** Runtime-faithful ambient: transpiled CJS always has `require` available. */
const AMBIENT_STUB = "declare const require: (specifier: string) => unknown;\n";

/**
 * Only node:test / node:assert get stub declarations (with real typings).
 * Platform SDK modules are handled by the TS2307 filter below — an
 * `export = any` stub would wrongly reject named imports (TS2305).
 */
const STUB_BY_SPECIFIER: ReadonlyMap<string, { file: string; content: string }> = new Map([
  ["node:test", { file: "stubs/node-test.d.ts", content: NODE_TEST_STUB }],
  ["node:assert", { file: "stubs/node-assert.d.ts", content: NODE_ASSERT_STUB }],
  ["node:assert/strict", { file: "stubs/node-assert.d.ts", content: NODE_ASSERT_STUB }],
]);

/** TS2307 message → the specifier it blames. */
const CANNOT_FIND_MODULE = /Cannot find module '([^']+)'/;

export function typeCheckRepository(files: readonly TypeCheckSourceFile[]): TypeCheckResult {
  const tmpDir = mkdtempSync(join(tmpdir(), "jemma-tsc-"));
  try {
    const rootNames: string[] = [];
    for (const file of files) {
      assertRepoRelativePath(file.path);
      const absolute = join(tmpDir, "repo", ...file.path.split("/"));
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, file.source, "utf8");
      rootNames.push(absolute);
    }
    const paths: Record<string, string[]> = {};
    for (const [specifier, stub] of STUB_BY_SPECIFIER) {
      const absolute = join(tmpDir, stub.file);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, stub.content, "utf8");
      paths[specifier] = [`./${stub.file}`];
    }
    const ambient = join(tmpDir, "stubs", "ambient.d.ts");
    writeFileSync(ambient, AMBIENT_STUB, "utf8");
    rootNames.push(ambient);

    const gateDiagnostics = collectAllowlistDiagnostics(files);
    const program = ts.createProgram({
      rootNames,
      options: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        moduleResolution: ts.ModuleResolutionKind.Node10,
        strict: true,
        esModuleInterop: true,
        allowSyntheticDefaultImports: true,
        skipLibCheck: true,
        noEmit: true,
        jsx: ts.JsxEmit.ReactJSX,
        types: [],
        // Absolute: a relative baseUrl resolves against process.cwd(),
        // not the temp dir, which silently breaks `paths` stub resolution.
        baseUrl: tmpDir,
        paths,
      },
    });
    const compilerDiagnostics = ts
      .getPreEmitDiagnostics(program)
      .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
      // Allowlisted platform SDK modules bind as `any` at runtime via the
      // require-shim, so their TS2307 is expected — and ONLY theirs.
      .filter((diagnostic) => !isPlatformModuleResolutionError(diagnostic))
      .map((diagnostic): TypeCheckDiagnostic => {
        const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
        if (!diagnostic.file || diagnostic.start === undefined) {
          return { path: null, line: null, column: null, code: diagnostic.code, message };
        }
        const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
        return {
          path: toRepoRelative(tmpDir, diagnostic.file.fileName),
          line: line + 1,
          column: character + 1,
          code: diagnostic.code,
          message,
        };
      });

    const all = [...gateDiagnostics, ...compilerDiagnostics].sort(compareDiagnostics);
    const bounded = all.slice(0, MAX_TYPE_CHECK_DIAGNOSTICS);
    return { ok: all.length === 0, diagnostics: bounded, truncatedCount: all.length - bounded.length };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** Stable, actionable one-line rendering for the run log. */
export function formatTypeCheckDiagnostic(diagnostic: TypeCheckDiagnostic): string {
  const location = diagnostic.path === null
    ? ""
    : `${diagnostic.path}:${diagnostic.line}:${diagnostic.column} - `;
  const code = diagnostic.code === 0 ? "" : ` TS${diagnostic.code}`;
  return `${location}error${code}: ${diagnostic.message}`;
}

/**
 * Repo paths originate from the Stemma tree; real git trees cannot contain
 * `..` or absolute entries, but never write outside the temp mirror on
 * the strength of that — reject traversal defensively.
 */
function assertRepoRelativePath(path: string): void {
  if (path.startsWith("/") || path.split("/").includes("..")) {
    throw new Error(`unsafe repository path: ${path}`);
  }
}

/**
 * True iff the diagnostic is TS2307 blaming an allowlisted platform SDK
 * specifier. The allowlist gate (collectAllowlistDiagnostics) has already
 * rejected every other non-relative specifier, so this cannot hide
 * invented modules.
 */
function isPlatformModuleResolutionError(diagnostic: ts.Diagnostic): boolean {
  if (diagnostic.code !== 2307) return false;
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  const match = CANNOT_FIND_MODULE.exec(message);
  return match !== null && PLATFORM_MODULE_SPECIFIERS.has(match[1]);
}

function toRepoRelative(tmpDir: string, fileName: string): string {  const rel = relative(tmpDir, fileName).split("\\").join("/");
  return rel.startsWith("repo/") ? rel.slice("repo/".length) : rel;
}

function compareDiagnostics(a: TypeCheckDiagnostic, b: TypeCheckDiagnostic): number {
  const byPath = (a.path ?? "").localeCompare(b.path ?? "");
  if (byPath !== 0) return byPath;
  const byLine = (a.line ?? 0) - (b.line ?? 0);
  if (byLine !== 0) return byLine;
  return a.code - b.code;
}

/**
 * Explicit specifier gate: any static import/export/dynamic-import/require
 * of a non-relative specifier outside the runtime allowlist is an error,
 * independent of module resolution. Node built-ins are test-file-only.
 */
function collectAllowlistDiagnostics(files: readonly TypeCheckSourceFile[]): TypeCheckDiagnostic[] {
  const diagnostics: TypeCheckDiagnostic[] = [];
  for (const file of files) {
    const sourceFile = ts.createSourceFile(
      file.path,
      file.source,
      ts.ScriptTarget.ES2022,
      true,
      file.path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const check = (specifier: string, node: ts.Node): void => {
      if (specifier.startsWith("./") || specifier.startsWith("../")) return;
      if (PLATFORM_MODULE_SPECIFIERS.has(specifier)) return;
      if (file.kind === "test" && TEST_MODULE_SPECIFIERS.has(specifier)) return;
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      diagnostics.push({
        path: file.path,
        line: line + 1,
        column: character + 1,
        code: 0,
        message: `Import "${specifier}" is not available in the functions runtime`,
      });
    };
    const visit = (node: ts.Node): void => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
        && node.moduleSpecifier
        && ts.isStringLiteral(node.moduleSpecifier)) {
        check(node.moduleSpecifier.text, node.moduleSpecifier);
      } else if (ts.isCallExpression(node)
        && node.expression.kind === ts.SyntaxKind.ImportKeyword
        && ts.isStringLiteral(node.arguments[0])) {
        check(node.arguments[0].text, node.arguments[0]);
      } else if (ts.isCallExpression(node)
        && ts.isIdentifier(node.expression)
        && node.expression.text === "require"
        && node.arguments.length > 0
        && ts.isStringLiteral(node.arguments[0])) {
        check(node.arguments[0].text, node.arguments[0]);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return diagnostics;
}
