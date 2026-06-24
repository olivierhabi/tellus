# ADR — Quiver B2: Card DAG Model, Card Type Registry, and DagValidator

- **Status**: Accepted
- **Date**: 2026-05-04
- **Task**: T-02 (B2)
- **Spec**: `tasks/quiver/quiver-tasks.md` §B2; contracts `tasks/quiver/contracts.md` §B2 C-01..C-18

## Context

B2 defines the type system and runtime invariants for every Quiver analysis
document. Six rules gate every PATCH/instruction-apply:

1. Type compatibility on every input edge (covariant).
2. Acyclicity on the **definition graph** (`inputs[]`).
3. Parameter cards have no inputs.
4. `canvas.ordering[]` only references existing card IDs.
5. Total cards ≤ 500 (soft warn at 200).
6. Total canvases ≤ 50.

The same `validate()` runs as a public `POST /analyses/:rid/_validate`
endpoint and (later) inside every B3 instruction-apply path; the rejection
envelope must be byte-identical between the two surfaces.

## Decision

- **Card Type Registry** is a single in-code map of 26 entries
  (`src/services/quiver/dag/cardTypeRegistry.ts`), cross-checked at boot
  against the locked golden file `tasks/quiver/registry-fixture.md`.
  `assertRegistryIntegrity()` runs in `buildQuiverRouter()`; drift throws.
- **Type covariance** is encoded centrally in `isOutputAcceptable()`:
  - `OBJECT_SET` is acceptable wherever `TRANSFORM_TABLE` or
    `MATERIALIZATION` is expected.
  - `MATERIALIZATION` is acceptable wherever `TRANSFORM_TABLE` is expected.
  - `ANY` matches anything (used by `EXPRESSION` / `FUNCTION_CALL` /
    `VISUAL_FUNCTION_CALL`).
- **Topological order** uses Kahn's algorithm with a **sorted frontier** at
  every step to make output deterministic across runs (B2 C-11).
- **Cycle detection** runs on the definition graph (the `inputs[]` map),
  not the runtime evaluation graph; self-edges are caught in `buildDag()`
  before reaching the topological pass (B2 C-17).
- **Card-ID allocation** uses a per-analysis monotonic counter (`$A`, `$B`,
  …, `$Z`, `$AA`, …); deletion does not free an ID (B2 C-10).
- **Validate API surface**: `POST /quiver/api/v1/analyses/:rid/_validate`
  loads the persisted document and returns
  `{ valid, topologicalOrder, warnings }` on success or a Conjure envelope
  on rejection (B2 C-13).
- **Metrics** (B2 C-18, G-09):
  `tellus_quiver_dag_validate_seconds{result}` (Histogram),
  `tellus_quiver_dag_validate_failure_total{error_name}` (Counter),
  `tellus_quiver_dag_validate_card_count` (Histogram, no labels),
  `tellus_quiver_cards_per_dag` (Gauge, no labels). Bounded label
  cardinality (no per-RID labels).

## Consequences

- B5 (compute coordinator) and B3 (OT engine) consume the same
  `validate()` function; they cannot diverge on which graphs are valid.
- F5 (frontend card plugins) reads the registry-fixture file at build
  time so the plugin set is always exactly 26.
- Adding a card type requires updating both the registry and the
  fixture file; CI fails if they drift.

## Decisions Logged

- D-2026-05-04 D-13: `EXPRESSION` is the supplier of array/RID-typed slots
  in tests; tests originally bound `PARAMETER_*` cards which violate type
  contracts. Validator stays strict (D-Strict default).
- D-2026-05-04 D-14: SLO test is run as a unit test (CPU-only); 250-card
  workload is a representative mid-range; full 500-card chain validates
  within the same bound.

## Verification

`scripts/quiver-verify.sh` exits 0 with 133 tests across 17 files; all 18
B2 contracts referenced. See `tasks/quiver/PROGRESS.md` Iteration 2 entry.
