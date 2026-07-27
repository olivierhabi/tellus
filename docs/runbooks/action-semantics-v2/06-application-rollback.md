# Application Rollback Runbook

Roll back the APPLICATION code while KEEPING the schema (migrations 121–124) in place. v2 rows stay v2; v1 rows stay v1; the read-time fallback keeps interpreting NULL as v1.

## Steps
1. Disable v2 (kill switch first, fastest):
   ```
   ACTION_SEMANTICS_V2_KILL_SWITCH=true    # immediate, no deploy needed if env-overridable
   ```
2. Roll back the application image to the previous (pre-v2-code) build.
   - The pre-v2 build reads `action_type`/`action_audit_log` WITHOUT referencing the semantics columns; extra columns are ignored harmlessly.
   - v2 action types persisted during the rollout remain at `semantics_version=2`. The pre-v2 build treats them as the old behavior (no v2 enforcement). This is intentional fail-OPEN for rollback safety and is the ONLY sanctioned semantic downgrade path; document which v2 action types existed and re-migrate them after re-deploy (see v1-migration runbook).
3. Verify v1 execution still works end-to-end.
4. Do NOT enable v2 again until the deployment runbook is re-run from the DB-verification step.

## What NOT to do
- Do NOT drop the semantics columns during an emergency rollback (see database-rollback policy). Dropping them loses the v1/v2 distinction and forces a full re-derivation.
- Do NOT silently downgrade v2 rows to v1 in bulk (the dedicated `/migrate` endpoint never supports downgrade; v2→v1 is not a supported automated operation).
