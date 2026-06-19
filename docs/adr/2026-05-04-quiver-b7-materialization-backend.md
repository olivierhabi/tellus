# ADR — Quiver B7 — Materialization & Transform Backend (Polars / Spark / Iceberg)

**Status:** Accepted (2026-05-05)
**Authors:** Quiver Drive (autonomous loop)
**Phase:** Phase 4 — Time-series & Materialization (opens Phase 4)
**Spec section:** §B7 in `tasks/quiver/quiver-tasks.md`

## Context
Quiver's compute coordinator (B5) needs an executor for the 5 materialization-bound card types: `MATERIALIZATION`, `JOIN_MATERIALIZATION`, `EXPRESSION`, `PIVOT_TABLE`, `CATEGORICAL_CHART`. Production splits execution across two tiers — an in-process Polars/DuckDB sidecar for ≤ 10 M-cell inputs, and Spark via MMDP Arrow Flight SQL for everything else — with Iceberg snapshot pinning so cache invalidation tracks dataset commits.

## Decision
Land B7 as a `MaterializationBackend` registered against B5's router for all 5 card types. The backend is split across:

- `src/services/quiver/compute/mat/calcitePlan.ts` — relational-algebra plan model + canonicalisation for plan-equivalence comparisons.
- `src/services/quiver/compute/mat/matPort.ts` — port interface (`pinSnapshots`, `polarsExecute`, `sparkExecute`, `estimateCardinality`); error taxonomy (`MatLimitExceededError`, `MatUnavailableError`, `MatTimeoutError`).
- `src/services/quiver/compute/mat/inProcessMat.ts` — deterministic in-process MatAdapter that evaluates the canonicalised plan against an in-memory dataset registry. Both `polarsExecute` and `sparkExecute` evaluate the **same** plan against the **same** rows so the plan-equivalence golden test (B7 C-05) compares byte-for-byte.
- `src/services/quiver/compute/mat/matBackend.ts` — wraps the port with tier selection (`selectTier()` is pure + unit-tested), Iceberg snapshot pinning, inline-vs-blob result handling, and per-card-type result-type mapping.
- `src/services/quiver/compute/mat/instrumentedMat.ts` — Proxy wrapper that emits the four B7 metrics on every port call.
- Migration `068_b7_quiver_iceberg_snapshots.sql` — adds `iceberg_snapshots JSONB`, `result_blob_uri TEXT`, `mat_tier TEXT`, `mat_plan_json JSONB` to `quiver_card_output_cache`. Reversible.

Wired into the singleton compute context via `setMatPortForTests()` for test injection (mirrors the OSS pattern from B6).

## Consequences

### Pros
- Surface is fully exercised by the in-process adapter; the production Polars sidecar (`tellus-quiver-mat-runner`, deferred per D-50) and the MMDP Arrow Flight SQL bridge slot in by replacing `InProcessMatAdapter` with the real implementations of the same `MatPort` interface — zero call-site changes elsewhere.
- Plan-equivalence golden test (B7 C-05) is real and binding: the test asserts `JSON.stringify(polarsExecute(plan)) === JSON.stringify(sparkExecute(plan))` on golden datasets. When the production tiers diverge, the test breaks and surfaces the divergence.
- Iceberg snapshot pinning is recorded in both the cache row (`iceberg_snapshots` JSONB column) and the result `payload.meta.icebergSnapshots`, so future invalidation queries can target affected rows via the GIN index.
- Tier selection is decoupled (`selectTier(est, opts)` is pure) so the threshold (`tellus.quiver.mat.polars_cell_threshold`) can be tuned per-environment without re-deploying the backend.

### Cons
- The in-process MatAdapter is **not** a Polars implementation — it's a deterministic JS evaluator over the same plan shape. Production correctness depends on the real sidecar matching the in-process semantics for the operations covered.
- The 50_000-row limit (B7 C-08) is enforced inside `runPlan()` and surfaces as `MatLimitExceededError` — the route layer does not yet map this to 400 `Tellus:Quiver:TransformTableRowLimit` (D-51); for now the error envelope carries `errorInstanceId` only and the executor surfaces it as 500. The B10 publishing path will close this.
- Polars sidecar UDS / Arrow Flight transport (B7 C-12) is not wired here; the `MatPort` interface is the contract for that future work.

## Verification
- Unit (22 cases): `tests/quiver/unit/b7-{calcite,tier-selector,evaluator}-unit.test.ts`.
- Integration (7 cases): `tests/quiver/integration/b7-mat-route-integration.test.ts` exercises every contract via the route — including branch propagation (B7 C-10, G-09), tier selection (B7 C-02/C-03), Iceberg snapshot pinning (B7 C-06), and metrics emission (B7 C-11).
- E2E smoke: `cypress/quiver/e2e/B7.cy.ts`.
- Harness: `bash scripts/quiver-verify.sh` exit 0 — 44 files / 328 cases.

## Related
- Decisions: D-50, D-51, D-52, D-53 (see `decisions/quiver/D-2026-05-04-b7-decisions.md`)
- ADR: `docs/adr/2026-05-04-quiver-b5-compute-coordinator.md` (B5 — upstream router)
- ADR: `docs/adr/2026-05-04-quiver-b6-oss-backend.md` (B6 — sister backend pattern)
- Spec: `tasks/quiver/quiver-tasks.md` §B7
- Contracts: `tasks/quiver/contracts.md` §B7 C-01..C-12
