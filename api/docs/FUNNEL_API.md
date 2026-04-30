# Object Data Funnel API

**Mount prefix:** `/api/v1/funnel`

**Source:** `src/routes/funnel.ts`

The Funnel is the async, durable pipeline that moves data from a
backing datasource into the live indexed store:

```
changelog → merge → indexing → hydration
```

Every Object Type gets one long-lived Temporal parent workflow.
Signals queue commits and schema changes; each drained signal runs
the four-stage chain once, writing one `funnel_run` row per signal.

Dev/demo can set `FUNNEL_STAGE_DELAY_MS=5000` to pace each stage at
5 s so the UI animation is perceivable — see
`src/services/funnel/stageDelay.ts`. The default is 0 (no overhead in
production).

---

## Endpoint summary (22)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/signals` | Enqueue a workflow signal (edit batch / source txn / schema change). |
| `POST` | `/drain` | Synchronously drain pending signals — test hook. |
| `GET`  | `/runs/objectTypeId/:objectTypeId` | Most recent runs + stages, keyed by Object Type UUID (preferred). |
| `GET`  | `/runs/:objectType` | Legacy — same payload, keyed by apiName. |
| `GET`  | `/snapshots` | Iceberg snapshots for a `(namespace, table)` pair. |
| `GET`  | `/instances/:objectType/:pk` | Read one SoR row from `object_instances`. |
| `GET`  | `/overlay/:objectType/:pk` | Inspect the writeback overlay cache entry. |
| `GET`  | `/slis` | Writeback overlay lag SLI snapshot. |
| `POST` | `/clickhouse/refresh` | Re-run ClickHouse link-table bootstrap. |
| `POST` | `/clickhouse/link` | Ensure a single link-type table (optionally with Kafka ingest topology). |
| `POST` | `/clickhouse/link-cdc` | Publish a link CDC event (test/integration). |
| `GET`  | `/clickhouse/cdc-lag` | Rolling CDC lag per link type (alert when lag > 30 s with rows). |
| `POST` | `/lakekeeper/bootstrap` | Create Iceberg warehouse + per-Object-Type namespaces. |
| `GET`  | `/lakekeeper/info` | Lakekeeper version / bootstrap state. |
| `GET`  | `/lakekeeper/warehouses` | List configured warehouses. |
| `POST` | `/replacement/start` | Begin a dual-index Quickwit cutover for an Object Type. |
| `POST` | `/replacement/:objectType/complete-backfill` | Transition to `REPLACEMENT_SOAK`. |
| `POST` | `/replacement/:objectType/approve-cutover` | Flip the live alias if the diff gate passed. |
| `POST` | `/replacement/:objectType/rollback` | Revert to previous version (must be within 48 h). |
| `POST` | `/replacement/scheduler-tick` | Fire one scheduler tick (runbook / e2e). |
| `GET`  | `/replacement/:objectType/preview-cutover` | Preview the cutover gate verdict without firing. |
| `POST` | `/replacement/sweep` | Drop old indexes whose grace window elapsed. |
| `GET`  | `/replacement/:objectType` | Inspect active/pending version + replacement state. |

---

## Signals

### `POST /api/v1/funnel/signals`

Durably enqueues a signal. If Temporal is connected the signal is
also delivered via `signalTemporalWorkflow` with best-effort
semantics — already-consumed signals are a no-op downstream
(`claimNextSignal` uses `FOR UPDATE SKIP LOCKED`).

**Request body:**

```json
{
  "ontologyId": "<uuid>",                          // optional — auto-resolved from apiName if omitted
  "objectTypeApiName": "OlivierOrder8",            // required
  "signalType": "editBatchPending",                // required — see enum
  "payload": { /* free-form */ }                   // optional
}
```

`signalType` enum (see `src/services/funnel/durableWorkflow.ts`):
- `"sourceTransactionCommitted"` — new data in the source table.
- `"editBatchPending"` — user edits queued from Actions writeback.
- `"schemaChanged"` — property add/rename/drop needing a pipeline re-run.

**Response — `202 Accepted`:**

```json
{ "signalId": "<uuid>", "temporal": true }
```

