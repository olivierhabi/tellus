# Runbook — Funnel indexing close-out rollout / rollback

Applies to PR #85 and later funnel changes. Owner: @olivierhabi (CODEOWNERS).

## Before deploy

1. CI green, including `funnel-oop` (production profile, OOP merge, sim fleet,
   O1–O3 lite) and the latest nightly `funnel-scale` report within budget.
2. Run the invariant report against the target environment (read-only):
   `pnpm exec tsx scripts/funnel-invariants.ts --probe-storage > before.json`.
   Keep it to compare after the deploy.

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

After 24 h, run the checker again (`after.json`). Expect: no new errors;
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
