# Object Data Store Summary

**Mount:** `/api/v1/ontology/:ontologyId/objectTypes/:apiName/dataStore`

**Source:** `src/routes/objectDataStore.ts`

## Why this exists

Powers the "Default object data store" card next to the
`<WorkflowDiagram />` on the Datasources tab of the Object Type editor.
Collapses pipeline state (`funnel_state` via `getState`) and the
Quickwit replacement state (`object_type_active_index_version`) into
three UI-ready fields: a canonical index name, a last-written
timestamp, and a schema health enum.

---

## `GET /api/v1/ontology/:ontologyId/objectTypes/:apiName/dataStore`

### Path params

| Param | Type | Notes |
|---|---|---|
| `ontologyId` | UUID | Accepts `default` / `main` / `primary` aliases. |
| `apiName` | string | PascalCase Object Type api name. |

### Response — `200 OK`

```json
{
  "objectTypeApiName": "OlivierOrder8",
  "indexName": "ot_olivierorder8",
  "displayName": "Object Storage V2",
  "dataLastWrittenAt": "2026-04-17T10:23:45.000Z",
  "pipelineStatus": "idle",
  "schemaStatus": "up_to_date",
  "schemaDetail": null
}
```

### Field reference

| Field | Source | Meaning |
|---|---|---|
| `objectTypeApiName` | request | Echo of path param for client-side correlation. |
| `indexName` | `getIndexName(apiName)` from `indexLifecycleManager` | Canonical Quickwit/OpenSearch index identifier (usually `ot_<lowercase-api>`). |
| `displayName` | hardcoded | `"Object Storage V2"` — the FE's visible label. |
| `dataLastWrittenAt` | `funnel_state.last_indexed_at` | ISO timestamp of the most recent successful materialization, or `null` if never indexed. |
| `pipelineStatus` | `funnel_state.status` | `idle` / `indexing` / `stale` / `failed` / `not_indexed`. Defaults to `idle` when no `funnel_state` row exists. |
| `schemaStatus` | derived from `object_type_active_index_version.state` | `up_to_date` / `migrating` / `out_of_date`. See derivation below. |
| `schemaDetail` | full replacement row when one exists | `null` when the object type has never started an index replacement — steady-state types have no row in `object_type_active_index_version`, which is treated as `up_to_date`. |

### `schemaStatus` derivation

```
replacement_state        → schemaStatus
───────────────────────────────────────
(no row)                 → up_to_date     // steady state — never started a replacement
LIVE                     → up_to_date
CUTOVER_COMPLETE         → up_to_date
OLD_INDEX_DROPPED        → up_to_date
REPLACEMENT_BACKFILL     → migrating
REPLACEMENT_SOAK         → migrating
CUTOVER_PENDING          → migrating
ROLLED_BACK              → out_of_date
```

### `schemaDetail` shape (when present)

```json
{
  "activeVersion": 2,
  "pendingVersion": 3,
  "replacementState": "REPLACEMENT_SOAK",
  "updatedAt": "2026-04-17T10:23:45.000Z"
}
```

### Errors

| HTTP | Error code | When |
|---|---|---|
| `404` | `ONTOLOGY_NOT_FOUND` | Ontology row missing. |
| `404` | `OBJECT_TYPE_NOT_FOUND` | No `object_type` row for this `(ontology_id, api_name)`. |
| `500` | `INTERNAL_ERROR` | Database query failed. Message carries the underlying error text. |

### Example

```bash
curl -s \
  -H "Authorization: Bearer $TELLUS_TOKEN" \
  "http://localhost:3000/api/v1/ontology/default/objectTypes/OlivierOrder8/dataStore" | jq
```

## Frontend consumer

The Datasources tab renders three derived labels from this endpoint:

- **Data** freshness badge — relative time computed from
  `dataLastWrittenAt`.
- **Schema** tone — coloured badge driven by `schemaStatus`
  (`up_to_date`=green, `migrating`=amber, `out_of_date`=red).
- **Object Storage V2** row header — uses `indexName` /
  `displayName`.

Currently the FE reads these from `objectType.indexingState` and the
live funnel_run feed instead of hitting this endpoint directly; this
route exists as a lower-latency alternative for when the FE stops
fetching the full object-type detail on every render.
