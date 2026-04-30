# Object Data Funnel — Implementation Documentation

> Status: Implemented (B1–B10). Dual-running with legacy Elasticsearch path.
> Last updated: 2026-04-20.

The **Object Data Funnel** is the backend pipeline that materializes the system of record (SoR) for every Ontology Object Type instance. It replaces the legacy "compute → Elasticsearch writer" model with a **stage-by-stage, materialized, append-only** pipeline whose output at each stage is a durable Iceberg dataset that the next stage reads independently.

This document is the canonical reference for engineers working on, integrating with, or debugging the funnel.

---

## 1. Mental Model & Goals

Per the design specification (`tasks/Funnel-pipeline/tasks-01.md`), the funnel is **not** a streaming compute job — it is a pipeline that *produces datasets*. Every stage:

- Reads from the previous stage's materialized dataset (or external source).
- Writes a new Iceberg snapshot.
- Is **independently resumable, debuggable, and swappable** from its neighbours.

Hard isolation rule: **one Object Type → one Temporal workflow → one merged dataset → one Quickwit index**. There is no cross-Object-Type sharing of pipelines. This scales linearly to hundreds of Object Types and prevents one bad type from poisoning others.

The four stages, in order:

| # | Stage | Input | Output | Activity File |
|---|-------|-------|--------|---------------|
| B4 | **Changelog** | Iceberg snapshot diff per datasource | `_funnel.<ot>.changelog.<ds_id>` Iceberg table | `services/funnel/changelogStage.ts` |
| B5 | **Merge** | All datasource changelogs + pending `object_edits` | Merged Iceberg snapshot + UPSERT into `object_instances` | `services/funnel/mergeStage.ts` |
| B6 | **Indexing** | Merged dataset rows | Quickwit splits via Kafka | `services/quickwit/indexingActivity.ts` |
| B8 | **Hydration** | Newly published splits | Warmed split caches on searchers | `services/quickwit/hydrationActivity.ts` |

Two cross-cutting subsystems wrap the pipeline:

- **B7 — Writeback Overlay** — Redis cache that gives sub-1-second visibility for Action edits while waiting for B6 to publish.
- **B9 — Replacement Pipeline** — dual-index/shadow-diff/cutover state machine for schema changes that cannot be done in place.
- **B10 — Search Around** — graph traversal split between Quickwit `search_stream` (≤100k hops) and ClickHouse materialized views (large traversals).

---

## 2. File Map

### Control plane / API
- `src/routes/funnel.ts` (649 lines) — all HTTP endpoints under `/api/v1/funnel`.

### Workflow orchestration
- `src/services/funnel/temporal/workflows.ts` — `ObjectTypeFunnelWorkflow()` parent loop (waits on signals → drains → runs the 4-stage chain).
- `src/services/funnel/temporal/activities.ts` — activity wrappers around the four stages plus Postgres state projection.
- `src/services/funnel/temporal/worker.ts` — `startTemporalWorker()` bootstrap.
- `src/services/funnel/funnelDispatcher.ts` — Postgres-backed fallback executor when Temporal is unavailable (polls `funnel_signal` with `FOR UPDATE SKIP LOCKED`).

### Stage implementations
- `src/services/funnel/changelogStage.ts` — `computeChangelog()` over a `SnapshotDiffReader` abstraction.
- `src/services/funnel/mergeStage.ts` — `mergeChanges()` with `user_edit_wins` (default) and `latest_wins` strategies; column-wise MDO enforced.
- `src/services/funnel/duckdbIceberg.ts` — opt-in DuckDB-backed implementations of B4 and B5 (`iceberg_scan(..., snapshot_id_from=..., snapshot_id_to=...)`).
- `src/services/funnel/icebergCatalog.ts` — thin Iceberg metadata layer (`createTable`, `commitSnapshot`, `readSnapshot`).
- `src/services/funnel/lakekeeperClient.ts`, `lakekeeperBootstrap.ts` — REST client to Apache Lakekeeper (production catalog target).
- `src/services/quickwit/indexingActivity.ts`, `indexManager.ts`, `client.ts`, `docMapping.ts` — B6.
- `src/services/quickwit/hydrationActivity.ts` — B8 cache warming via rendezvous-hashed split assignment.

