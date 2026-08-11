# D-2026-04-30-010 — Use the TypeScript compiler API instead of ts-morph for the AST guard

## Ambiguity

The T-10 spec example imports `Project` and `SyntaxKind` from `ts-morph`,
but `ts-morph` is not in the project's dependency tree. Adding it would
introduce a new compile-time dep solely for one test file.

## Options considered

1. **Add `ts-morph` as a dev dependency.** Heavier (~800kB transitive),
   but matches the spec example exactly.
2. **Use the bundled `typescript` package's compiler API directly**
   (`ts.createSourceFile`, `ts.forEachChild`). Already a dependency;
   gives the same AST traversal semantics with no extra surface.

## Decision — option 2.

The compiler API path is one extra import line and zero new
dependencies. The two tools produce equivalent ASTs (ts-morph wraps the
compiler API). The guard's logic is the same: walk every
`router.<verb>(path, …, handler)` call and assert the handler body
contains `buildSecurityFilter(`, `readBranchHeader(`, and
`routeMetric(` — a regex match on `handlerArg.getText(sf)` is exactly
what ts-morph's `Node#getText()` returns.

## Rationale

- **Production safety:** fewer dependencies = smaller blast radius for
  CI hangs, transitive vulnerabilities, and Renovate noise.
- **Consistency:** the rest of the test suite uses bundled libs +
  vitest. Adding ts-morph makes one test file an outlier.
- **Reversibility:** if a future maintainer prefers the ts-morph API,
  swapping is a single file replacement; no other call sites depend on
  ts-morph.

## What would change this decision

If the AST walker grows beyond the trivial visitor pattern (e.g. needs
type-aware lookup, refactoring helpers, or symbol resolution across
files), ts-morph's higher-level API would justify the dep cost. The
current guard does not need any of that.
