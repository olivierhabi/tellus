# Tellus — 40-Task Production-Grade Specification (v2, Funnel-aligned)

**Pipeline Builder + Link Types — 1:1 Palantir Foundry 2026 (OSv2 / MMDP) replication**
**Plus: Funnel Hardening tasks (FNL-H1–H6) for production scale**

*Author voice: 20-year senior, Silicon Valley, Palantir-internal-engineer style. No tutorials, no aspirational language — every task is an executable contract.*

---

## v2 Changelog (what changed vs v1, and why)

This revision was triggered by a careful cross-reference against the implemented Object Data Funnel (`docs/funnel.md`, B1–B10 implemented and dual-running with Elasticsearch). The original 40-task spec assumed several primitives that the Funnel either implements differently or has already implemented under different names. Those conflicts are listed below; each downstream task has been revised to integrate with the actual Funnel surface rather than parallel it.

| # | Original conflict | Revision in v2 |
|---|---|---|
| 1 | PB-B1 said "stand up Temporal as required by Funnel B3" | Funnel makes Temporal *optional* with a Postgres `funnel_dispatcher` fallback (`FOR UPDATE SKIP LOCKED`). PB-B1 now mirrors this pattern: Temporal preferred, Postgres `pipeline_dispatcher` as fallback, both share `funnel_signal`-style infrastructure. |
| 2 | PB-B4 specified PyIceberg sidecar | Funnel uses **Lakekeeper REST catalog** via `services/funnel/lakekeeperClient.ts` and the thin `icebergCatalog.ts` wrapper. PB-B3/PB-B4 now use the same Lakekeeper catalog with `_pipeline.*` namespace (parallel to funnel's `_funnel.*`). |
| 3 | PB-B8 invented new signal endpoints | Reuses existing `POST /api/v1/funnel/signals` with `signalType=sourceTransactionCommitted`. New signal type `pipelineDeployCompleted` added (see FNL-H3). |
| 4 | LT-B3 invented `ontology.links.v2` topic | Funnel already publishes per-link CDC to `link_cdc.<src>__<link>__<tgt>` topics. LT-B3 now extends *that* schema rather than duplicating it. |
| 5 | LT-B8 presented `object_edits` as new work | `object_edits` already exists (migration 012). LT-B8 reduces to "publish CDC for object edits to a per-OT topic `object_cdc.<ot>`, mirroring the link_cdc pattern" — see also FNL-H2. |
| 6 | LT-B5 invented a 5-min pending window | Now uses existing `object_edits.applied_to_index_at` and the `link_edit.applied_to_index_at` columns added in LT-B3. |
| 7 | LT-F9 invented `/cdc-status` endpoint | Now consumes existing `/api/v1/funnel/clickhouse/cdc-lag` plus a new `link_cdc_lag_seconds` metric on the same endpoint. |
| 8 | LT-F10 reinvented replacement state machine | Now reuses the existing `object_type_active_index_version` machinery, generalized to link types in FNL-H4. |
| 9 | PB-F1 used SSE for deploy stream | Funnel already emits via WebSocket subsystem. PB-F1 now subscribes to the existing WebSocket channel (new event type `pipeline.deployment.*`). |
| 10 | LT-B7 (MCP) didn't reference `mergeStage` | `mergeStage.ts` already does marking union (`bulkUpsertInstances`). LT-B7 now extends merge-stage MCP config to link types via the propagation modes, rather than implementing parallel filtering. |
| 11 | Overlay system never extended to link writes | New section: every Action that writes a link edit must also write a Redis overlay key `overlay:link:<linktype>:<src>:<tgt>` for sub-1s visibility — see FNL-H5. |
| 12 | PB-B6 didn't reuse Funnel watermark pattern | Now uses the same Iceberg snapshot ID semantics as `funnel_changelog_watermark` so preview-pinning and changelog-tracking share one mental model. |
| 13 | Pipeline metrics endpoint was undefined | Now `/api/v1/pipelines/metrics` mirroring `/api/v1/funnel/metrics` shape. |

**Summary of net-new tasks added in v2:** 6 Funnel Hardening tasks (Section E, FNL-H1–H6). These are not "improvements to the Funnel" in the optional sense — without them, several of the 40 tasks below cannot meet their acceptance criteria at Palantir-target scale.

---

## Framing notes (read before B1)

**One.** These 40 tasks are layered on top of the implemented Object Data Funnel (`docs/funnel.md` B1–B10). The Funnel exposes its surface under `/api/v1/funnel/*` and owns: `object_instances`, `object_edits`, `funnel_run`, `funnel_stage_run`, `funnel_signal`, `funnel_changelog_watermark`, `object_type_active_index_version`, `replacement_diff_log`. **Do not duplicate these tables. Extend them.** Where extension is required, the change is captured in Section E (Funnel Hardening), not buried in a Pipeline Builder or Link Types task.

**Two.** Every task preserves the existing REST surface (`/api/v1/projects/:projectId/pipelines/...`, `/api/v1/ontology/:ontologyId/linkTypes/...`, `/api/v1/funnel/...`) so the current frontend keeps working. New capabilities are added as new endpoints, new query parameters with defaults that match current behavior, or new response fields that older clients ignore. Backwards-incompatible field changes ship behind a feature flag; new endpoints ship with `v2/` prefix where the semantics genuinely differ.

**Three.** The dependency order matters. PB-B1 (durable queue) must land before PB-B2 (compute swap), because swapping Node.js for DuckDB inside an unsupervised promise just moves the OOM site. LT-B1 (Iceberg M2M) must land before LT-B2 (configurable caps), because raising the cap on a CSV-on-disk path is malpractice. **Several tasks now have FNL-H prerequisites** — flagged in each task header.

**Four.** Acceptance criteria are *measured*, not asserted. "Completes in under X seconds at Y rows" means an integration test that runs in CI and fails the merge if it regresses.

**Five.** The Funnel is **dual-running with Elasticsearch** until shadow-diff stays under 0.1% across the soak window per Object Type. Until then, Elasticsearch remains the source of truth for queries. None of the tasks below assume the dual-run is complete, but several note where the Funnel cutover unblocks them.

---

# A. Pipeline Builder — Backend (10 tasks)

## PB-B1 — Replace fire-and-forget deploys with Temporal-preferred, Postgres-fallback supervised builds

**Goal.** Eliminate the "deployment stuck in `running` forever after pod restart" class of incidents. Make every deploy durable, retryable, cancellable, and idempotent against client retries — using the **same Temporal-or-Postgres-dispatcher pattern** the Funnel uses.

**Spec.** Mirror `funnelDispatcher.ts`'s pattern for the Pipeline Builder. Add a `PipelineDeployWorkflow(projectId, pipelineId, deploymentId, idempotencyKey)` Temporal workflow under `src/services/pipelines/temporal/workflows.ts`. **In parallel, build a `pipelineDispatcher.ts` Postgres-backed fallback** that polls a new `pipeline_signal` table with `signal_type='deployStart'` using `FOR UPDATE SKIP LOCKED` on a 2-second tick — this is the production fallback when Temporal is unreachable (matching Funnel posture, not requiring Temporal as hard dependency). The `POST /:pipelineId/deploy` endpoint becomes a thin wrapper that: (1) accepts an optional `Idempotency-Key` header (required from clients ≥v2; if absent, server generates one and returns it in `Idempotency-Key-Generated` response header for one release cycle, then required); (2) `INSERT INTO pipeline_deployments ... ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`; (3) inserts a `pipeline_signal` row with `signal_type='deployStart'` and signals Temporal if connected, otherwise relies on dispatcher pickup; (4) returns the existing `{deploymentId, status:'running', outputCount}` envelope unchanged.

Add a `DELETE /:pipelineId/deployments/:deploymentId` endpoint that signals the workflow with `cancelDeployment` (or sets `pipeline_signal.cancellation_requested_at` for the fallback path) — the worker catches the signal, fails the in-flight activity, writes `status='cancelled'`, and rolls back any partial dataset writes via Iceberg snapshot rollback (PB-B4 prerequisite). Add an orphan-sweeper activity that runs every 5 minutes and marks any deployment row with `status='running' AND now() - started_at > maxRunDuration` as `failed` with `error_message='supervisor_timeout'` — same pattern as the Funnel's `funnel_orphan_runs_swept_total` counter. The `idempotency_key` column on `pipeline_deployments` is `TEXT NOT NULL UNIQUE` with a partial-unique-index to allow nulls during the deprecation window. Add `pipeline_deployments.cancellation_requested_at TIMESTAMPTZ` so the worker can poll cooperative cancellation between activities.

**Acceptance.** (a) Killing the API pod mid-deploy and restarting it: the deploy continues from the next activity boundary, no data loss, no double-write — verified with both Temporal-connected and Temporal-disconnected configurations. (b) Two `POST /deploy` calls with the same `Idempotency-Key` within 5 seconds return the same `deploymentId`. (c) `DELETE /deployments/:id` on a `running` deploy transitions it to `cancelled` within 10 seconds and the partial output dataset is not committed. (d) A deploy with no signals for 4 hours past `maxRunDuration` is reconciled to `failed` automatically. (e) Existing frontend continues to work without changes (idempotency key auto-generated for one release). (f) Postgres dispatcher mode passes the same acceptance suite as Temporal mode.

**Risk.** Temporal determinism rules apply per the Funnel's documented gotchas — no `Date.now()`, no `Math.random()`, no I/O inside the workflow function. The cancellation rollback path requires PB-B4's Iceberg outputs; until then, cancellation can only mark the row, not undo CSV writes. Document this clearly. The Postgres fallback dispatcher must use `FOR UPDATE SKIP LOCKED` exactly as `funnelDispatcher` does — anything else races.

---

## PB-B2 — Swap the Node.js in-memory transform engine for DuckDB (default; Node.js retained as opt-in fallback)

**Goal.** Lift the practical row ceiling from ~100k (V8 heap) to single-digit billions per node, eliminate the silent-truncation bug, and put the compute layer on a substrate every other Foundry component (Polars, DataFusion, Furnace) is Arrow-native against. **Note**: in the Funnel, DuckDB is opt-in because pure-TS Merge is the safe baseline; in the Pipeline Builder, DuckDB becomes the default because there is no comparable pure-TS baseline that scales — the Node.js engine *is* the unsafe baseline being replaced.

**Spec.** Introduce `src/services/pipelines/duckdbTransformEngine.ts` that compiles `config.transforms[]` into a single DuckDB SQL statement and executes it via `@duckdb/node-api` (in-process; no subprocess for previews) or via a Python `duckdb` subprocess for deploys >5 GB (subprocess gives an isolation boundary so DuckDB OOMs don't take down the API pod). The compilation is a deterministic projection per transform: Cast → `CAST(col AS type) AS col`, Filter → `WHERE`, Drop → `SELECT * EXCLUDE(...)`, Rename → `SELECT col AS new`, Normalize → registered UDF, Join → `JOIN ... ON` with collision-prefixed columns, Union → `UNION ALL` with `ALTER TABLE ... ADD COLUMN` for type coercion. Cross-join is rejected at compile time unless the user passes `?allowCrossJoin=true&estimatedCardinality=N` and `N < 10_000_000`. DuckDB reads inputs directly from S3 via the `httpfs` extension — no `csv-parse`, no in-memory buffering — and writes outputs as Parquet via `COPY ... TO 's3://...' (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 100000)`. Preview endpoints use `LIMIT 5000` appended to the same compiled SQL, returning an Arrow IPC payload that the controller transcodes to JSON.

Keep the legacy Node.js engine behind `compute_type='legacy_nodejs'` for one release as a fallback (deprecation banner in UI); default `compute_type='duckdb'` on all new pipelines. The existing `transformService` interface (`preview`, `apply`, `outputPreview`, `executeChain`) is preserved — only the engine implementation swaps. **Reuse the same DuckDB binding and Iceberg extension that `services/funnel/duckdbIceberg.ts` uses**, sharing the connection-pool helper to avoid spawning duplicate DuckDB instances per pod.

**Acceptance.** (a) PDS-H SF-10 (~10 GB, 60M-row `lineitem` join) completes a 7-step transform chain in under 60 seconds on a 4-vCPU/16-GB pod. (b) A 100M-row Cast+Filter+Drop chain completes in under 5 minutes with peak RSS under 4 GB. (c) Cross-join without explicit override is rejected with a typed error, not OOM. (d) Preview latency for 5k rows on a 1-GB input is under 800 ms p95. (e) The existing `/transforms/:name/preview` and `/transforms/:name/apply` payload shapes are byte-identical to the legacy engine for a regression suite of 50 transform configs. (f) Memory cap enforced: DuckDB started with `SET memory_limit='12GB'` and a `PRAGMA temp_directory='/tmp/duckdb_spill'` so spills are bounded and observable. (g) Connection pool shared with `services/funnel/duckdbIceberg.ts` — verified via single DuckDB process per pod.

**Risk.** DuckDB's `httpfs` reads CSV at ~50 MB/s per file; if your S3 files are unsplittable single-file CSVs ≥10 GB you're bound by single-file scan. Mitigation: PB-B3 (Parquet outputs) makes downstream chains naturally parallel-readable. UDF registration for `Normalize` requires a small Rust extension or a JS-as-string evaluation path — pick the Rust extension; the JS path is a security hole.

---

## PB-B3 — Output format migration: CSV → Parquet, behind a per-pipeline format flag

**Goal.** Stop writing CSV to S3. Get 5–14× compression, columnar pruning for downstream readers, and schema metadata that downstream Funnel ingestion can trust.

**Spec.** Add `pipelines.output_format ENUM('csv','parquet','iceberg') NOT NULL DEFAULT 'csv'` (default `csv` for one release for backwards compat; flip to `parquet` in the release after PB-B4). Extend `dataset_columns` to record Parquet logical types (`logical_type TEXT NULL` — `STRING`, `INT64`, `DECIMAL(p,s)`, `TIMESTAMP_MICROS`, `DATE`, `BOOL`). The deploy writer in `deploymentService.ts` switches on `output_format`: CSV path is unchanged for safety; Parquet path uses DuckDB's `COPY (SELECT ...) TO 's3://.../{ts}.parquet' (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 100000)`. Output filenames change from `{name}_{ts}.csv` to `{name}_{ts}/part-00000.parquet` (directory-as-dataset pattern, ready for Iceberg manifest in PB-B4). Add `foundry_datasets.format` and `foundry_datasets.row_count_exact BIGINT` (set by reading Parquet footer rather than counting CSV lines). **The Funnel's Changelog stage (`changelogStage.ts`) already consumes Iceberg via the `SnapshotDiffReader` abstraction; for Parquet inputs it falls through to a full read. Update `SnapshotDiffReader` to recognize Parquet datasets via `foundry_datasets.format='parquet'` and use the Parquet stats footer for cheap incremental scans where possible** — this is the bridge between Pipeline Builder Parquet outputs and Funnel Changelog incremental processing without requiring Iceberg yet.

Add a `POST /:pipelineId/migrate-output-format` admin endpoint that re-deploys the pipeline with `output_format='parquet'` against an existing dataset, atomically updating `foundry_datasets.format`. Reject any pipeline whose schema has `null`-typed columns from being switched to Parquet — Parquet requires concrete types; surface a `SCHEMA_NOT_TYPED_FOR_PARQUET` error with the offending column list.

**Acceptance.** (a) A pipeline with `output_format='parquet'` produces a Parquet file 5–14× smaller than the equivalent CSV on the same input (measured against a 1M-row TPC-H `orders` benchmark). (b) Existing CSV pipelines continue to deploy unchanged with byte-identical output. (c) Funnel Changelog stage reading a Parquet-backed pipeline output completes 3–5× faster than the equivalent CSV input (incremental scan via Parquet stats vs full file scan). (d) `foundry_datasets.row_count_exact` matches the Parquet footer count, never an estimate. (e) Migration endpoint successfully converts a 100M-row CSV dataset to Parquet in under 10 minutes with zero data loss (verified via `COUNT(*)` and per-column hash comparison).

**Risk.** Some upstream consumers (BI tools, custom scripts) may parse CSV directly from S3. Add a `?format=csv` query param to a new `GET /datasets/:id/download` endpoint that lazily transcodes on-the-fly via DuckDB so legacy consumers keep working. Document the deprecation timeline.

---

## PB-B4 — Promote Parquet outputs to Iceberg managed tables via Lakekeeper

**Goal.** Give pipeline outputs ACID writes, snapshot isolation, time travel, row-level DELETE/UPDATE, and a changelog feed that the Funnel's Changelog stage can subscribe to incrementally — using the **same Lakekeeper REST catalog the Funnel already runs against**.

**Spec.** *Prerequisite: Funnel B2's Lakekeeper catalog stood up via `services/funnel/lakekeeperBootstrap.ts`.* Extend `pipelines.output_format` to accept `'iceberg'`. The Iceberg writer path uses the **existing `services/funnel/icebergCatalog.ts` wrapper and `lakekeeperClient.ts`** — do not introduce a parallel catalog client. Each deploy creates a *new snapshot* of the table `_pipeline.<project_slug>.<pipeline_slug>.output` (parallel namespace to the Funnel's `_funnel.<ot>.*`); `pipeline_deployments.output_snapshot_id BIGINT NOT NULL` records the produced snapshot. The cancellation path in PB-B1 becomes real: cancel issues `iceberg.rollback_to_snapshot(prior_snapshot_id)` via the same catalog wrapper.

Add `GET /:pipelineId/output/snapshots` returning the snapshot history with `(snapshot_id, parent_id, timestamp_ms, operation, summary)`. Add `GET /:pipelineId/output?as_of_snapshot=N` (or `as_of_timestamp=ISO`) that queries Iceberg time-travel via DuckDB's `iceberg_scan(..., snapshot_id=N)`. The downstream Funnel ingestion path reads `_pipeline.*` tables incrementally via Iceberg changelog views (`CREATE VIEW ... AS SELECT * FROM <table>.changes BETWEEN SNAPSHOT <a> AND <b>`) — this is what makes "deploy a pipeline and the Object Type backed by it auto-reindexes" work without full rescans, and it composes naturally with the existing `funnel_changelog_watermark` per `(ontology_id, object_type, datasource)` tuple.

Add `pipelines.iceberg_partition_spec JSONB` for users who need partitioned outputs (e.g., partition by `event_date`); validate the spec at deploy time against the output schema. Iceberg compaction (`rewrite_data_files`) and snapshot expiration (`expire_snapshots(older_than=now-30d, retain_last=100)`) run as scheduled Temporal workflows per table — same Temporal worker process as the Funnel's compaction work, not a parallel sidecar. **Where DuckDB's Iceberg writer has gaps on partition evolution** (per the Funnel's documented `tasks-02.md` B2 risk), fall back to the same PyIceberg sidecar the Funnel uses, sharing the container.

**Acceptance.** (a) A pipeline output table is queryable via `SELECT * FROM <table> FOR VERSION AS OF <snapshot_id>` and returns the exact state at that deploy. (b) Cancelling a deploy mid-write leaves the table at the prior snapshot — no partial files, no orphan data files referenced by the live snapshot. (c) Two concurrent deploys to the same output table: one wins (commits its snapshot), the other retries via Iceberg's optimistic-concurrency-control with exponential backoff and ultimately commits a successor snapshot — neither corrupts the table. (d) Funnel ingestion of an Iceberg-backed pipeline output uses the changelog view and processes only changed rows (verified via row-count of changelog SELECT vs full table scan), automatically advancing `funnel_changelog_watermark`. (e) Compaction job reduces a table with 1000 small files to under 50 files within 30 minutes without affecting concurrent reads. (f) Lakekeeper bootstrap covers `_pipeline.*` namespace alongside `_funnel.*`.

**Risk.** PyIceberg sidecar shared with Funnel — coordinate version pinning across both subsystems. Iceberg manifest size grows with snapshot count — without expiration, table metadata becomes a multi-MB read on every query. The expiration job is not optional. Iceberg's schema-evolution rules differ subtly between V2 and V3 spec; pin to V2 (same as Funnel default).

---

## PB-B5 — Streaming pipeline execution path with Funnel-aligned throughput cap

**Goal.** Honor the schema's `pipeline_type='streaming'` enum, which currently has no implementation. Match Palantir's Pipeline Builder streaming model where the same node graph is interpreted as either a batch DAG or a Flink stream graph based on `pipeline_type`. **Apply the same 2 MB/s per-Object-Type throughput cap the Funnel already enforces in `ThroughputGuard`** so a runaway streaming pipeline cannot swamp downstream Funnel indexing.

**Spec.** Introduce a `streaming_runtime` selector with the single supported value `'flink'` (room for `'kafka_streams'` later). On `POST /:pipelineId/deploy` for a `streaming` pipeline, the workflow does not run a one-shot transform; instead it: (1) compiles the node graph to a Flink SQL job (DuckDB-style transforms map cleanly: Filter → `WHERE`, Join → `JOIN ... FOR SYSTEM_TIME AS OF` for temporal joins, Union → `UNION ALL`, Cast/Drop/Rename → projection); (2) registers source connectors for each `dataset` node — Kafka source if the upstream `foundry_datasets.kind='stream'`, Iceberg source for batch-fed inputs (Flink Iceberg connector supports incremental scans); (3) registers Iceberg sink for the output table (Flink Iceberg connector with exactly-once via two-phase commit, writing to the same Lakekeeper catalog as PB-B4); (4) submits the job to the Flink cluster and stores `pipeline_deployments.flink_job_id`. The `status` field gains values `('running','running_streaming','succeeded','failed','cancelled','draining')`.

`DELETE /:pipelineId/deployments/:id` on a streaming deploy issues `flink stop --savepoint <s3-path>` and stores the savepoint ID for restart. New endpoint `POST /:pipelineId/deployments/:id/restart` resumes from the latest savepoint. Watermarks, lag, and checkpoint health are exposed via `GET /:pipelineId/deployments/:id/streaming-stats`. **Throughput cap: per-pipeline 2 MB/s on the source side, enforced by a wrapper Flink operator that calls into the same `ThroughputGuard` logic the Funnel uses on its Changelog activity** — exposing a shared `services/throughputGuard.ts` module both can import. Hard caps: max parallelism per pipeline = 16; max throughput per pipeline = 50 MB/s with explicit admin override.

**Acceptance.** (a) A streaming pipeline reading from a Kafka source at 10k events/s and writing to an Iceberg sink shows end-to-end latency p95 under 60 seconds. (b) Killing a Flink TaskManager mid-stream: the job recovers from the last checkpoint within 2 minutes, no event loss, no duplicates (verified via event-id tracker). (c) `DELETE` on a streaming deploy leaves a recoverable savepoint; `restart` resumes from it without reprocessing. (d) Backpressure from the Iceberg sink throttles the Kafka source within 30 seconds and `streaming-stats` shows the lag. (e) The existing batch pipelines deploy path is unchanged. (f) Throughput guard kicks in at 2 MB/s and rejects bursts; verified by directly testing against the shared `ThroughputGuard` module.

**Risk.** Flink SQL compilation from your declarative transform DAG has corner cases (windowed joins, late events). For v1, restrict streaming pipelines to projection + filter + simple equi-join, and reject anything else with `STREAMING_TRANSFORM_NOT_SUPPORTED`. Document the supported subset.

---

## PB-B6 — Deterministic, snapshot-pinned deploys (Iceberg snapshot IDs, mirroring funnel_changelog_watermark)

**Goal.** Eliminate the silent divergence between `previewSnapshot` and what gets deployed. When a user clicks "Deploy", the build runs against the *exact* upstream dataset version the preview was computed against — using **the same Iceberg snapshot ID semantics the Funnel uses in `funnel_changelog_watermark`**, so the two subsystems share one mental model for "what version am I reading."

**Spec.** Every preview operation captures `(node_id, upstream_dataset_id, upstream_snapshot_id, transforms_chain_hash, schema_fingerprint)` into `pipeline_nodes.config.previewSnapshot`. The deploy workflow reads this and resolves each input via `iceberg.scan(snapshot_id=upstream_snapshot_id)` through the shared `icebergCatalog.ts` wrapper — so the deploy reads the same data the preview did. If the upstream dataset has been deleted or its snapshot expired (PB-B4 retention policy of 30 days), deploy fails with `PREVIEW_SNAPSHOT_EXPIRED` and points the user to either (a) re-preview against the latest snapshot, or (b) deploy with `?ignorePreviewSnapshot=true` against the live upstream and accept the divergence.

Add `pipeline_deployments.input_snapshots JSONB` recording the resolved snapshot ID per input dataset for audit — schema parallel to `funnel_changelog_watermark`'s `(last_from_snapshot_id, last_to_snapshot_id)` so an ops engineer can correlate pipeline deploys with downstream Funnel reads. Add `transforms_chain_hash` invalidation: if the user modifies the transform chain after preview, the preview snapshot is invalidated and the UI must be told (a `previewSnapshot.stale=true` flag in the GET response). The deploy workflow refuses to start if `transforms_chain_hash != current chain hash` and `force=true` is not set in the deploy body.

**Non-Iceberg inputs (Parquet, CSV)** don't have snapshot IDs; for these, capture the S3 ETag and object version at preview time and use S3 versioning for read-back. If the input bucket lacks versioning, fail at preview-creation time with `INPUT_NOT_VERSIONED` rather than at deploy time.

**Acceptance.** (a) Preview a chain on a 1M-row Iceberg dataset, write 1M new rows to the upstream, deploy: the output reflects the original 1M rows, not the new ones. (b) Modify the transform chain after preview, attempt deploy without `force`: rejected with `PREVIEW_STALE`. (c) Snapshot expired: deploy fails with actionable error message. (d) `input_snapshots` correctly records the resolved snapshot for every input node, including transitive inputs through Join/Union nodes. (e) `?ignorePreviewSnapshot=true` deploys against latest and records the actual snapshot used, with a `divergence_warning` flag in the deployment row. (f) S3-versioned non-Iceberg inputs honor the object version at preview time.

**Risk.** Iceberg snapshot retention windows must be longer than typical preview-to-deploy latency. Coordinate with PB-B4's `expire_snapshots` job and the Funnel's snapshot retention to avoid premature expiration of in-flight previews.

---

## PB-B7 — RBAC on pipelines: Roles + Markings + Funnel-aligned propagation

**Goal.** Replace "any authenticated user can do anything in any project they can reach" with Palantir's actual model: per-resource roles (Owner / Editor / Viewer), Marking-propagated mandatory access (mirroring the Funnel's `bulkUpsertInstances` marking-union behavior), and CBAC if configured.

**Spec.** *Prerequisite: the auth layer's Markings model is defined.* Add `pipeline_acl(pipeline_id UUID, principal_id UUID, principal_type ENUM('user','group'), role ENUM('owner','editor','viewer'), granted_by UUID, granted_at TIMESTAMPTZ)` with `(pipeline_id, principal_id, principal_type)` as PK. Default ACL on pipeline create: `(creator, 'owner')`. Inheritance: if `pipeline_acl` has no rows for the user, fall back to project-level ACL.

Add `pipelines.input_markings TEXT[]` computed at deploy time as the union of all input datasets' markings — **this propagation rule is identical to the Funnel's `mergeStage.ts` behavior where `markings = array_agg(DISTINCT m)` across contributing datasources**. Reuse the same `union_markings()` helper from the Funnel codebase rather than reimplementing. The user must possess every marking in that union (`required_markings ⊆ user_markings`) to deploy. Output dataset markings = union of input markings, automatically.

Endpoints enforce: `GET` requires `viewer`, `PUT/POST/DELETE` requires `editor`, `POST /deploy` and `POST /share` require `owner`. New endpoints: `GET /:pipelineId/acl`, `PUT /:pipelineId/acl/:principalId`, `DELETE /:pipelineId/acl/:principalId`. Audit: every ACL change emits an event to the same `audit_log` table the Funnel writes to (or a parallel `pipeline_audit_log` if scope concerns dictate). The current "auth only" mode remains available for one release behind `RBAC_ENABLED=false` env var; default `true` from the next release.

**Acceptance.** (a) A `viewer` cannot edit a pipeline; the API returns 403 with `INSUFFICIENT_ROLE`. (b) Deploying a pipeline whose input datasets carry a marking `RESTRICTED` that the user lacks: 403 with `MISSING_MARKING:RESTRICTED`. (c) Output dataset's `markings` column equals the union of input markings, computed via the shared helper — verified by direct equality check against `mergeStage.ts`'s output for identical inputs. (d) Audit log captures every ACL grant/revoke with the actor's principal ID. (e) Existing single-tenant deployments work unchanged with `RBAC_ENABLED=false`.

**Risk.** Marking propagation through Join/Union nodes must be union, not intersection. Get this wrong and you leak data. Add property-based tests that randomly construct marking sets across inputs and assert the output marking set is the set-union — share the test fixture with the Funnel's marking-propagation tests so divergence is caught immediately.

---

## PB-B8 — Pipeline lineage as a first-class graph, fed into existing Funnel signals

**Goal.** When a user deploys a pipeline whose output dataset feeds an Object Type, the affected Object Type's Funnel workflow auto-fires. Today this is manual. **Use the existing `POST /api/v1/funnel/signals` endpoint with `signalType=sourceTransactionCommitted`** rather than inventing a parallel signal channel.

**Spec.** Add `dataset_lineage(downstream_dataset_id UUID, upstream_dataset_id UUID, edge_type ENUM('pipeline_output','funnel_input','virtual_table'), edge_metadata JSONB, created_at TIMESTAMPTZ)`. On every deploy completion, the workflow inserts an edge `(pipeline_output_dataset → input_dataset)` for each input. On Object Type backing-datasource configuration, an edge `(object_type_merged → backing_datasource)` is inserted.

**After any successful deploy, the workflow walks `dataset_lineage` downstream and for each Object Type whose backing datasources include the just-deployed dataset, calls the existing `POST /api/v1/funnel/signals` endpoint with `signalType=sourceTransactionCommitted`, payload `{ontologyId, objectTypeApiName, datasourceId, sourceTransactionId: <iceberg-snapshot-id-from-PB-B6>, idempotencyKey: deploymentId+'-'+ontologyId+'-'+objectTypeApiName}`.** This is the integration point: the Funnel already knows how to dedup signals by fingerprint (its `funnel_signal` idempotency story), so duplicate calls are safe. **FNL-H3 adds a `pipelineDeployCompleted` signal type** for cases where the consumer wants to know about the pipeline event itself (not just a generic source-transaction commit).

Add `GET /v2/datasets/:id/lineage?direction={upstream|downstream}&depth=N` returning the lineage graph as `{nodes: [...], edges: [...]}`. Constrain `depth` ≤ 10 to bound walk cost; default 3. Cycle detection: refuse to insert an edge that would close a cycle (recursive CTE check). Surface lineage in the existing `GET /:pipelineId` response as `lineage.feedsObjectTypes: [{ontologyId, apiName, role: 'backing_datasource'}]`.

**Acceptance.** (a) Deploy a pipeline whose output is a backing datasource of Object Type `Order`: within 30 seconds, the `Order` Funnel workflow's Changelog stage runs against the new snapshot — verified by checking `funnel_run` for a row triggered by the pipeline's deployment ID. (b) `GET /datasets/:id/lineage?direction=downstream&depth=5` returns the correct DAG. (c) Attempting to configure an Object Type backed by its own pipeline output (cycle) is rejected with `LINEAGE_CYCLE_DETECTED`. (d) Lineage walks are bounded — a depth-10 walk on a graph with 1000 datasets returns in under 500 ms. (e) Auto-fire is idempotent: deploying twice in quick succession to the same dataset does not enqueue two redundant Funnel runs (Funnel signal dedup via fingerprint).

**Risk.** The downstream walk on every deploy can become expensive at 10k+ datasets. Mitigation: a covering index on `dataset_lineage(upstream_dataset_id) INCLUDE (downstream_dataset_id, edge_type)`. The shared signal endpoint becomes a coupling point — any breaking change to `/api/v1/funnel/signals` ripples here; add a contract test.

---

## PB-B9 — Observability: SLIs, SLOs, structured logs, distributed traces (Funnel-shape metrics)

**Goal.** Make the Pipeline Builder observable to a senior SRE without source-code archaeology. SLO targets: deploy success rate ≥99.5%, p95 deploy latency for ≤100M-row inputs ≤10 min, preview p95 ≤2 s. **Follow the same metric-shape, dashboard, and endpoint convention the Funnel uses** so SREs see one mental model across both subsystems.

**Spec.** Instrument with OpenTelemetry: every HTTP handler, every Temporal/dispatcher activity, every DuckDB query gets a span; spans propagate `trace_id` from inbound requests through to Temporal workflow IDs. Emit Prometheus metrics following the Funnel's naming convention (e.g., the Funnel exposes `funnel_stage_duration_seconds{stage,object_type}` — Pipeline Builder uses `pipeline_deploy_duration_seconds{pipeline_id, status}`):

- `pipeline_deploy_duration_seconds{pipeline_id, status}` (histogram)
- `pipeline_deploy_total{status}` (counter)
- `pipeline_preview_duration_seconds{transform_type}` (histogram)
- `pipeline_active_deploys` (gauge)
- `pipeline_input_rows_processed_total` (counter)
- `duckdb_memory_bytes{node_id}` (gauge — shared metric with Funnel's DuckDB usage)
- `iceberg_snapshot_commit_duration_seconds{table}` (histogram — emitted by the shared `icebergCatalog.ts` for both subsystems)
- `temporal_workflow_failures_total{workflow_type, reason}` (counter)
- `pipeline_orphan_runs_swept_total` (counter — paralleling `funnel_orphan_runs_swept_total`)

All logs are structured JSON with `{ts, level, msg, trace_id, span_id, deployment_id, pipeline_id, project_id, actor_user_id}`. Add `/health` (liveness) and `/health/ready` (checks Postgres, S3, Temporal frontend, Lakekeeper catalog reachability — each must respond within 1s for ready=true). Expose **`/api/v1/pipelines/metrics`** for Prometheus scrape (parallel to `/api/v1/funnel/metrics`). SLO dashboard: a Grafana JSON definition checked into `infra/grafana/pipeline_builder.json`. Burn-rate alerts at 2% / 5% / 10% over 1h / 6h / 24h windows.

**Acceptance.** (a) A failing deploy generates a trace that spans HTTP → workflow → activities → DuckDB query, end-to-end visible in the trace UI. (b) Killing the database mid-deploy: `/health/ready` returns 503 within 5 seconds and a metric increment fires. (c) Burn-rate alert fires when deploy success rate drops below 99.5% sustained over 1h (verified by chaos-testing 1% deploy failures). (d) Grafana dashboard renders without errors against a fresh Prometheus scrape, and the dashboard JSON is structurally similar enough to the Funnel's that an SRE can navigate both. (e) Every error response from the API contains the `trace_id` in a header so users can attach it to support tickets.

**Risk.** OTel auto-instrumentation in Node has overhead — measure baseline preview latency before/after and ensure overhead is <5%. If higher, switch to manual instrumentation for hot paths.

---

## PB-B10 — Schema evolution + automatic Iceberg schema migration; trigger Funnel `schemaChanged` signal

**Goal.** When a user changes the transform chain (adds a Cast, drops a column, renames), the Iceberg output table's schema evolves *atomically* — adding columns as nullable, renaming via column-id remap, deprecating dropped columns. **Schema changes that affect downstream Object Types fire the existing Funnel `schemaChanged` signal**, which already kicks off the B9 replacement pipeline (`object_type_active_index_version` state machine). Do not duplicate that orchestration.

**Spec.** Compute `output_schema_fingerprint = sha256(json_canonical(output_columns))` on every deploy. Compare against `foundry_datasets.last_output_schema_fingerprint`. If unchanged: normal deploy. If changed: classify the diff into safe / unsafe. Safe operations and their Iceberg API mappings: column add → `table.update_schema().add_column(name, type, nullable=true).commit()`; column rename → `update_column_name(old, new)`; column type widen (int32→int64, float32→float64, decimal precision increase) → `update_column_type(name, new)`; column drop (logical) → `delete_column(name)` (Iceberg V2 retains the column ID so reads via old snapshots still work). Unsafe operations: column type narrow → reject with `SCHEMA_NARROWING_NOT_SAFE` unless `?force_schema_migration=true&accept_data_loss=true`; non-null → null on a column with existing data → reject; PK change → reject (Iceberg doesn't support; require new pipeline).

The migration runs *before* the data write in the same Temporal activity, with rollback on data-write failure (Iceberg metadata transactions are independent of data files; retain pre-migration snapshot ID for rollback). Surface the diff to the user via a new dry-run endpoint `POST /:pipelineId/deploy?dryRun=true` that returns `{schema_diff: [...], will_be_safe: bool, blocking_issues: [...]}` without committing.

**After a successful schema-evolving deploy, walk `dataset_lineage` (per PB-B8) for affected Object Types and fire `POST /api/v1/funnel/signals` with `signalType=schemaChanged`, payload `{ontologyId, objectTypeApiName, schema_diff, source_pipeline_deployment_id}`.** The Funnel's existing schema-change handling (per Funnel B9) already creates a pending Quickwit version `ot_<type>__v<N+1>`, runs backfill, and goes through the soak/cutover state machine. The Pipeline Builder simply tells the Funnel "schema changed, you handle it." This is the cleanest possible integration.

**Acceptance.** (a) Add a column to the transform chain, deploy: Iceberg table gains the column, prior snapshots remain readable. (b) Rename a column, deploy: downstream readers querying `SELECT old_name FROM table FOR VERSION AS OF <pre-rename-snapshot>` still work. (c) Narrow a type without the force flag: deploy rejected with actionable error. (d) Dry-run returns the correct diff classification for a curated test suite of 20 schema-change scenarios. (e) **A schema-evolving deploy on a pipeline whose output backs Object Type `Order`: within 60 seconds, `object_type_active_index_version` for `Order` transitions to `REPLACEMENT_BACKFILL` — verified by polling the Funnel's `GET /api/v1/funnel/replacement/Order` endpoint.**

**Risk.** Iceberg's schema-evolution rules differ subtly between V2 and V3 spec. Pin to V2 for now (same as Funnel). Type-widening across logical-type families (e.g., string → timestamp) is never safe; reject categorically.