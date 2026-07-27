# Database Rollback Policy — Action Semantics v2

Migrations 121–124 are ADDITIVE + backward-compatible. Database rollback is a LAST RESORT and is gated.

## Reversible migrations (in reverse order)
- 124 → `124_action_semantics_constraints.down.sql` — drops CHECK constraints and reverts NOT NULL to nullable. Non-destructive (no data lost).
- 123 → one-way no-op down (backfill is not reversed; re-nulling would break read-fallback semantics).
- 122 → `122_link_instances_projection.down.sql` — drops `link_instances` + indexes. Safe; the `link_edit` ledger remains the source of truth and can re-bootstrap.
- 121 → `121_action_semantics_v2.down.sql` — drops the semantics columns. **DESTRUCTIVE**: loses the persisted v1/v2 distinction. Gate this behind an explicit ops decision and only after confirming no v2 action types remain that you intend to preserve.

## Emergency rollback order (preferred → last)
1. Application kill switch (`ACTION_SEMANTICS_V2_KILL_SWITCH=true`) + app image rollback. Keeps schema. (Recommended.)
2. Run `124 …down.sql` to relax constraints only. Keeps columns + data.
3. Run `122 …down.sql` to drop `link_instances`. Keeps `link_edit`; v2 execution already disabled by kill switch.
4. ONLY if reclaiming column space: run `121 …down.sql` to drop the semantics columns. Irreversible distinction loss.

## Verification after any DB rollback
- `SELECT COUNT(*) FROM action_type WHERE semantics_version IS NULL` matches pre-rollback expectations.
- `to_regclass('link_instances')` is null after step 3.
- v1 execution smoke test passes.
