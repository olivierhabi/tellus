# Decisions — T-02 (B2)

## D-13 — Validator stays strict; tests use EXPRESSION for ANY-typed slots
**Date**: 2026-05-04
**Ambiguity**: Tests originally bound `PARAMETER_STRING` cards into
`AGGREGATION.group` (declared `ARRAY_STRING`) and `FUNCTION_CALL.functionRid`
(declared `RID`). Validator rejected them as `CardTypeInputMismatch`.

**Options**:
1. Loosen the registry — accept STRING wherever ARRAY_STRING is declared.
2. Loosen the validator — promote STRING → ARRAY_STRING implicitly.
3. Fix the tests — use EXPRESSION (output ANY) for these slots.

**Chosen**: 3. The Decision-Protocol default is "more restrictive over less".
EXPRESSION's `output: "ANY"` is exactly the documented escape hatch for
literal-typed slots in the spec. Loosening type checks would silently allow
malformed instructions through and would defeat C-04.

**Evidence that would change it**: a spec amendment naming `STRING` as
implicitly promotable to `ARRAY_STRING`.

**Contracts affected**: B2 C-04, B2 C-15, B2 C-16.

---

## D-14 — Validator SLO measured as a unit test
**Date**: 2026-05-04
**Ambiguity**: Spec C-14 names P50/P95/P99 targets and labels the path
"CPU-bound, no I/O." The drive's testing requirements list a separate
`tests/load/<service>/` directory using k6 for SLO assertions.

**Options**:
1. Defer SLO measurement to a phase-boundary k6 run.
2. Assert SLO inline in a vitest unit test (no I/O, deterministic).

**Chosen**: 2. The validator surface is CPU-pure; k6 would add HTTP
overhead unrelated to the bound being measured. Inline vitest gives a
deterministic regression gate that runs on every commit.

**Evidence that would change it**: SLO regressions that only manifest
under concurrent HTTP load (would force an HTTP-level k6 run).

**Contracts affected**: B2 C-14.

---

## D-15 — `EXPRESSION` output type is `ANY`, not parameterized
**Date**: 2026-05-04
**Ambiguity**: Spec describes EXPRESSION as having an output type
declared in `card.config.declaredOutput` (registry entry sets it to "ANY"
as a placeholder). Validator's covariance rules treat ANY upstream as
acceptable everywhere.

**Options**:
1. Read `card.config.declaredOutput` and substitute that into the
   covariance check (per-card output type).
2. Keep ANY as the registry default; defer per-card override to B5
   (compute coordinator) which has the type metadata.

**Chosen**: 2. B2's job is structural validation; per-card declared types
are a runtime concern (which backend executes the expression and what it
returns). Tracking this here would couple B2 to expression semantics.

**Evidence that would change it**: a spec C-04 amendment naming
`card.config.declaredOutput` as part of the structural validation contract.

**Contracts affected**: B2 C-04, B2 C-16, indirectly B5.
