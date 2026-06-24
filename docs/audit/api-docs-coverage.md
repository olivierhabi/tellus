# API documentation coverage audit (498 real ops, 244 documented)

- Real endpoints: **498**
- Documented (in /api/docs): **244** (224 match a real route)
- **UNDOCUMENTED real endpoints: 274** (55% of surface)
- **PHANTOM documented endpoints (don't exist as documented): 3**

## Phantom documented endpoints
- `GET /health/ready` — documented under base `/api` → resolves to `/api/health/ready` which 404s; real path is `/health/ready`.
- `GET /api/v1/audit` — bare path does not exist; real: `/api/v1/audit/log`, `/api/v1/audit/stats`.
- `GET /api/v1/ontology/{ontologyId}/objectTypes/{apiName}/index` — bare path does not exist; real: `.../index/reindex/status`, `.../index/reindex/history`.

## Undocumented real endpoints (full list)

### /api/v1/auth
- `DELETE /api/v1/auth/me/credentials/:credentialId`

### /api/v1/code-repositories
- `DELETE /api/v1/code-repositories/:rid`
- `DELETE /api/v1/code-repositories/:rid/branches/:branch`

### /api/v1/ontology
- `DELETE /api/v1/ontology//interfaces/:interfaceApiName`
- `DELETE /api/v1/ontology//objectTypes//implements/:interfaceApiName`
- `DELETE /api/v1/ontology//objectTypes//index/`
- `DELETE /api/v1/ontology//objectTypes/properties/:propApiName`

### /api/v1/projects
- `DELETE /api/v1/projects//members/:userId`
- `DELETE /api/v1/projects//pipelines/:pipelineId/deployments/:deploymentId`

### /api/v1/workshop
- `DELETE /api/v1/workshop/modules/:rid`

### /api/v1/connectivity
- `DELETE /api/v1/connectivity/connections/:rid`
- `DELETE /api/v1/connectivity/connections/:rid/secrets/:name`
- `DELETE /api/v1/connectivity/egress-policies/:eprid`
- `DELETE /api/v1/connectivity/imports/:importRid`
- `DELETE /api/v1/connectivity/virtual-tables/:vrid`

### /quiver/api/v1
- `DELETE /quiver/api/v1/=/analyses/:rid`

### /api/docs
- `GET /api/docs`

### /api/docs/spec.json
- `GET /api/docs/spec.json`

### /api/v1/auth
- `GET /api/v1/auth/health`
- `GET /api/v1/auth/oidc/config`
- `GET /api/v1/auth/pat-scopes`
- `GET /api/v1/auth/saml/metadata`
- `GET /api/v1/auth/token-info`

### /api/v1/code-repositories
- `GET /api/v1/code-repositories/`
- `GET /api/v1/code-repositories/:rid`
- `GET /api/v1/code-repositories/:rid/branches`
- `GET /api/v1/code-repositories/:rid/branches/:branch/files`
- `GET /api/v1/code-repositories/:rid/branches/:branch/tree`
- `GET /api/v1/code-repositories/:rid/functions`
- `GET /api/v1/code-repositories/:rid/resource-imports`
- `GET /api/v1/code-repositories/:rid/settings`

### /api/v1/compass
- `GET /api/v1/compass/folders/:folderRid/children`

### /api/v1/datasets
- `GET /api/v1/datasets/`
- `GET /api/v1/datasets/:datasetId/download`
- `GET /api/v1/datasets/:datasetId/transactions`

### /api/v1/functions
- `GET /api/v1/functions/functions/:repositoryRid/resolve`
- `GET /api/v1/functions/functions/:repositoryRid/versions`
- `GET /api/v1/functions/functions/:repositoryRid/versions/:semver`

### /api/v1/funnel
- `GET /api/v1/funnel/clickhouse/cdc-lag`
- `GET /api/v1/funnel/instances/:objectType/:pk`
- `GET /api/v1/funnel/lakekeeper/info`
- `GET /api/v1/funnel/lakekeeper/warehouses`
- `GET /api/v1/funnel/metrics`
- `GET /api/v1/funnel/overlay/:objectType/:pk`
- `GET /api/v1/funnel/replacement/:objectType`
- `GET /api/v1/funnel/replacement/:objectType/preview-cutover`
- `GET /api/v1/funnel/runs/:objectType`
- `GET /api/v1/funnel/runs/objectTypeId/:objectTypeId`
- `GET /api/v1/funnel/slis`
- `GET /api/v1/funnel/slis/metrics`
- `GET /api/v1/funnel/snapshots`

### /api/v1/health
- `GET /=/api/v1/health`

### /api/v1/objects
- `GET /=/api/v1/objects/:objectType`
- `GET /=/api/v1/objects/:objectType/:primaryKey/links/:linkType`
- `GET /=/api/v1/objects/:objectType/:primaryKey/links/:linkType/count`
- `GET /api/v1/objects/:primaryKey/linked`
- `GET /api/v1/objects/:primaryKey/view`

### /api/v1/ontology
- `GET /=/api/v1/ontology/:ontologyId/export`
- `GET /api/v1/ontology//exports/:jobId/download`
- `GET /api/v1/ontology//governance/lineage/by-id/:objectTypeId`
- `GET /api/v1/ontology//governance/usage/by-id/:objectTypeId`
- `GET /api/v1/ontology//interfaces/:interfaceApiName`
- `GET /api/v1/ontology//linkTypes/:apiName/analysis`
- `GET /api/v1/ontology//linkTypes/export`
- `GET /api/v1/ontology//objectTypeId/history`
- `GET /api/v1/ontology//objectTypeId/status`
- `GET /api/v1/ontology//objectTypes//dataStore/`
- `GET /api/v1/ontology//objectTypes//edits/diff/:primaryKey`
- `GET /api/v1/ontology//objectTypes/:apiName/export`
- `GET /api/v1/ontology//objectTypes//implements/`
- `GET /api/v1/ontology//objectTypes//index/reindex/history`
- `GET /api/v1/ontology//objectTypes//index/reindex/status`
- `GET /api/v1/ontology//objectTypes//index/status`
- `GET /api/v1/ontology//objectTypes//reindex/history`
- `GET /api/v1/ontology//objectTypes//reindex/status`
- `GET /api/v1/ontology//objectTypes/:apiName/statistics`
- `GET /api/v1/ontology//objectTypes/by-id//edits/`
- `GET /api/v1/ontology//objectTypes/by-id//edits/diff/:primaryKey`
- `GET /api/v1/ontology//objectTypes/objects/:primaryKey/linked`
- `GET /api/v1/ontology//objectTypes/objects/:primaryKey/view`
- `GET /api/v1/ontology//objectTypes/properties`
- `GET /api/v1/ontology//objectTypes/properties/:propApiName`

### /api/v1/projects
- `GET /api/v1/projects/:projectId/autosave-snapshots`
- `GET /api/v1/projects/datasets`
- `GET /api/v1/projects/datasets/all`
- `GET /api/v1/projects/external-references`
- `GET /api/v1/projects/file-references`
- `GET /api/v1/projects/trashed`

### /api/v1/search
- `GET /api/v1/search/typeahead`

### /api/v1/status
- `GET /=/api/v1/status`

### /api/v1/system
- `GET /=/api/v1/system/health`
- `GET /=/api/v1/system/liveness`
- `GET /=/api/v1/system/readiness`

### /api/v1/templates
- `GET /api/v1/templates/`
- `GET /api/v1/templates/:templateId/versions/:version`

### /api/v1/workshop
- `GET /api/v1/workshop/action-types`
- `GET /api/v1/workshop/action-types/:idOrApiName`
- `GET /api/v1/workshop/metrics`
- `GET /api/v1/workshop/modules`
- `GET /api/v1/workshop/modules/:rid`
- `GET /api/v1/workshop/modules/:rid/versions/:semver`
- `GET /api/v1/workshop/object-types`
- `GET /api/v1/workshop/object-types/:idOrApiName`
- `GET /api/v1/workshop/resolve/dev`
- `GET /api/v1/workshop/resolve/latest`

### /api/v1/connectivity
- `GET /api/v1/connectivity/connections`
- `GET /api/v1/connectivity/connections/:rid`
- `GET /api/v1/connectivity/connections/:rid/configuration`
- `GET /api/v1/connectivity/connections/:rid/discovery/catalog`
- `GET /api/v1/connectivity/connections/:rid/discovery/columns`
- `GET /api/v1/connectivity/connections/:rid/discovery/imported-keys`
- `GET /api/v1/connectivity/connections/:rid/discovery/preview`
- `GET /api/v1/connectivity/connections/:rid/discovery/primary-keys`
- `GET /api/v1/connectivity/connections/:rid/discovery/schemas`
- `GET /api/v1/connectivity/connections/:rid/discovery/tables`
- `GET /api/v1/connectivity/connections/:rid/imports`
- `GET /api/v1/connectivity/connections/:rid/snapshots`
- `GET /api/v1/connectivity/connections/:rid/status`
- `GET /api/v1/connectivity/connections/:rid/virtual-tables`
- `GET /api/v1/connectivity/connector-types`
- `GET /api/v1/connectivity/egress-policies`
- `GET /api/v1/connectivity/egress-policies/:eprid`
- `GET /api/v1/connectivity/folders`
- `GET /api/v1/connectivity/folders/:rid`
- `GET /api/v1/connectivity/imports/:importRid`
- `GET /api/v1/connectivity/imports/:importRid/builds`
- `GET /api/v1/connectivity/virtual-tables/:vrid`

### /health
- `GET /health`

### /health/detailed
- `GET /health/detailed`

### /health/ready
- `GET /health/ready`

### /quiver/api/v1
- `GET /quiver/api/v1/=/aip/traces/:rid`
- `GET /quiver/api/v1/=/analyses/:rid`
- `GET /quiver/api/v1/=/analyses/:rid/instructions`
- `GET /quiver/api/v1/=/analyses/:rid/versions`
- `GET /quiver/api/v1/=/analyses/:rid/versions/:version`
- `GET /quiver/api/v1/=/analyses/:rid/working-states/:stateId`
- `GET /quiver/api/v1/=/compute/cache/stats`
- `GET /quiver/api/v1/=/compute/timeseries/:hydrationToken`
- `GET /quiver/api/v1/=/dashboards/:rid`
- `GET /quiver/api/v1/=/folders/:folderRid/analyses`
- `GET /quiver/api/v1/=/registry/cards`
- `GET /quiver/api/v1/=/templates/:rid`
- `GET /quiver/api/v1/=/visual-functions/:rid`
- `GET /quiver/api/v1/=/visual-functions/:rid/inline`

### /api/v1/code-repositories
- `PATCH /api/v1/code-repositories/:rid`

### /api/v1/projects
- `PATCH /api/v1/projects//members/:userId`

### /quiver/api/v1
- `PATCH /quiver/api/v1/=/analyses/:rid`
- `PATCH /quiver/api/v1/=/dashboards/:rid`
- `PATCH /quiver/api/v1/=/visual-functions/:rid`

### /api/v1/actions
- `POST /api/v1/actions/:actionTypeApiName/applyBatch`
- `POST /api/v1/actions/:actionTypeApiName/validate`

### /api/v1/auth
- `POST /api/v1/auth/_test/login-bypass`
- `POST /api/v1/auth/_test/reset-mfa`
- `POST /api/v1/auth/_test/seed-passkey`
- `POST /api/v1/auth/check-access`
- `POST /api/v1/auth/enroll/passkey/options`
- `POST /api/v1/auth/enroll/passkey/verify`
- `POST /api/v1/auth/login`
- `POST /api/v1/auth/login/mfa`
- `POST /api/v1/auth/login/mfa/webauthn-options`
- `POST /api/v1/auth/logout`
- `POST /api/v1/auth/refresh`
- `POST /api/v1/auth/switch-scope`

### /api/v1/charts
- `POST /api/v1/charts/batch`

### /api/v1/code-repositories
- `POST /api/v1/code-repositories/`
- `POST /api/v1/code-repositories/:rid/branches`
- `POST /api/v1/code-repositories/:rid/branches/:branch/commits`
- `POST /api/v1/code-repositories/:rid/functions/invoke`
- `POST /api/v1/code-repositories/:rid/tags`

### /api/v1/datasets
- `POST /api/v1/datasets/:datasetId/duplicate`
- `POST /api/v1/datasets/:datasetId/reparse`
- `POST /api/v1/datasets/:datasetId/transactions`
- `POST /api/v1/datasets/upload`

### /api/v1/functions
- `POST /api/v1/functions/functions/:repositoryRid/versions`
- `POST /api/v1/functions/functions/:repositoryRid/versions/:semver/yank`

### /api/v1/funnel
- `POST /api/v1/funnel/clickhouse/link`
- `POST /api/v1/funnel/clickhouse/link-cdc`
- `POST /api/v1/funnel/clickhouse/refresh`
- `POST /api/v1/funnel/drain`
- `POST /api/v1/funnel/lakekeeper/bootstrap`
- `POST /api/v1/funnel/replacement/:objectType/approve-cutover`
- `POST /api/v1/funnel/replacement/:objectType/complete-backfill`
- `POST /api/v1/funnel/replacement/:objectType/rollback`
- `POST /api/v1/funnel/replacement/scheduler-tick`
- `POST /api/v1/funnel/replacement/start`
- `POST /api/v1/funnel/replacement/sweep`
- `POST /api/v1/funnel/signals`

### /api/v1/objects
- `POST /=/api/v1/objects/:objectType/searchAround`
- `POST /=/api/v1/objects/:objectType/searchFullText`
- `POST /=/api/v1/objects/:objectType/validateForeignKeys`
- `POST /api/v1/objects/batchView`

### /api/v1/ontology
- `POST /api/v1/ontology//groups/by-id/:groupId/members`
- `POST /api/v1/ontology//interfaces/:interfaceApiName/aggregate`
- `POST /api/v1/ontology//interfaces/:interfaceApiName/search`
- `POST /api/v1/ontology//linkTypes/:apiName/count`
- `POST /api/v1/ontology//linkTypes/:apiName/upload`
- `POST /api/v1/ontology//linkTypes/:apiName/validate`
- `POST /api/v1/ontology//linkTypes/:apiName/validateMigration`
- `POST /api/v1/ontology//linkTypes/bulkCount`
- `POST /api/v1/ontology//linkTypes/import`
- `POST /api/v1/ontology//linkTypes/multiHop`
- `POST /api/v1/ontology//objectTypeId/`
- `POST /api/v1/ontology/:ontologyId/objectTypeId/:objectTypeId`
- `POST /api/v1/ontology//objectTypes//edits/:editId/undo`
- `POST /api/v1/ontology//objectTypes//implements/`
- `POST /api/v1/ontology//objectTypes//index/`
- `POST /api/v1/ontology//objectTypes//suggestMapping/`
- `POST /api/v1/ontology//objectTypes/by-id//edits/:editId/undo`
- `POST /api/v1/ontology//objectTypes/import`
- `POST /api/v1/ontology//objectTypes/objects/batchView`
- `POST /api/v1/ontology//objectTypes/primaryKey`
- `POST /api/v1/ontology//objectTypes/properties`
- `POST /api/v1/ontology//objectTypes/properties/batch`
- `POST /api/v1/ontology//objectTypes/titleProperty`
- `POST /=/api/v1/ontology/import`

### /api/v1/projects
- `POST /api/v1/projects//folders/upload`
- `POST /api/v1/projects/upload`

### /api/v1/resources
- `POST /api/v1/resources/:rid/autosave-snapshots/:snapshotId/restore`
- `POST /api/v1/resources/:rid/permanently-delete`
- `POST /api/v1/resources/:rid/restore`

### /api/v1/scaffold
- `POST /api/v1/scaffold/`

### /api/v1/workshop
- `POST /api/v1/workshop/action-types`
- `POST /api/v1/workshop/actions/_apply`
- `POST /api/v1/workshop/actions/_validate`
- `POST /api/v1/workshop/modules`
- `POST /api/v1/workshop/modules/:rid/actions/rollback`
- `POST /api/v1/workshop/modules/:rid/versions:publish`
- `POST /api/v1/workshop/modules/_validate`
- `POST /api/v1/workshop/modules:bootstrap`
- `POST /api/v1/workshop/object-sets/_aggregate`
- `POST /api/v1/workshop/object-sets/_load`

### /api/v1/connectivity
- `POST /api/v1/connectivity/connections`
- `POST /api/v1/connectivity/connections/:rid/cdc/preflight`
- `POST /api/v1/connectivity/connections/:rid/cdc/streams`
- `POST /api/v1/connectivity/connections/:rid/credentials/issue`
- `POST /api/v1/connectivity/connections/:rid/imports`
- `POST /api/v1/connectivity/connections/:rid/secrets`
- `POST /api/v1/connectivity/connections/:rid/secrets/:name/rotate`
- `POST /api/v1/connectivity/connections/:rid/secrets/:name/rotate-managed`
- `POST /api/v1/connectivity/connections/:rid/test`
- `POST /api/v1/connectivity/connections/:rid/virtual-tables`
- `POST /api/v1/connectivity/connections/test-config`
- `POST /api/v1/connectivity/egress-policies`
- `POST /api/v1/connectivity/egress-policies/:eprid/decision`
- `POST /api/v1/connectivity/folders`
- `POST /api/v1/connectivity/imports/:importRid/execute`
- `POST /api/v1/connectivity/virtual-tables/:vrid/refreshSchema`

### /quiver/api/v1
- `POST /quiver/api/v1/=/_admin/purge-working-states`
- `POST /quiver/api/v1/=/aip/assist`
- `POST /quiver/api/v1/=/aip/configure`
- `POST /quiver/api/v1/=/aip/generate`
- `POST /quiver/api/v1/=/analyses`
- `POST /quiver/api/v1/=/analyses/:rid/_validate`
- `POST /quiver/api/v1/=/analyses/:rid/instructions`
- `POST /quiver/api/v1/=/analyses/:rid/versions`
- `POST /quiver/api/v1/=/analyses/:rid/versions/:version\:revert`
- `POST /quiver/api/v1/=/analyses/:rid/working-states`
- `POST /quiver/api/v1/=/compute/cards`
- `POST /quiver/api/v1/=/dashboards`
- `POST /quiver/api/v1/=/dashboards/:rid/embedInObjectView`
- `POST /quiver/api/v1/=/dashboards/:rid/embedInWorkshop`
- `POST /quiver/api/v1/=/templates`
- `POST /quiver/api/v1/=/visual-functions`

### /api/v1/code-repositories
- `PUT /api/v1/code-repositories/:rid/resource-imports`
- `PUT /api/v1/code-repositories/:rid/settings`

### /api/v1/datasets
- `PUT /api/v1/datasets/:datasetId`

### /api/v1/ontology
- `PUT /api/v1/ontology//interfaces/:interfaceApiName`
- `PUT /api/v1/ontology//objectTypes/properties/:propApiName`

### /api/v1/workshop
- `PUT /api/v1/workshop/modules/:rid`

### /api/v1/connectivity
- `PUT /api/v1/connectivity/connections/:rid`
- `PUT /api/v1/connectivity/connections/:rid/secrets/:name`
- `PUT /api/v1/connectivity/egress-policies/:eprid`
- `PUT /api/v1/connectivity/imports/:importRid`

### /quiver/api/v1
- `PUT /quiver/api/v1/=/analyses/:rid/working-states/:stateId`
