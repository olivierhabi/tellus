# Projection Reconciliation Runbook

Run periodically (and after any `link_edit` write anomaly) to verify the projection matches the ledger-derived active state.

## Command
```
npx tsx scripts/bootstrap_link_instances.ts
```
The trailing reconciliation block reports the mismatch breakdown. For an always-on check, call `reconcileProjection()` (or `isProjectionReady()`) from a monitoring job and alert on `mismatches > 0`.

## Mismatch triage
- `onlyInLedger > 0`: projection is missing an active edge.
  - Cause A: the link_type was unresolved at bootstrap time (no `link_type` row or object-type api_name unresolvable). Fix the link_type definition and re-run bootstrap.
  - Cause B: a `link_edit` row was inserted out-of-order (clock skew). Re-running the bootstrap with `executed_at, link_edit_id` ordering reconciles.
- `onlyInProjection > 0`: projection has an edge the ledger does not support.
  - Cause: a manual `link_instances` insert or a botched dual-write. Delete the orphan row and re-run.
- After any fix, `mismatches` must return to 0 before `ACTION_SEMANTICS_V2_PROJECTION_READY` is (re)set.

## v2 fail-closed behavior while inconsistent
The executor's Stage 1b gate rejects v2 execution when `isV2ProjectionReady()` is false (or when v2 execution is off). v1 execution is never affected by projection state.