Errors: `400 BAD_REQUEST` (missing fields), `404 OBJECT_TYPE_NOT_FOUND`
(when `ontologyId` is omitted and the apiName doesn't resolve),
`500 INTERNAL` on DB failure.

### `POST /api/v1/funnel/drain`

Test hook — synchronously drains any pending signals matching the
optional `objectTypes` filter. Returns `{ runsStarted: N }`.

**Request body (optional):** `{ "objectTypes": ["Foo", "Bar"] }`

---

## Runs & state

### `GET /api/v1/funnel/runs/objectTypeId/:objectTypeId`

**Preferred route.** Resolves the UUID to an apiName and returns the
same payload as the legacy apiName-keyed route below. Query param
`?limit=N` clamped to 1–100 (default 20).

### `GET /api/v1/funnel/runs/:objectType`

Legacy apiName-keyed form. Returns:

```json
{
  "runs": [
    {
      "run_id": "<uuid>",
      "ontology_id": "<uuid>",
      "object_type_api_name": "OlivierOrder8",
      "workflow_type": "ObjectTypeFunnelWorkflow.temporal",
      "status": "completed",
      "current_stage": null,
      "objects_indexed": 3,
      "error_message": null,
      "started_at": "...",
      "completed_at": "..."
    }
  ],
  "stages": [
    {
      "stage_run_id": "<uuid>",
      "run_id": "<uuid>",
      "stage": "changelog",
      "status": "succeeded",
      "attempt": 1,
      "input_json": {},
      "output_json": {},
      "error_message": null,
      "started_at": "...",
      "finished_at": "..."
    }
  ]
}
```

**`temporal_handoff` rows are excluded** — those are bookkeeping rows
with `status=completed` / `stages=[]` from the moment they're created;
including them would make the UI flash every node green on signal
dispatch. Only real workflow runs are returned.

### `GET /api/v1/funnel/snapshots?namespace=<ns>&table=<name>`

Returns the Iceberg snapshot chain for a table. Required query params:
`namespace`, `table`. Response:

```json
{
  "snapshots": [
    {
      "snapshot_id": "<uuid>",
      "parent_snapshot_id": "<uuid> | null",
      "operation": "append",
      "summary_json": { /* ... */ },
      "added_rows": 3,
      "added_files": 1,
      "committed_at": "..."
    }
  ]
}
```

### `GET /api/v1/funnel/instances/:objectType/:pk?ontologyId=<uuid>`

One row from the System-of-Record table `object_instances`. Required
query param: `ontologyId`. Returns the raw row or `404 NOT_FOUND`.

### `GET /api/v1/funnel/overlay/:objectType/:pk`

Reads the writeback overlay cache entry at `overlayKey(<ot>, <pk>)`.
Returns the cache value or `404 NOT_FOUND` on miss.

### `GET /api/v1/funnel/slis`

Overlay SLO snapshot (see `src/services/overlay/slis.ts`). No
parameters. Useful for ops dashboards.

---

## ClickHouse link topology

### `POST /api/v1/funnel/clickhouse/refresh`

Rebuild every link-type's ClickHouse table from scratch. No body.
Returns the result of `ensureLinkTablesForAllLinkTypes()`.

### `POST /api/v1/funnel/clickhouse/link`

**Request body:**

```json
{
  "sourceObjectType": "Foo",
  "linkName": "hasBar",
  "targetObjectType": "Bar",
  "withKafkaIngest": true,   // optional, default true when KAFKA_BROKERS is set
  "rebuild": false            // optional
}
```

Tries to create the Kafka→ClickHouse ingest topology when possible,
falls back to a bare table on DDL failure. Returns:

```json
{ "table": "link_foo_hasBar_bar", "kafkaIngest": true, "rebuilt": false }
```

### `POST /api/v1/funnel/clickhouse/link-cdc`

Publish a single link CDC event. Used by tests and backfill jobs; in
production the Actions writeback path is the primary producer.

**Request body:**

```json
{
  "sourceObjectType": "Foo",
  "linkName": "hasBar",
  "sourcePk": "1",
  "targetPk": "2",
  "linkProps": { /* optional */ },
  "markings": []
}
```

Returns `{ "published": true, "topic": "link_cdc.<table>" }`.

### `GET /api/v1/funnel/clickhouse/cdc-lag`

Rolling CDC lag per link type. Alerts when any entry has
`alerting=true` (> 30 s lag with rows present). Returns:

```json
{
  "alerting": false,
  "readings": [
    {
      "linkName": "hasBar",
      "sourceObjectType": "Foo",
      "targetObjectType": "Bar",
      "lagSeconds": 1.4,
      "alerting": false
    }
  ]
}
```

---

## Lakekeeper (Iceberg catalog)

### `POST /api/v1/funnel/lakekeeper/bootstrap`

Idempotent. Creates the warehouse on MinIO and one namespace per
Object Type in the catalog.

### `GET /api/v1/funnel/lakekeeper/info`

Returns `{ reachable: true, ...catalogInfo }` or `503 { reachable: false }`
if Lakekeeper is down.

### `GET /api/v1/funnel/lakekeeper/warehouses`

`{ warehouses: [...] }` — the configured warehouse list.

---

## Quickwit index replacement

Dual-index cutover pipeline for evolving an Object Type's index
schema without downtime.

### State machine

```
LIVE
  │ POST /replacement/start
  ▼
REPLACEMENT_BACKFILL ──→ (backfill activity streams into pending index)
  │ POST /replacement/:ot/complete-backfill
  ▼
REPLACEMENT_SOAK ──→ (diff rate observed against live)
  │ POST /replacement/:ot/approve-cutover   (only if diff gate passes)
  ▼
CUTOVER_COMPLETE ──→ (alias flipped; old index retained 48 h)
  │ POST /replacement/sweep
  ▼
OLD_INDEX_DROPPED

Rollback path: POST /replacement/:ot/rollback (any state within 48 h) → ROLLED_BACK
```

### `POST /api/v1/funnel/replacement/start`

**Request body:**

```json
{
  "objectTypeApiName": "OlivierOrder8",
  "primaryKeyApiName": "orderId",
  "previousProperties": [ /* PropertyDef[] */ ],
  "nextProperties": [ /* PropertyDef[] */ ],
  "soakDays": 7,                                     // optional
  "volumeTrigger": {                                 // optional
    "rowsChanged": 10000,
    "totalRows": 100000
  },
  "force": false                                     // optional — bypass volumeTrigger thresholds
}
```

Returns `201` if a replacement was triggered, `200` if not (e.g. diff
below threshold and `force=false`). Body is the
`startReplacement` result.

Required fields: `objectTypeApiName`, `primaryKeyApiName`,
`previousProperties[]`, `nextProperties[]`.

### `POST /api/v1/funnel/replacement/:objectType/complete-backfill`

Transitions to `REPLACEMENT_SOAK`. No body. Returns
`{ objectType, state: "REPLACEMENT_SOAK" }`.

### `POST /api/v1/funnel/replacement/:objectType/approve-cutover`

Gate check + alias flip. Body-less. On pass, returns
`approveCutover`'s structured verdict (target version, new alias,
diff summary).

