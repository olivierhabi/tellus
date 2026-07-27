# Version-2 Enablement Runbook

Enable v2 ONLY after the deployment + projection-bootstrap runbooks are complete.

1. Confirm `mismatches == 0` from the bootstrap/reconciliation script.
2. Set environment (app server):
   ```
   ACTION_SEMANTICS_V2_ENABLED=true
   ACTION_SEMANTICS_V2_PROJECTION_READY=true
   ```
   Leave `ACTION_SEMANTICS_V2_CREATION_ENABLED=false` for the first phase.
3. Restart the app. Run the v2 executor integration script (`scripts/v2_executor_integration.ts`) against the target DB; confirm: v2 modify succeeds, audit row carries `semantics_version=2, execution_mode='declarative', correlation_id=<uuid>`.
4. Create-action enablement:
   ```
   ACTION_SEMANTICS_V2_CREATION_ENABLED=true
   NEXT_PUBLIC_ACTION_SEMANTICS_V2_CREATION_ENABLED=true  # frontend build-time
   ```
   Rebuild + redeploy the frontend. New UI-created action types are v2.
5. Confirm the `/actionTypes/:apiName/migrationAnalysis` route returns a classification for an existing v1 action; do NOT auto-migrate (see v1-migration runbook).

## Verify defaults are still off
In a fresh shell with no flags exported, `curl` the `/actionTypes` create endpoint with `semanticsVersion: 2` — it must return 422 `UNSUPPORTED_SEMANTICS_VERSION` until `ACTION_SEMANTICS_V2_CREATION_ENABLED=true`.
