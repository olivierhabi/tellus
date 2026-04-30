# Save-to-Ontology Commit + Reindex by Object Type UUID

**Mount prefix:** `/api/v1/ontology/:ontologyId/objectTypeId/:objectTypeId`

**Source:** `src/routes/reindexById.ts`, `src/routes/reindex.ts`,
`src/server.ts` (mount)

## Why this exists

The frontend navigates to the object-type editor via a **UUID**
(`/ontology/<objectTypeId>/overview`) — stable across apiName renames —
but the legacy reindex routes are keyed on `apiName`. This family of
endpoints exposes the same commit/status/history contract under the
UUID so the browser URL and the API URL share one stable identifier.

**Legacy apiName routes stay live** at
`/api/v1/ontology/:ontologyId/objectTypes/:apiName/reindex` — nothing
is removed, this is purely additive.

## How the resolver works

A middleware at the mount point resolves the `objectTypeId` UUID to
its `apiName` and stores it on `res.locals.apiName` (NOT
`req.params.apiName` — Express re-creates `req.params` at every
layer-dispatch boundary, wiping middleware mutations). The downstream
`reindexRouter` handlers read `req.params.apiName ?? res.locals.apiName`.

```
POST /api/v1/ontology/:ontologyId/objectTypeId/:objectTypeId
      │
      ├── resolveObjectTypeIdToApiName  (writes res.locals.apiName)
      └── saveToOntology                (emits editBatchPending signal)
```

---

## `POST /api/v1/ontology/:ontologyId/objectTypeId/:objectTypeId`

Commit-to-ontology: emit the async funnel signal that drives the
indexing pipeline (changelog → merge → indexing → hydration).

**Handler:** `saveToOntology` in `src/routes/reindexById.ts`.

### Request

No body required. Path params:

| Param | Type | Notes |
|---|---|---|
| `ontologyId` | UUID | Accepts `default` / `main` / `primary` aliases (resolved to the canonical ontology via `resolveOntologyAlias` middleware). |
| `objectTypeId` | UUID | Must match a row in `object_type`. |

### Response — `202 Accepted`

```json
{
  "status": "accepted",
  "signalId": "d924eb90-ed52-44dc-8db0-9aacff8306dc",
  "temporal": true,
  "ontologyId": "8203442a-7da4-46b9-9752-f420b93e9e25",
  "objectTypeApiName": "OlivierOrder8"
}
```

| Field | Meaning |
|---|---|
| `status` | Always `"accepted"` on the 202 path. |
| `signalId` | UUID of the row written to `funnel_signal`. Durable — survives Temporal restarts. |
| `temporal` | `true` when `signalTemporalWorkflow` succeeded; `false` means the PG dispatcher will pick the signal up on its next poll. Both paths use the same durable queue, so neither is a data-loss condition. |
| `objectTypeApiName` | Echo of the resolved apiName — proof the resolver ran. |

### Semantics

- **Idempotent from the client's perspective.** Repeat POSTs produce
  distinct `signalId` values but the dispatcher's `claimNextSignal`
  uses `FOR UPDATE SKIP LOCKED` so only one `funnel_run` row is
  created per signal. Two fast clicks can create two runs; that's
  intentional (each save is a distinct intent).
- **Each save starts a fresh `funnel_run`.** The Temporal workflow
  keys run rows on `temporal_workflow_id:<signalId>`, so the second
  save does NOT merge into the first run's row. Verified by
  `scripts/verify-funnel-reset.sh`.
- **No server-side reindex synchronously.** This endpoint returns
  before the pipeline completes. Poll `/status` (below) to watch
  progress, or `/api/v1/funnel/runs/objectTypeId/:id` for
  fine-grained per-stage observability.

### Errors

| HTTP | Error code | When |
|---|---|---|
| `400` | `INVALID_PARAMETER` | Missing `ontologyId` or `objectTypeId`. |
| `404` | `OBJECT_TYPE_NOT_FOUND` | No `object_type` row matches `(ontology_id, object_type_id)`. |
| `500` | `INTERNAL_ERROR` | `sendSignal` failed (Postgres unreachable). |

### Example

```bash
curl -X POST \
  -H "Authorization: Bearer $TELLUS_TOKEN" \
  "http://localhost:3000/api/v1/ontology/default/objectTypeId/da7a549a-bd23-47dc-aaa4-e2b61db10faf"
```

---

## `GET /api/v1/ontology/:ontologyId/objectTypeId/:objectTypeId/status`

Current pipeline status. Delegated to `reindex.ts`'s existing
`GET /status` handler — the resolver middleware writes
`res.locals.apiName` so the handler reads the correct object type
without caring that the mount uses UUID.

### Response — `200 OK`

```json
{
  "objectType": "OlivierOrder8",
  "funnelState": {
    "status": "idle",
    "objectsIndexed": 3,
    "lastIndexedAt": "2026-04-17T10:23:45.000Z",
    "lastIndexDurationMs": 1479,
    "errorMessage": null,
    "indexName": "ot_olivierorder8"
  },
  "pipelineState": {
    "status": "idle",
    "currentStage": null,
    "stageStartedAt": null,
    "objectsIndexed": 3,
    "lastIndexedAt": "2026-04-17T10:23:45.000Z",
    "durationMs": 1479,
    "errorMessage": null,
    "retryCount": 0
  },
  "lastReindex": { "reindexId": "...", "status": "completed", ... } | null,
  "pendingEdits": 0,
  "datasource": {
    "registered": true,
    "datasetId": "...",
    "filePath": "...",
    "primaryKeyColumn": "order_id",
    "transactionCount": 1
  }
}
```

### Errors

| HTTP | Error code | When |
|---|---|---|
| `404` | `ONTOLOGY_NOT_FOUND` | Ontology row missing. |
| `404` | `OBJECT_TYPE_NOT_FOUND` | Resolver couldn't map UUID → apiName. |

---

## `GET /api/v1/ontology/:ontologyId/objectTypeId/:objectTypeId/history`

Paginated reindex history. Same shape as the legacy apiName-keyed
`/history` route — see `src/routes/reindex.ts` for the full response
shape. Supports `?pageSize=N&pageToken=<cursor>`.

---

## Related existing routes (back-compat, unchanged)

The same commit/status/history surface is still available under the
legacy apiName mount:

| Method | Path |
|---|---|
| `POST` | `/api/v1/ontology/:ontologyId/objectTypes/:apiName/reindex` |
| `GET` | `/api/v1/ontology/:ontologyId/objectTypes/:apiName/reindex/status` |
| `GET` | `/api/v1/ontology/:ontologyId/objectTypes/:apiName/reindex/history` |

Both routes exist as separate mounts; the UUID form is **preferred**
for new FE integrations because it survives apiName renames.

## Observability

The `saveToOntology` handler emits a structured log line per commit:

```json
{
  "level": "info",
  "type": "app_log",
  "requestId": "<uuid>",
  "message": "save_to_ontology_accepted",
  "data": {
    "ontologyId": "...",
    "objectTypeApiName": "...",
    "signalId": "...",
    "temporal": true
  },
  "timestamp": "..."
}
```

Tie to the ingress request by `requestId` (also sent on the response's
`X-Request-Id` header).

## Verification

- `scripts/verify-save-to-ontology.sh` — 9 assertions covering happy
  path, error paths, idempotency, funnel pickup, legacy back-compat.
- `scripts/verify-funnel-reset.sh` — repeat-click behaviour; two saves
  must produce two distinct `funnel_run` rows, both starting from
  `changelog`.
- `cypress/e2e/save-to-ontology-commit.cy.ts` — browser end-to-end via
  the editor's Save button.