### Replacement pipeline (B9)
- `src/services/quickwit/replacement/orchestrator.ts`
- `src/services/quickwit/replacement/versionManager.ts`
- `src/services/quickwit/replacement/schemaChangeDetector.ts`
- `src/services/quickwit/replacement/shadowDiff.ts`
- `src/services/quickwit/replacement/soakMonitor.ts`

### Writeback overlay (B7)
- `src/services/overlay/writebackOverlay.ts` — `writeOverlayForEdit()` called from Action transaction.
- `src/services/overlay/overlayStore.ts` — Redis client wrapper.
- `src/services/overlay/sweeper.ts` — purges overlay keys after B6 publish confirmed.
- `src/services/overlay/slis.ts` — ring-buffer SLI tracker for overlay→index lag.

### Search Around (B10)
- `src/services/searchAround/clickhouseClient.ts`
- `src/services/searchAround/quickwitTraversal.ts`
- `src/services/searchAround/linkMaterializedView.ts`
- `src/services/searchAround/cdcLinkProducer.ts`

### System of record
- `src/models/objectInstance.ts` — `object_instances` table model (`bulkUpsertInstances`, etc.).
- `src/models/ontologyEdit.ts` — `object_edits` append-only model.
- `src/actions/editApplicator.ts` — Action writeback that produces the edits and the overlay row in the same Postgres transaction.

### Migrations (schema)
- `src/migrations/012_funnel_object_edits.sql` — SoR tables.
- `src/migrations/013_replacement_pipeline.sql` — replacement state machine.
- `src/migrations/014_funnel_workflow_state.sql` — workflow run tracking.

### Observability
- `src/services/funnel/metrics.ts` — Prometheus counters/histograms.

---

## 3. Database Schema

### 3.1 System of record (migration 012)

**`object_instances`** — current merged state, one row per object.

| Column | Notes |
|--------|-------|
| `(ontology_id, object_type_api_name, primary_key)` | Composite PK |
| `properties JSONB` | Merged from all datasources + applied edits |
| `markings TEXT[]` | Union of source markings |
| `source_datasource_id`, `source_transaction_id` | Lineage |
| `version BIGINT` | Bumped on every write (B1 durability check) |

Indexes: `idx_object_instances_ot`, `idx_object_instances_modified`. Populated **only** by the Merge stage — never by Actions directly.

**`object_edits`** — append-only edit log.

| Column | Notes |
|--------|-------|
| `edit_id UUID PK` | One row per property changed |
| `ontology_id, object_type_api_name, primary_key, property_api_name, new_value JSONB` | The edit |
| `edit_strategy ENUM` | `user_edit_wins` (default) \| `latest_wins` |
| `actor_user_id, created_at` | Audit |
| `applied_to_merged_at` | Set by Merge stage when consumed |
| `applied_to_index_at` | Set by Indexing stage when published |

Partial indexes on `applied_to_merged_at IS NULL` and `applied_to_index_at IS NULL` make pending-work scans cheap. Rows are **never** UPDATEd except for those two timestamps.

### 3.2 Workflow state (migration 014)

- **`funnel_run`** — one per drained signal batch. Tracks `status`, `current_stage`, `objects_indexed`, `error_message`, timestamps.
- **`funnel_stage_run`** — one per activity execution. `UNIQUE(run_id, stage, attempt)` allows retry observability.
- **`funnel_signal`** — input queue. `signal_type ∈ {sourceTransactionCommitted, editBatchPending, schemaChanged}`. `idx_funnel_signal_pending WHERE consumed_at IS NULL`.
- **`funnel_changelog_watermark`** — per `(ontology_id, object_type, datasource)` snapshot pointers (`last_from_snapshot_id`, `last_to_snapshot_id`).

### 3.3 Replacement pipeline (migration 013)

