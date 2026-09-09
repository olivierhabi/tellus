# Pipeline orchestration & lineage

Static scanners report "no dedicated orchestrator" because they look for
Airflow/Dagster imports. The orchestrator is **Temporal**, and lineage is
a first-class model — this page maps both to code.

## Orchestrator: Temporal

All durable execution runs on Temporal (`temporalio/auto-setup:1.25.2`):

| Concern | Implementation |
|---------|----------------|
| Object-data funnel | Workflows/activities in `src/services/pipelines/temporal/` (`workflows.ts`, `activities.ts`), workers in `src/workers/` |
| Dispatch | `src/services/funnel/funnelDispatcher.ts` — durable `funnel_signal` outbox, `dispatch_pending → workflow_started` CAS |
| Durable journal | `src/services/funnel/durableWorkflow.ts` — one `funnel_run` row per workflow before any activity runs |
| Isolation | Every deployment owns its namespace + task queue; activities fence env/worker/db-seal (`FunnelExecutionEnvironmentMismatch`) — see `AGENTS.md` "Temporal / Object Data Funnel isolation" |
| Versioning | Build-ID assignment + redirect rules via `scripts/temporal-versioning.ts`; replay gate in `tests/funnel/unit/worker-versioning-replay-unit.test.ts` |
| Pipeline builds | `src/services/orchestration/` queue (`build-dispatcher.ts`, `build-event-bus.ts`) + `src/services/pipelines/buildScheduler.ts` |

Poller health: `scripts/verify-temporal-pollers.sh` (identities are
`<envId>:<buildId>:<pid>@host`). Dynamic config: `deploy/temporal/dynamicconfig.yaml`.

## Lineage

Lineage is stored, not inferred:

- **Deploy edges** — `src/services/pipelines/datasetLineage.ts`:
  `pipeline_output` (Pipeline-Builder deploy output), `funnel_input`,
  `virtual_table`. Convenience reader: edges feeding a dataset.
  Written on deploy completion by
  `DeploymentService.applyDeployLineageAndSignals` (PB-B8), which also
  fires one Funnel signal per affected Object Type
  (fingerprint `${deploymentId}-${ontologyId}-${objectTypeApiName}`,
  deduped by `funnel_signal.signal_fingerprint_unique`).
- **Query-time graph** — `src/services/lineageService.ts`
  (`computeLineage`, max depth 5) exposed to Functions as
  `ObjectSet.searchAround` pivots (`src/services/functions/ontologyRuntime.ts`).
- **Immutable definition snapshots** — every `funnel_run` carries the
  pipeline definition + execution plan that produced it
  (`src/services/funnel/executionPlan.ts`), so a historical run is
  reproducible after the pipeline evolves (proven by
  `tests/funnel/integration/pipeline-evolution-integration.test.ts`).
- **Run audit** — `funnel_run` + `funnel_stage_run` tables
  (`src/migrate.ts`), surfaced at `GET /api/v1/funnel/runs/:objectType`
  (`src/routes/funnel.ts`) and `funnel_run_in_flight` gauges
  (`src/services/funnel/metrics.ts`).

## Data-quality gates (where validation lives)

There is no standalone Great Expectations service by design; validation
is layered:

1. **Publish/activation time** — Zod schemas on every route
   (`src/middleware/requestValidator.ts`), typed errors
   (`AppError`/`OntologyError`), function parameter validation
   (`src/services/functions/parameterValidation.ts`, authoritative).
2. **Deploy time** — preview-snapshot pinning (`PREVIEW_STALE` /
   `PREVIEW_SNAPSHOT_EXPIRED`, see `src/services/deploy/previewPinning.ts`),
   schema-evolution checks, idempotency keys.
3. **CI** — `.github/workflows/coverage-gate.yml` (branch floors on
   critical-path modules), ghost-pass gate, secret scan, CVE scan.
