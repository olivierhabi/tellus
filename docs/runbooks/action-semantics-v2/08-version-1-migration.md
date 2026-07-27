# Version-1 → Version-2 Migration Runbook (per action type)

Migration is per-action-type, EXPLICIT, and never automated.

## Analysis
```
GET /v1/ontology/:ontologyId/actionTypes/:actionApiName/migrationAnalysis
```
Returns `{ classification, findings, migrationPermitted, deletePolicyImpact, … }`.

In the UI: open the action type editor; the **Version-1 → Version-2 migration** panel shows the classification tag + findings (with `ruleIndex` paths) + delete-policy impact. `migrationPermitted` is true ONLY when the action is currently v1 and classified `compatible`.

## Classifications
- `compatible` — safe to migrate; migrate button shown.
- `incompatible` — ≥1 blocker finding (e.g. a modify/delete rule uses a primitive string parameter as object reference). Fix the action type definition (change the parameter to `object_reference` with an `objectType`), then re-run analysis.
- `potentially_incompatible` — runtime-dependent (e.g. create + modify of the same object type; could collide at runtime on identical PKs). Review the rule set; if the runtime can never collide, document it and re-classify via a definition change. The migration endpoint will NOT migrate this.
- `unable_to_determine` — missing metadata; fix and re-analyze.

## Migration (confirmation)
```
POST /v1/ontology/:ontologyId/actionTypes/:actionApiName/migrate   { "targetVersion": 2 }
```
- Re-runs analysis SERVER-SIDE; rejects any non-`compatible` classification with `INCOMPATIBLE_ACTION_SEMANTICS`.
- Updates `action_type.{semantics_version, execution_mode, delete_policy}` atomically.
- Requires `ontology-editor` authorization (route-level `dataPlaneGuard`).
- Records the migration actor + timestamp (via `updated_at`); response includes `migrationRecord: { actor, migratedAt, previousVersion, newVersion }`.
- Never migrates automatically; never silently downgrades.

## Post-migration
- Reload the editor page; the semantics version tag reads v2; the migration panel hides (v2 has no v1→v2 target).
- Execute the migrated action once against a known target; the audit row must carry `semantics_version=2`, `correlation_id`.
- v2 enforce: restrict-delete, same-invocation rules, typed object_reference — now active for this action type.