- **`object_type_active_index_version`** — `state` enum with values `LIVE → REPLACEMENT_BACKFILL → REPLACEMENT_SOAK → CUTOVER_PENDING → CUTOVER_COMPLETE → OLD_INDEX_DROPPED` (or `ROLLED_BACK`). Holds `active_version`, `pending_version`, `soak_days` (default 7, max 14), `diff_rate_threshold` (default 0.001), `old_index_retained_until` (48h grace).
- **`replacement_diff_log`** — shadow-diff samples used by the soak gate.

---

## 4. HTTP API Surface

All paths prefixed with `/api/v1/funnel`. Defined in `src/routes/funnel.ts`.

### Pipeline control
| Method | Path | Purpose |
|--------|------|---------|
| POST | `/signals` | Enqueue a signal (`sourceTransactionCommitted` \| `editBatchPending` \| `schemaChanged`). Returns `{signalId, temporal: bool}`. |
| POST | `/drain` | Force-drain pending signals for given object types. |
| GET | `/runs/objectTypeId/:id` | List recent runs and stage executions. |
| GET | `/runs/:objectType` | Legacy lookup by API name. |
| GET | `/snapshots` | Inspect Iceberg snapshots for a `_funnel.*` table. |
| GET | `/instances/:objectType/:pk` | Read merged SoR row. |

### Overlay (B7)
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/overlay/:objectType/:pk` | Inspect Redis overlay value. |
| GET | `/slis` | JSON SLI snapshot. |
| GET | `/slis/metrics` | Prometheus exposition. |
| GET | `/metrics` | Unified Prometheus (funnel + overlay). |

### Lakekeeper
| Method | Path | Purpose |
|--------|------|---------|
| POST | `/lakekeeper/bootstrap` | Provision warehouse + namespaces. |
| GET | `/lakekeeper/info`, `/lakekeeper/warehouses` | Diagnostics. |

### Replacement (B9)
| Method | Path | Purpose |
|--------|------|---------|
| POST | `/replacement/start` | Begin backfill into pending version. |
| POST | `/replacement/:objectType/complete-backfill` | Transition to soak. |
| POST | `/replacement/:objectType/approve-cutover` | Flip alias to new version. |
| POST | `/replacement/:objectType/rollback` | Abort and return to `LIVE`. |
| GET | `/replacement/:objectType/preview-cutover` | Diff-rate gate verdict. |
| POST | `/replacement/sweep` | Drop old indices past grace window. |
| POST | `/replacement/scheduler-tick` | Manual scheduler tick (testing). |
| GET | `/replacement/:objectType` | Inspect state row. |

### Search Around (B10)
| Method | Path | Purpose |
|--------|------|---------|
| POST | `/clickhouse/refresh`, `/clickhouse/link` | Provision ClickHouse link tables. |
| POST | `/clickhouse/link-cdc` | Publish a link CDC event. |
| GET | `/clickhouse/cdc-lag` | Per-link lag readings + alerting flag. |

---

## 5. Lifecycle Walk-Through

### 5.1 Source-driven path (datasource snapshot lands)

1. External system commits an Iceberg snapshot to a datasource table.
2. Producer calls `POST /api/v1/funnel/signals` with `signalType=sourceTransactionCommitted` → row inserted in `funnel_signal`.
3. If Temporal is connected the live `ObjectTypeFunnelWorkflow` is signalled; otherwise `funnelDispatcher` picks it up at next 2 s poll.
4. The workflow drains all pending signals as one batch, then sequentially runs:
   - **Changelog** (timeout 1 h, 5 attempts) — diff `last_to_snapshot_id` → new snapshot, append to `_funnel.<ot>.changelog.<ds_id>`, advance watermark.
   - **Merge** (2 h, 5 attempts) — join all per-datasource changelogs with `pendingEdits`, apply column-wise MDO, write merged Iceberg snapshot, UPSERT `object_instances`, stamp `object_edits.applied_to_merged_at`.
   - **Indexing** (4 h, 3 attempts) — stream merged rows as NDJSON into Kafka topic `merged.<ot>`; wait until Quickwit metastore reports splits past offset; stamp `object_edits.applied_to_index_at`.
   - **Hydration** (30 m, 10 attempts) — prefetch new splits to rendezvous-hashed searcher caches.
5. Each stage projects its result into `funnel_run` / `funnel_stage_run` for observability.

### 5.2 Edit-driven path (Action writeback)

1. Action executor compiles rules → `CompiledEdit[]`.
2. `applyEdits()` (`src/actions/editApplicator.ts`) opens one Postgres transaction:
   - INSERT one `object_edits` row per property change.
   - When `ontologyId` is present (B1-ready Object Type), call `writeOverlayForEdit()`:
     - UPSERT `object_instances` row to reflect new state.
     - Write Redis key `overlay:<ot>:<pk>` with full doc, TTL ≈ `QUICKWIT_COMMIT_TIMEOUT_SECS * 3` (180 s default).
     - Record overlay-write timestamp in the SLI ring buffer.
3. On read (`Query API → src/services/query/objects.ts`) `mergeWithOverlay()` MGETs overlay keys for Quickwit hits and SCANs overlay keys matching the WHERE filter to inject not-yet-indexed rows.
4. Post-publish `sweeper.ts` deletes overlay keys whose `applied_to_index_at` is greater than the overlay write timestamp.

The overlay is mandatory because Quickwit's delete-by-query is hours-to-days latency; it cannot meet the <1 s edit-visibility SLO on its own.

### 5.3 Schema-change path (B9)

Triggered by `signalType=schemaChanged` or by `>80%` of rows changing in one transaction.

```
LIVE
 └─► REPLACEMENT_BACKFILL    (create ot_<type>__v<N+1>, full backfill from merged dataset)
      └─► REPLACEMENT_SOAK   (dual-write + shadow-query both indices)
           └─► CUTOVER_PENDING  (diff_rate < threshold for soak_days)
                └─► CUTOVER_COMPLETE (alias flip; old index retained 48 h)
                     └─► OLD_INDEX_DROPPED
