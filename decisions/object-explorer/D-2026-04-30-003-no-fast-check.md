# D-2026-04-30-003 — `fast-check` not installed; hand-rolled property test

## Ambiguity

T-01 brief specifies "Property test with `fast-check` over arbitrary nested
`bool` shapes asserting wrapper idempotence after one application."

`fast-check` is not in `package.json`. Adding a new test-only dependency
is contention-prone (lock-file churn, CI snapshot mismatch).

## Options

1. Install `fast-check`. Rejected — out of scope, churn.
2. Hand-roll a deterministic property test using `seedrandom` (already a
   project dep). Chosen.

## Chosen

Use `seedrandom`-driven random-tree generators across N=200 iterations
with a fixed seed. The brief calls for "arbitrary nested bool shapes"
which is realisable with a recursive generator. Determinism via fixed
seed satisfies the "Determinism" cross-cutting test rule.
