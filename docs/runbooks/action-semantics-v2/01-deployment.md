# Action Semantics v2 — Deployment Runbook

Applies to migrations 121–124 + the v2 execution path. v1 behavior is unchanged unless the v2 flags are explicitly enabled.

## Feature flags (all default OFF / fail-closed)
- `ACTION_SEMANTICS_V2_ENABLED` — gate v2 EXECUTION. Default `false`.
- `ACTION_SEMANTICS_V2_CREATION_ENABLED` — gate v2 action-type CREATION via API/UI. Default `false`.
- `ACTION_SEMANTICS_V2_PROJECTION_READY` — required for v2 execution; set ONLY after the projection bootstrap + reconciliation runbook reports mismatch count == 0. Default `false`.
- `ACTION_SEMANTICS_V2_KILL_SWITCH` — hard override; when `true` both execution and creation are forced off regardless of the above.
- `NEXT_PUBLIC_ACTION_SEMANTICS_V2_CREATION_ENABLED` — frontend counterpart of the creation flag. Default `false`.

## Staged rollout
1. **Stage A (schema expansion)** — apply migration 121 (nullable columns). No behavior change. Existing rows have NULL semantics; read-time fallback resolves them to v1.
2. **Stage B (compatible deploy)** — deploy code that reads NULL as v1. Verify `action_legacy_default_used_total` counters.
3. **Stage C (backfill)** — apply migration 123 (bounded batch backfill to v1 defaults; verifies no NULLs remain).
4. **Stage D (constraints)** — apply migration 124 (NOT NULL + CHECK, added NOT VALID then validated online).
5. **Projection bootstrap** — run `scripts/bootstrap_link_instances.ts`; confirm reconciliation mismatch == 0 (see projection-bootstrap runbook).
6. **E2 enablement** — set `ACTION_SEMANTICS_V2_ENABLED=true` AND `ACTION_SEMANTICS_V2_PROJECTION_READY=true`. Leave CREATION off until further verification.
7. **E2 creation enablement** — set `ACTION_SEMANTICS_V2_CREATION_ENABLED=true` + `NEXT_PUBLIC_ACTION_SEMANTICS_V2_CREATION_ENABLED=true`; deploy frontend. New UI-created action types are v2.

## Acceptance gates before each stage advance
- Stage B→C: `action_legacy_default_used_total` is non-zero and stable; no 422 `UNSUPPORTED_SEMANTICS_VERSION` volume.
- Stage C→D: migration 123's trailing DO block raised no `semantics backfill incomplete` error.
- D→bootstrap: constraints validated; no NULLs remain.
- Bootstrap→E2: reconciliation mismatch == 0 (runbook check).
- E2→E2 creation: lint + unit + DB integration + the v2 executor integration script pass.

## Never
- Never set `ACTION_SEMANTICS_V2_PROJECTION_READY=true` before bootstrap + reconciliation report 0 mismatches.
- Never silently downgrade a v2 row to v1 (the executor fails closed on v2 when flags are off).
- Never drop the semantics columns during an emergency rollback (see rollback runbook).
