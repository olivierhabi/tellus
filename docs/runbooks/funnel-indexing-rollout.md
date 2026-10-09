# Runbook — Funnel indexing close-out rollout / rollback

Applies to PR #85 and later funnel changes. Owner: @olivierhabi (CODEOWNERS).

## Before deploy

1. CI green, including `funnel-oop` (production profile, OOP merge, sim fleet,
   O1–O3 lite) and the latest nightly `funnel-scale` report within budget.
2. Baseline: `./run.sh` runs the read-only funnel invariant report after every
   full deploy (inside the `app` container, so it sees this deployment's
   Postgres + object store) and writes `reports/funnel-invariants-<ts>.json`.
   Keep the first report as the baseline. Ad hoc on a running stack:
   `docker compose -p <project> exec -T app node dist/funnelInvariants.js --probe-storage`.
   Modes: `RUN_INVARIANTS=warn` (default, never fails the deploy),
   `RUN_INVARIANTS=strict` (fail on error-level violations — switch to this
   once the baseline is clean), `--no-invariants` / `RUN_INVARIANTS=0` to skip.

## Deploy

1. **Staging first.** Deploy the image; migrations 192–195 run at boot
   (forward migrations are idempotent).
2. Trigger a reindex of 2–3 representative object types (one large, one
   with duplicate PKs, one with a non-alphabetical CSV header).
3. **Canary production**: one worker on the new image for ≥1 h, then all.

## Watch (first 24 h)

| Signal | Source | Act when |
|---|---|---|
| Merge failures | `funnel_run.status='failed'` with `current_stage='merge'` | any new failure mentioning `properties differ` or `statement timeout` |
| Zero-row runs | `funnel_state` indexed with `objects_indexed=0` | any new one ⇒ invariant report `GHOST_*` |
| Stuck indexing | `STALE_LEASE` / `STALLED_PROGRESS` from the checker | lasts longer than one watchdog cycle |
| Duplicate PKs | `funnel_snapshot.summary_json.source_quality.duplicatePkRows > 0` | list affected types for the phase-2 ADR |
| Orphan staging | `ORPHAN_STAGING` | rows older than the merge CLI ceiling |

After 24 h, run the checker again (re-run `./run.sh --no-build`, or the
`docker compose … exec` command above). Expect: no new errors;
`REPLAY_REQUIRED` types reindexed and cleared; `GHOST_INDEXED_EMPTY` types
reindexed (they now either index rows or fail loudly).

## Rollback

1. Redeploy the previous image (application rollback alone is safe:
   migrations 192–195 only add columns, tables and indexes).
2. Only if the schema itself must go: apply `192…195 .down.sql` in reverse
   order (proven reversible + re-appliable by
   `indexing-closeout-migrations-integration.test.ts`).
3. Leftover `merge_staging_instances` rows from interrupted merges are safe:
   they never reach live data and are cleared on the next run of the same type.