### `POST /api/v1/funnel/replacement/:objectType/rollback`

Revert to the previous version. Must be within the 48 h retention
window. Returns `{ objectType, state: "ROLLED_BACK" }`.

### `POST /api/v1/funnel/replacement/scheduler-tick`

Manually fire one scheduler iteration. No body. Used by the e2e
script and the on-call runbook when bypassing the 1-minute interval
is needed.

### `GET /api/v1/funnel/replacement/:objectType/preview-cutover`

Same verdict `approve-cutover` would produce, without firing. Used
by the FE to display "cutover ready / not ready" in the UI.

### `POST /api/v1/funnel/replacement/sweep`

Drop indexes whose 48 h grace window has elapsed. Returns
`{ dropped: [<indexName>, ...] }`.

### `GET /api/v1/funnel/replacement/:objectType`

Single-row inspection of `object_type_active_index_version`:

```json
{
  "object_type_api_name": "OlivierOrder8",
  "active_version": 2,
  "pending_version": 3,
  "state": "REPLACEMENT_SOAK",
  "soak_days": 7,
  "diff_rate_threshold": 0.01,
  "backfill_started_at": "...",
  "soak_started_at": "...",
  "last_cutover_at": "...",
  "last_rollback_at": null,
  "old_index_retained_until": "...",
  "updated_at": "..."
}
```

Returns `404 NOT_FOUND` when the Object Type has no replacement row.

---

## Error envelope

All handlers return errors as a flat JSON object:

```json
{ "error": "<CODE>", "message": "<human-readable>" }
```

Common codes: `BAD_REQUEST`, `OBJECT_TYPE_NOT_FOUND`, `NOT_FOUND`,
`INTERNAL`. HTTP status mirrors the code (`400`/`404`/`500`).

## Verification

- `scripts/verify-funnel-stage-delay.sh` — backend per-stage pacing
  (with delay=5000) + prod baseline (delay=0).
- `scripts/verify-funnel-reset.sh` — repeat-save creates a distinct
  `funnel_run` row starting from `changelog`.
- `scripts/verify-stage-pacing-e2e.sh` — orchestrator binding the
  above bash tests + the Cypress DOM-level gap test.