```

Diff rate is computed from `replacement_diff_log` as `Σ diff_count / Σ total_hits` across the soak window. Default gate is 0.1%; configurable per Object Type. Rollback path returns to `LIVE` and drops the pending index.

---

## 6. Cross-Feature Relationships

| Subsystem | Direction | Touchpoint |
|-----------|-----------|------------|
| **Ontology models** (`models/objectType.ts`, `models/property.ts`, `models/linkType.ts`) | Consumed | Index doc-mapping derived from properties. |
| **Actions** (`actions/editApplicator.ts`) | Produces signals | Inserts `object_edits` and overlay row in the writeback txn. |
| **Query API** (`services/query/objects.ts`) | Consumes | `mergeWithOverlay()` injects overlay before returning Quickwit hits. |
| **Datasources** (`services/datasources/*`) | Source | Iceberg tables read by Changelog stage. |
| **Iceberg / Lakekeeper** | Storage | All stage outputs are Iceberg snapshots; Lakekeeper is the production REST catalog. |
| **Temporal** | Orchestration | Optional. Falls back to Postgres dispatcher. |
| **Postgres** | SoR + workflow state | Migrations 012/013/014. |
| **Redis** | Overlay cache | `overlay:*` keys with short TTL. |
| **Kafka** | Transport | `merged.<ot>` (B6) and `link_cdc.<src>__<link>__<tgt>` (B10). |
| **Quickwit** | Search index | One index per Object Type; replacement pipeline manages versions. |
| **ClickHouse** | Large traversals | Link materialized views fed by CDC. |
| **DuckDB** | Optional compute | Drop-in for Changelog/Merge above ~100 M rows. |
| **WebSocket** (`websocket/`) | Out | Run/stage status updates can be forwarded for live UI. |
| **Auth/middleware** | Guard | All `/api/v1/funnel` routes use the standard auth + tenant middleware chain. |

---

## 7. Notable Design Decisions & Gotchas

1. **Per-Object-Type isolation is non-negotiable.** Sharing a workflow across types compounds failure blast radius; the spec (`tasks-01.md` B3) requires 1:1.
2. **Dual-running with Elasticsearch.** Until shadow-diff stays under 0.1% for the full soak per Object Type, the legacy ES path remains the source of truth for queries. Do not delete it.
3. **Append-only edits** with two timestamp columns are the entire coordination protocol between Merge and Indexing — keep it that way.
4. **Temporal determinism rules** apply inside `workflows.ts`: no `Math.random`, no `Date.now`, no network calls. Use the patched `sleep()`. A monotonic counter is used as a fallback when a signal lacks `signalId` (`workflows.ts:106`).
5. **DuckDB is opt-in, not required.** The pure-TypeScript merge path in `mergeStage.ts` is the fallback and must remain functional and tested.
6. **Throughput cap:** 2 MB/s per Object Type on streaming sources is enforced inside the Changelog activity (`ThroughputGuard`), matching Palantir semantics — not at the Kafka consumer.
7. **Column-wise MDO is validated at config load.** Two datasources cannot own the same property; misconfigurations are rejected up front rather than silently winner-picked at merge time.
8. **Lakekeeper, not the JVM Iceberg runtime.** The `icebergCatalog.ts` wrapper is intentionally thin; the Lakekeeper REST adapter is the production target.
9. **Overlay sweeper races with sweeper.** The sweeper compares `applied_to_index_at > overlay_created_at` to avoid deleting an overlay that covers an even newer edit not yet indexed.
10. **Quickwit delete cadence is slow.** The overlay is not a performance optimization — it is a correctness requirement for delete visibility.

---

## 8. Open Items / Follow-ups

- `ObjectTypeFunnelWorkflow` does not yet call `continueAsNew()`. With more than ~100 active Object Types in production, event history will grow unbounded. Tracked in `workflows.ts:91`.
- Iceberg **partition evolution** in DuckDB is incomplete (`tasks-02.md` B2). For partition changes today, fall back to PyIceberg sidecar.
- Merge above ~5 B rows exceeds DuckDB single-node practicality; the architecture leaves room for RisingWave or Spark, but no implementation yet (`tasks-02.md` B5).

---

## 9. Observability Cheat-Sheet

| Metric | Endpoint | Alert / Notes |
|--------|----------|---------------|
| `funnel_stage_duration_seconds{stage,object_type}` | `/api/v1/funnel/metrics` | Per-stage histograms. |
| `funnel_stage_errors_total{stage,object_type}` | same | Counter. |
| `overlay_to_index_lag_p99` | `/api/v1/funnel/slis/metrics` | Page if > 60 s (B7). |
| `cdc_lag_seconds{link_name,object_type}` | `/api/v1/funnel/clickhouse/cdc-lag` | Alert > 30 s (B10). |
| `funnel_orphan_runs_swept_total` | `/api/v1/funnel/metrics` | Stalled-run cleanup. |
| `funnel_iceberg_metadata_emission_failures_total` | same | Snapshot commit retries. |

---

## 10. Quick Index of Key Symbols

- `ObjectTypeFunnelWorkflow` — `src/services/funnel/temporal/workflows.ts:95`
- `runChangelogActivity` / `runMergeActivity` / `runIndexingActivityProxy` / `runHydrationActivityProxy` — `src/services/funnel/temporal/activities.ts`
- `startFunnelDispatcher` / `drainPendingSignals` — `src/services/funnel/funnelDispatcher.ts:68`
- `computeChangelog` — `src/services/funnel/changelogStage.ts`
- `mergeChanges` — `src/services/funnel/mergeStage.ts`
- `bulkUpsertInstances` — `src/models/objectInstance.ts:94`
- `applyEdits` — `src/actions/editApplicator.ts:27`
- `writeOverlayForEdit` — `src/services/overlay/writebackOverlay.ts:75`
- `mergeWithOverlay` — `src/services/query/objects.ts:56`
- Replacement orchestrator — `src/services/quickwit/replacement/orchestrator.ts`
- Funnel routes — `src/routes/funnel.ts`
