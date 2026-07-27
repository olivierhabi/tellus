# Projection Bootstrap Runbook — `link_instances`

`link_instances` (migration 122) is the canonical CURRENT active relationship state. Until bootstrapped + reconciled, v2 restrict-delete FAILS CLOSED.

## Bootstrap (idempotent)
```
PGHOST=… PGPORT=… PGDATABASE=… PGUSER=… PGPASSWORD=… \
  npx tsx scripts/bootstrap_link_instances.ts
```
The script replays the `link_edit` ledger in `executed_at, link_edit_id` order, resolving source/target object types per edge from the `link_type` definition, and upserts/deletes `link_instances` rows. Safe to re-run.

## Reconciliation (built into the script)
Output reports:
- `ledgerActiveCount` (canonical net-active edges from the ledger)
- `projectionCount` (current `link_instances` rows)
- `mismatches = onlyInLedger + onlyInProjection`

**MUST be 0** before enabling v2 execution. If non-zero:
1. Re-run the bootstrap (it is idempotent and recomputes from the ledger).
2. If `onlyInProjection > 0` persists, an edge exists in `link_instances` with no supporting ledger net > 0 — investigate the `link_type_api_name|src|tgt` key (use `SELECT * FROM link_instances WHERE link_type_api_name=… AND source_primary_key=… AND target_primary_key=…`).
3. If `onlyInLedger > 0` persists, the ledger says an edge is active but the projection lacks it — check the link-type definition exists and resolves object types; unresolved link types are skipped during bootstrap (logged via the cache miss path).

## Projection-ready gate
Only after `mismatches == 0`:
```
ACTION_SEMANTICS_V2_PROJECTION_READY=true
```
Then restart the app and re-run the v2 executor integration script to confirm v2 execution succeeds with the projection live.

## Operational metrics
- `tellus_action_projection_mismatch_total` — increment when a reconcile pass finds mismatches (plumb during the bootstrap script).
- The `link_instances` table size + index usage are verifiable with `EXPLAIN (ANALYZE, BUFFERS)` — see `scripts/action_semantics_v2_db_verify.ts`.
