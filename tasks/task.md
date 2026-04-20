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

---

# B. Pipeline Builder — Frontend (10 tasks)

## PB-F1 — Deploy queue + cancellation panel (WebSocket-driven, matching Funnel's existing channel)

**Goal.** Surface PB-B1's durable, cancellable deploys to the user. Replace the polling-only "running/succeeded/failed" badge with a live deploy queue. **Subscribe to the existing WebSocket subsystem** the Funnel already uses (per `docs/funnel.md` cross-feature relationships: "WebSocket… run/stage status updates can be forwarded for live UI").

**Spec.** Add a `<DeployQueuePanel>` component pinned to the right-hand sidebar of the pipeline canvas, persistent across navigation within the project. **It subscribes to the existing WebSocket channel** under a new event-type prefix `pipeline.deployment.*` (`pipeline.deployment.started`, `pipeline.deployment.activity_changed`, `pipeline.deployment.completed`). The Funnel already routes events of the form `funnel.run.*` through the same channel — extending the event-type map is a one-line registration in `websocket/eventRegistry.ts`. Polling fallback (every 3s on `GET /:pipelineId/deployments?status=running`) kicks in if the WebSocket disconnects for >5s.

For each in-flight deploy: pipeline name, deployment ID (clickable, copies to clipboard), `started_at` (relative + absolute on hover), current activity name (`Reading inputs`, `Compiling chain`, `Writing output`, `Compacting`), progress bar based on `pipeline_deployments.progress_pct` (new column written by activity heartbeat), and a Cancel button. Cancel triggers `DELETE /:pipelineId/deployments/:id`, optimistically transitions the row to `cancelling`, rolls back optimism on 5xx with a toast. Recently completed deploys (last 10, last 24h) show below the in-flight section with status icon, duration, and a "View output" link to the dataset browser. Idempotency: every deploy click generates a UUID v4 client-side, sent as `Idempotency-Key`; double-clicks within 5 seconds reuse the same key.

**Acceptance.** (a) Trigger a deploy, kill the API pod mid-build, restart: the panel shows the deploy resuming without a refresh, with correct activity name. (b) Click Cancel: the deploy transitions to `cancelled` within 10 seconds and the UI reflects it. (c) Double-click Deploy within 2 seconds: only one deploy is created. (d) WebSocket disconnect: the panel falls back to polling within 5 seconds, no stuck "running" rows after reconnect. (e) Mobile viewport (≤768px): panel is collapsible to a single-row "1 deploy running" pill that expands on tap. (f) WebSocket event delivery latency p95 <500 ms.

**Risk.** WebSocket through corporate proxies often breaks idle connections; the polling fallback is mandatory. Test with a 60–90 second proxy idle timeout.

---

## PB-F2 — Schema evolution wizard for transform-chain changes (with Funnel cutover preview)

**Goal.** Make PB-B10's safe/unsafe schema diff classification a first-class user experience. Before deploy, show what will change at the Iceberg table level, what's safe, what's blocked, and **what downstream Funnel cutovers will be triggered**.

**Spec.** When the user clicks Deploy on a pipeline whose transform chain has changed since last deploy, intercept the click and call the dry-run endpoint (`POST /:pipelineId/deploy?dryRun=true`). Display a `<SchemaEvolutionDialog>` with four sections: **Safe changes** (green), **Blocking issues** (red, with explanation), **Affected downstream** (info: list of Object Types and other pipelines that consume this output, fetched from PB-B8 lineage), and **Funnel impact** (info: for each affected Object Type, fetch `GET /api/v1/funnel/replacement/<ot>/preview-cutover` to show estimated backfill duration, soak period, and current diff-rate gate threshold).

If blocking issues exist, deploy is disabled. If only safe changes affecting no downstream Object Types, a "Deploy with schema migration" button proceeds. If downstream Object Types are affected, a more elaborate confirmation: "This will trigger replacement backfill for 3 Object Types. Estimated total cutover time: 2–4 days." The user must check `I understand this will trigger Object Type replacement backfills` before proceeding. For unsafe-but-overridable changes, the deploy body sends `force_schema_migration=true&accept_data_loss=true`.

**Acceptance.** (a) Adding a Cast that widens a column triggers the dialog showing it as a safe migration. (b) Removing a column shows blocking issues if downstream Object Types reference it (lineage-aware). (c) Funnel-impact section correctly reflects the replacement state machine's expected behavior. (d) Force-checkbox is unchecked by default. (e) Dialog renders correctly with screen-reader (`role="dialog"`, focus trap, ESC closes). (f) Performance: dialog opens in <800 ms even with 50-column schema diffs and 5 affected Object Types.

**Risk.** Funnel cutover-preview endpoint may be unavailable; gracefully degrade to "Funnel impact data unavailable; check `/api/v1/funnel/replacement/<ot>` directly."

---

## PB-F3 — Time-travel snapshot browser for output datasets

**Goal.** Surface PB-B4's Iceberg snapshot history as a navigable timeline so users can preview, compare, and restore prior outputs of a pipeline.

**Spec.** Add a `<SnapshotTimeline>` tab to the dataset detail view (the page that opens when clicking an output in the file browser). Fetch `GET /:pipelineId/output/snapshots`. Render as a vertical timeline with one entry per snapshot: timestamp (relative + absolute), deployment ID (clickable → deployment detail), row count, byte size, schema-change flag (yellow dot if schema differs from prior), and triggering user. Each entry has a `Preview at this version` button that opens the existing data-preview modal but with `?as_of_snapshot=N` appended. A `Compare to current` button on any non-current snapshot opens a `<SnapshotDiff>` showing row count delta, schema diff, and a sample of changed rows (LIMIT 100 from the Iceberg changelog view between the two snapshots).

An admin-only `Restore` button fires `POST /:pipelineId/output/snapshots/:id/restore` which creates a new deployment that copies the chosen snapshot's data into a new snapshot (rather than rewinding history — restore is forward-only, audit-friendly, matching the Funnel's no-rewind philosophy in `object_type_active_index_version`).

**Acceptance.** (a) Timeline loads in <1 s for tables with up to 100 snapshots. (b) Clicking a snapshot loads a preview at that version with correct row count. (c) Compare-to-current shows accurate diffs verified against direct DuckDB Iceberg queries. (d) Restore creates a new deployment row and produces an output with the historical data, leaving the snapshot history intact. (e) Pagination kicks in at >100 snapshots with a "Load older snapshots" button. (f) Snapshots beyond the 30-day retention window render as greyed-out with an explanatory tooltip.

**Risk.** Iceberg snapshot expiration (PB-B4) will drop snapshots beyond the retention window. The UI must gracefully handle "snapshot no longer available."

---

## PB-F4 — Explicit sample/full-mode toggles, with loud truncation warnings

**Goal.** Replace silent 5k/10k/100k truncations with explicit user-facing modes. Eliminate the "I deployed and lost rows I didn't know about" failure.

**Spec.** Every preview, chain-execute, and deploy call gains a mode selector in the UI: **Sample** (5k rows, fast), **Standard** (100k rows, default for deploys), **Full** (no cap; warns if estimated size > 1GB, requires Temporal-supervised execution per PB-B1, may take minutes). Mode is sticky per user per pipeline (stored in `localStorage` keyed by pipeline ID). The transform chain panel shows the current mode prominently next to the run button. After any execution, if the actual row count returned matches the cap exactly, render a yellow banner: `Result truncated to 100,000 rows. Switch to Full mode to process all rows.` with a one-click switch.

The deploy modal shows a clear summary before submission: "Will deploy approximately N rows (estimated from upstream snapshot stats) in `<mode>` mode." Estimates pulled from Iceberg manifest stats (`row_count` from snapshot summary) when input is Iceberg; for Parquet inputs, Parquet footer metadata; for legacy CSV inputs, an HEAD request to S3 plus an "estimate may be inaccurate" disclaimer.

**Acceptance.** (a) Mode toggle visible on every preview/run/deploy action; never hidden in a sub-menu. (b) Truncation warning fires whenever returned rows == cap; verified by an integration test that asserts the warning DOM element is present. (c) Full-mode deploys above 1GB show a confirmation dialog with estimated cost and time. (d) The selected mode survives page refresh. (e) Existing API consumers without mode parameter default to current behavior (Standard/100k); no breaking change. (f) Iceberg-input estimates match `iceberg_metadata.row_count` exactly.

**Risk.** Estimating row count from S3-CSV is unreliable. Make peace with showing "≈" for legacy datasets and link to PB-B3's Parquet migration for accurate estimates.

---

## PB-F5 — Compute engine selector

**Goal.** Expose PB-B2's DuckDB engine and the legacy Node.js engine as an explicit choice per pipeline. Prepare the UI for future engines (Polars, DataFusion).

**Spec.** Add a `Compute Engine` field to the pipeline settings sidebar with options: **DuckDB** (default, recommended badge), **Node.js (legacy)** (deprecated badge with sunset date), and disabled future options **Polars (preview)** and **DataFusion (preview)** with tooltip "Coming soon." Saving the pipeline updates `pipelines.compute_type` accordingly. Above the compute selector, render an info card showing the practical limits per engine: DuckDB 5B rows / 12 GB memory, Node.js 100k rows / 4 GB heap. If the user picks Node.js for a pipeline whose estimated input is >1M rows, show a warning. Add a `Migration` button next to "Node.js (legacy)" that re-runs the latest deploy on DuckDB and shows a side-by-side row-count and schema diff for verification before flipping the default.

**Acceptance.** (a) Engine choice persists per pipeline. (b) Selecting Node.js on a 100M-row pipeline warns the user. (c) Migration tool runs both engines and reports any divergence (row count, column hash). (d) Deprecated badge renders on the Node.js option with the configured sunset date. (e) Existing pipelines have `compute_type='nodejs'` honored until explicitly changed (no silent migration).

**Risk.** Engine divergence on edge cases (NULL handling, type coercion, decimal precision) will surface during migration. Have a documented diff tolerance (e.g., 0.01% row-count delta acceptable due to NaN handling).

---

## PB-F6 — Streaming pipeline canvas + live event preview

**Goal.** Make PB-B5's streaming runtime usable without dropping into Flink Web UI. Show live event flow on the canvas while a streaming pipeline is running. **Display the same throughput-cap warning the Funnel surfaces when its `ThroughputGuard` engages.**

**Spec.** When `pipeline_type='streaming'` is set, the canvas mode switches: nodes get a small live-rate badge (e.g., `1.2k/s` rendered top-right of each node), updated every 2s from `GET /:pipelineId/deployments/:id/streaming-stats`. A new `<StreamingControls>` panel replaces the Deploy button with: **Start**, **Drain** (signals graceful shutdown with savepoint), **Restart from savepoint**, **View checkpoints**. A live-tail preview panel shows the last 100 events at the selected node — implemented via the same WebSocket channel as PB-F1 with event type `pipeline.streaming.event_sample` (limit: only Editor+ role; redacted by Markings).

Watermark lag and backpressure are visualized as a small chart in the panel footer. **When `ThroughputGuard` engages (streaming-stats reports `throughput_capped: true`), display a banner: "Throughput capped at 2 MB/s to protect downstream Funnel indexing. See [docs link]."** Schema-change attempts on a streaming pipeline trigger a special dialog explaining that streaming requires drain → schema-evolve → restart-from-savepoint, with a guided workflow.

**Acceptance.** (a) Start button submits the Flink job; canvas badges populate within 30 seconds with non-zero rates. (b) Drain initiates a savepoint and stops the job within 60 seconds. (c) Restart-from-savepoint resumes correctly without reprocessing the savepoint's events. (d) Schema-change wizard for streaming clearly distinguishes "safe at runtime" (add nullable column) from "requires drain" (any other change). (e) Live tail respects Markings: a row whose markings the viewer lacks is rendered as `<redacted>`. (f) Throughput-cap banner renders correctly when `ThroughputGuard` engages.

**Risk.** Flink Web UI exposure has security implications; the backend must proxy and authn-gate, never expose Flink directly. Live tail bandwidth at high event rates can saturate the WebSocket; sample at 100 events/s max client-side.

---

## PB-F7 — Lineage explorer integrated into pipeline detail (Funnel-aware)

**Goal.** Surface PB-B8's lineage graph in-context so users see what feeds in, what flows out, and which Object Types depend on this pipeline. **Each Object Type node links to the Funnel's run history for that Object Type.**

**Spec.** Add a `<LineageGraph>` tab to the pipeline detail view, rendered with a force-directed layout (use the existing `react-flow` already in the canvas to keep deps lean). Default view: 2 hops upstream + 2 hops downstream from the pipeline's outputs, fetched from `GET /v2/datasets/:id/lineage?direction=both&depth=2`. Node types: dataset (rectangle), pipeline (rounded rectangle, blue), object type (hexagon, purple, **clickable to `/api/v1/funnel/runs/objectTypeId/<id>` history view**), virtual table (dashed rectangle). Edges are directed with edge-type labels on hover. Click any node → opens its detail page in a new tab.

A depth slider (1–10) re-fetches as the user changes it; debounced 300 ms. A "Highlight critical path" toggle bolds the path from any input to the most downstream Object Type. Performance: virtualize the graph at >200 nodes; show a "Showing 200 of N nodes" disclaimer with a "Show all (slow)" override. **For each Object Type node, display a small badge showing its current Funnel state** (`LIVE`, `REPLACEMENT_BACKFILL`, `REPLACEMENT_SOAK`, etc.) fetched from `GET /api/v1/funnel/replacement/<ot>` — color-coded so at-a-glance you can see which downstream Object Types are mid-cutover.

**Acceptance.** (a) Renders correctly for pipelines with up to 10 inputs and 5 downstream Object Types. (b) Depth slider re-fetches with debounce and the graph updates without flicker. (c) Cycle detection: if the lineage CTE somehow returns a cycle, the renderer doesn't infinite-loop. (d) Click-through to dataset/pipeline/object-type pages works; Object Type click opens the Funnel run history. (e) Empty state: a fresh pipeline with no deploys shows "No lineage yet — deploy this pipeline to populate." (f) Funnel-state badges accurately reflect `object_type_active_index_version.state`.

**Risk.** Force-directed layouts perform poorly at 500+ nodes. The depth cap of 10 plus virtualization is the safety valve; document it.

---

## PB-F8 — RBAC editor and permission preview

**Goal.** Surface PB-B7's pipeline ACL model in the UI. Let owners grant/revoke roles, see effective permissions for any user, and audit recent ACL changes.

**Spec.** Add a `Permissions` tab to the pipeline settings dialog, owner-only. Three sections: **Direct grants** (table from `GET /:pipelineId/acl` showing principal, role, granted by, granted at, with revoke buttons), **Add member** (combobox searching users/groups via `GET /v2/principals?q=`, role dropdown, optional message), **Effective permissions** (search a user, see what role they get on this pipeline considering direct grants, project-level grants, and group memberships — backend calls `GET /:pipelineId/acl/effective?principalId=X`). A read-only `Recent changes` accordion shows the last 20 ACL changes from `audit_log`, with diff view (before/after roles).

For owners: a `Markings` panel shows the union of input markings (computed by the same shared helper used in `mergeStage.ts`) and a list of users who would be denied deploy due to missing markings.

**Acceptance.** (a) Adding a viewer reflects in `pipeline_acl` and in the effective-permissions check immediately. (b) Revoking the only owner is blocked client-side and server-side with `CANNOT_REMOVE_LAST_OWNER`. (c) Effective permissions correctly reflects group memberships and project inheritance. (d) Recent changes table loads in <500 ms even with 1000 historical changes (paginated). (e) Markings panel correctly identifies users who can read inputs but lack the union required for deploy. (f) Marking computation matches `mergeStage.ts` byte-for-byte for identical input sets.

**Risk.** Group expansion on every effective-permissions check is expensive. Cache the per-user effective permission for 60s with explicit invalidation on ACL change.

---

## PB-F9 — Pipeline observability dashboard (in-app SLO view, mirroring Funnel dashboard layout)

**Goal.** Give pipeline owners the same view of their pipeline's health that an SRE has, without requiring Grafana access. **Layout mirrors the Funnel's existing in-app metrics view** so users moving between subsystems see consistent navigation.

**Spec.** Add a `Health` tab to the pipeline detail page. Five panels backed by PB-B9's Prometheus metrics, queried via a new `GET /v2/metrics/pipeline/:pipelineId?window=24h` endpoint that wraps Prometheus PromQL: **Deploy success rate** (line chart, target 99.5%), **Deploy latency p50/p95/p99** (line chart with SLO band), **Deploys per day** (bar chart), **Average rows processed per deploy** (line chart), **Recent failures** (table of last 10 failed deploys with error message, click → deployment detail with trace ID).

Time-window selector: 1h / 6h / 24h / 7d / 30d. A small SLO-status pill at the top shows overall health: green / yellow / red. The pill is also rendered on the pipeline list row in the file browser. **Below the pipeline-specific panels, render a fixed "Funnel runs triggered by this pipeline" panel** — calls `GET /api/v1/funnel/runs` filtered by `triggered_by_pipeline_deployment_id IN (this pipeline's recent deployments)` — so users can see which downstream Object Type indexings their deploys caused.

**Acceptance.** (a) Dashboard renders within 2 seconds for a pipeline with 30 days of history. (b) SLO breaches highlight correctly against the configured thresholds. (c) Failure-table click navigates to the deployment detail with trace ID for debugging. (d) Empty state for a fresh pipeline shows a friendly "No deploys yet" message, no broken charts. (e) Mobile viewport renders the panels stacked rather than side-by-side. (f) The "Funnel runs triggered" panel correctly displays runs caused by the most recent 10 pipeline deployments.

**Risk.** PromQL queries from the frontend are a new attack surface — the wrapper endpoint must whitelist queries by template ID, never accept user-supplied PromQL. Funnel-runs panel requires FNL-H3 (signal type extension) to track `triggered_by_pipeline_deployment_id`.

---

## PB-F10 — Live preview snapshot indicator on the canvas (Iceberg snapshot ID-aware)

**Goal.** Surface PB-B6's preview-snapshot pinning so users always know whether their next deploy will run against the snapshot they previewed or against the latest data.

**Spec.** Every node on the canvas displays a small pin badge with state: **Pinned** (green pin icon, tooltip: "Preview snapshot from <timestamp>, will deploy against this version"), **Stale** (yellow exclamation, tooltip: "Transform chain changed since last preview — re-preview before deploying"), **Expired** (red, tooltip: "Preview snapshot no longer available — re-preview required"), or **Unpinned** (grey outline, tooltip: "No preview snapshot — will deploy against latest data"). Hovering the badge shows the snapshot timestamp, snapshot ID (for Iceberg inputs) or S3 ETag (for Parquet/CSV inputs), and lineage to the input dataset.

Clicking the badge opens a small popover with: "Re-preview" button (re-runs preview, updates pin), "Compare to latest" button (shows row-count delta to upstream's current state), "Force unpin" button (deploys against latest, with confirmation). The Deploy button is decorated when any node is Stale: yellow border + tooltip "Some previews are stale; deploy will proceed against pinned snapshots, not latest data" — clicking offers the choice to re-preview or proceed.

**Acceptance.** (a) Modify a transform → relevant nodes show Stale within 1 second. (b) After 30 days (per PB-B4 retention), the badge transitions to Expired and Re-preview is enforced before deploy. (c) Compare-to-latest shows accurate row-count delta. (d) Force-unpin deploy correctly sends `?ignorePreviewSnapshot=true`. (e) Badge color choices are colorblind-safe (verified with simulator) and have matching icons. (f) For Iceberg inputs, the snapshot ID shown matches `pipeline_deployments.input_snapshots`.

**Risk.** Constantly re-checking snapshot expiration on every render is wasteful. Cache the expiration status server-side for 5 minutes per snapshot.

---

# C. Link Types — Backend (10 tasks)

## LT-B1 — Migrate M2M join-table storage from CSV-on-disk to Iceberg per link type, via shared Lakekeeper catalog

**Goal.** Eliminate the 50-MB / 650k-edge ceiling, the local-disk SPOF, the no-ACID corruption risk, and the inability to do incremental compaction on M2M links. Get to billions of edges per link type without code changes per million. **Use the same Lakekeeper REST catalog and `icebergCatalog.ts` wrapper the Funnel and Pipeline Builder share** — namespace `_links.<ontology_id>.<link_api_name>` parallel to `_funnel.<ot>.*` and `_pipeline.*`.

**Spec.** *Prerequisite: Funnel B2 (Lakekeeper catalog).* Replace the CSV-on-disk path under `data/join_tables/` with an Iceberg table per M2M link type, schema `(source_pk STRING, target_pk STRING, link_props STRUCT<...>, markings ARRAY<STRING>, created_at TIMESTAMP, source_action_rid STRING, correlation_id STRING)`, partition by `bucket(64, source_pk)` for write parallelism, ORDER BY `(source_pk, target_pk)`. The `correlation_id` and `source_action_rid` columns make the link store consistent with `object_edits` schema once FNL-H2 lands.

Add `link_type.storage_backend ENUM('csv_legacy','iceberg') NOT NULL DEFAULT 'csv_legacy'` (flip default to `iceberg` after one release). The `linkResolverService.parseJoinTableCSV` interface is preserved — implementation switches on `storage_backend`: legacy reads CSV from disk (unchanged), iceberg path reads via DuckDB `iceberg_scan('_links.<ontology>.<link>', filter='source_pk IN (...)')` using the **shared connection pool from PB-B2**. The `POST /:apiName/upload` endpoint now writes uploaded CSVs *into* the Iceberg table via a streaming PyIceberg writer (the same sidecar PB-B4 uses) rather than storing them on disk; rejects payloads >5 GB but no longer 50 MB.

Add `POST /:apiName/migrate-storage` (admin-only) that reads the legacy CSV, writes it as Iceberg snapshots, swaps the `storage_backend` flag, and keeps the CSV file for 30 days as backup before deletion. M2M reads (forward and reverse) continue to use the same `getTargetPKsFromJoinTable` / `getSourcePKsFromJoinTable` interface, but Iceberg-backed reads use file-skip via partition stats and column-stats predicate pushdown.

**Acceptance.** (a) Upload a 2 GB CSV (≈26M edges) to an M2M link: succeeds, written as Iceberg snapshots, queryable via the existing resolve endpoint. (b) Forward lookup on a 1B-edge link with `source_pk IN (5 PKs)` completes in <500 ms p95 (file-skip working). (c) `POST /:apiName/migrate-storage` on an existing CSV-backed link with 100k edges completes in <30 seconds, and post-migration query results match the pre-migration results exactly. (d) Concurrent edits via the `link_edit` table (still Postgres) and Iceberg compaction don't lose edits — the compaction job applies `link_edit` deltas before snapshot commit. (e) Existing API contract preserved; legacy CSV-backed links continue to work unchanged. (f) Lakekeeper catalog includes `_links.*` namespace — verified via Funnel's `GET /api/v1/funnel/lakekeeper/info`.

**Risk.** PyIceberg sidecar dependency surfaces here too; coordinate with PB-B4 on shared deployment. The `link_edit` → Iceberg compaction job must be transactional with `link_edit.applied_to_iceberg_at` updates. Get this wrong and you double-apply edits or lose them.

---

## LT-B2 — Configurable PK caps with cardinality-estimated escalation to existing ClickHouse + Quickwit infrastructure

**Goal.** Replace the three hard-coded 100,000 PK caps (resolver, searchAround, multiHop) with a configurable, per-tenant, per-query estimate-then-escalate model that matches OSv2's behavior. **Reuse the existing `searchAround/clickhouseClient.ts` and `quickwitTraversal.ts`** infrastructure the Funnel B10 already implemented — do not stand up parallel paths.

**Spec.** Introduce `link_resolver_config` settings (per ontology): `max_intermediate_pks` (default 100k, max 1M), `max_search_around_source` (default 100k, max 1M), `max_multihop_intermediate` (default 100k, max 1M), `escalation_backend ENUM('none','clickhouse','furnace') DEFAULT 'clickhouse'`, `escalation_threshold_pks` (default 100k — above this, escalate). Endpoints accept `?maxResultPks=N` to override per-request, capped by the tenant's configured maximum.

Add `cardinality_estimate(linkType, sourceFilter)` method: for FK links use OpenSearch `_count` against the source filter; for M2M Iceberg-backed links use Iceberg's manifest stats (`row_count` from partition metadata) intersected with the filter via DuckDB `EXPLAIN ANALYZE`. If estimate > `escalation_threshold_pks`, route to the configured escalation backend: **ClickHouse path uses the existing `linkMaterializedView.ts` pattern** the Funnel already wired up via `cdcLinkProducer.ts` — no new MV schema, no new CDC topic; the Funnel's existing `link_<src>__<link>__<tgt>` MV is what we query against. Furnace path (when LT-B7's SQL layer lands) compiles to Calcite-planned SQL over Iceberg link tables.

Returns include `metadata: {estimated_pks, actual_pks, backend_used, escalated, latency_ms}` so the client can render appropriate UI. The hard 1M cap is global; above that the response is `RESULT_SET_TOO_LARGE`.

**Acceptance.** (a) A 2-hop traversal where hop-1 returns 50k PKs runs entirely on Quickwit; hop-1 returns 500k routes hop-2+ to ClickHouse. (b) Cardinality estimate accuracy: median estimate within 20% of actual on a 100-query benchmark. (c) `?maxResultPks=500000` honored when within the tenant's max. (d) Above-cap requests return a typed error, not a partial result. (e) Existing endpoints with no `maxResultPks` default to the per-tenant config (which defaults to current 100k, no behavior change for existing clients). (f) ClickHouse path queries the existing `link_<src>__<link>__<tgt>` MV directly — verified by inspecting CH query log.

**Risk.** ClickHouse-Iceberg join requires either ClickHouse Iceberg engine or the existing Funnel-managed CH MV fed from CDC. Stay with the MV path initially (matches Funnel B10 implementation). CDC lag in the MV (per Funnel's `cdc_lag_seconds` SLO of <30s) puts a freshness floor on escalated queries — surface this in the response metadata.

---

## LT-B3 — Harden the existing per-link CDC schema (`link_cdc.<src>__<link>__<tgt>`) with actor, action_rid, retraction, schema_version

**Goal.** Make the Funnel's existing per-link CDC topics carry the full Ontology-edit semantics, not generic CDC. **Extend the existing `link_cdc.<src>__<link>__<tgt>` topic schema** rather than introducing a parallel `ontology.links.v2` topic. The per-link partitioning the Funnel chose has real benefits (per-link consumer parallelism, per-link replay) — keep it.

**Spec.** The existing `cdcLinkProducer.ts` publishes to per-link Kafka topics. Add a new schema version (`schema_version="2.0.0"`) to the Avro registered in Schema Registry under those topics:

```
record LinkEdit {
  string schema_version;            // "2.0.0"
  string event_id;                  // UUID for idempotency
  long event_ts_micros;
  string ontology_id;
  string link_type_api_name;
  enum operation { ADD, REMOVE, RETRACT };
  string source_pk;
  string target_pk;
  union { null, map<string, bytes> } link_props;  // typed via schema_version
  array<string> markings;
  string actor_principal_id;
  union { null, string } action_rid;
  union { null, string } correlation_id;
  union { null, string } causation_id;
  union { null, string } retracts_event_id;
}
```

Producers (`editApplicator.publishLinkCdc`) accept the new fields; missing fields are populated where possible (actor from auth context, action_rid from the action workflow, correlation/causation from the request scope). Consumers (the existing Funnel ClickHouse MV refresh path, plus any new Quickwit indexers) migrate to v2 first; v1 schema is deprecated after one release. **Schema Registry must be set to BACKWARD_TRANSITIVE compatibility for these topics** to allow safe evolution.

RETRACT is *not* the same as REMOVE — REMOVE is a normal forward operation ("user removed the link"), RETRACT is a correction ("the prior ADD should not have happened"); downstream materialization treats RETRACT as a hard delete that propagates to derived state, while REMOVE preserves history. This matches Iceberg changelog semantics (`UPDATE_BEFORE`/`UPDATE_AFTER`/`DELETE`) cleanly.

Add `link_edit.applied_to_iceberg_at TIMESTAMPTZ` and `link_edit.applied_to_index_at TIMESTAMPTZ` columns mirroring `object_edits`'s pattern, so the link world has the same coordination protocol the object world already has. **Update the Funnel's overlay sweeper (`overlay/sweeper.ts`) to handle link overlay keys** introduced in FNL-H5.

**Acceptance.** (a) Every link edit produced by an Action carries actor, action_rid, correlation_id correctly populated. (b) Schema Registry rejects publishes with missing required fields. (c) RETRACT events propagate to ClickHouse as `_link_retracted=true` flagged rows and cause downstream re-materialization. (d) Replay of a 1M-event Kafka window into a fresh ClickHouse MV produces the same final state as the source-of-truth `link_edit` table. (e) v1 schema reads continue to work via Avro forward-compat. (f) `link_edit.applied_to_iceberg_at` populated by LT-B1's compaction job; `applied_to_index_at` populated by Quickwit consumer.

**Risk.** Avro schema evolution rules need to stay strictly backwards-compatible during the dual-publish phase. Pin Schema Registry to BACKWARD_TRANSITIVE compatibility. Per-link topic count grows linearly with link count — at 100+ link types, Kafka partition planning becomes a real concern; document the per-link partition strategy.

---

## LT-B4 — Loud enforcement of ONE_TO_ONE cardinality violations

**Goal.** Convert `console.warn` of ONE_TO_ONE violations into a first-class data-integrity error that fails writes (or quarantines them) and surfaces in the UI.

**Spec.** ONE_TO_ONE link types gain `link_type.violation_policy ENUM('warn','reject','quarantine') NOT NULL DEFAULT 'warn'`. Default `warn` for backwards compat; new ONE_TO_ONE links default to `reject`. On every edit (Action or merge stage) that would create a second link from the same source PK in a ONE_TO_ONE relationship: `warn` logs and proceeds (current behavior), `reject` fails the action with `ONE_TO_ONE_VIOLATION` (HTTP 409), `quarantine` writes the edit to `link_quarantine(violation_id, link_type_id, source_pk, target_pk, attempted_at, reason JSONB, status ENUM('pending','resolved','dismissed'))` and the action returns success with a `warnings` field.

Add `link_type.violation_count_24h INT` (rolling counter, decayed by a job) so the UI can badge problematic link types. New endpoints: `GET /:apiName/violations?status=pending`, `POST /:apiName/violations/:id/resolve` (admin chooses which target to keep), `POST /:apiName/violations/:id/dismiss`. The resolver, when it observes a ONE_TO_ONE link returning >1 result *despite* policy enforcement (indicates a historical violation), treats it as a quarantine and surfaces it to the response with `data_quality_warning: ['ONE_TO_ONE_RESOLVED_MULTIPLE']`.

**Acceptance.** (a) Setting `violation_policy='reject'` causes the action to fail at the second link creation with a 409. (b) `quarantine` mode preserves the original link unchanged and writes the conflicting attempt to `link_quarantine`. (c) `GET /:apiName/violations` returns paginated quarantine entries. (d) Admin resolve: choosing target T keeps the link to T, deletes the link to T'. (e) Existing ONE_TO_ONE links continue to default to `warn` to avoid breaking changes; new links via the API default to `reject`.

**Risk.** Bulk migrations from external sources may legitimately produce transient ONE_TO_ONE violations that resolve. The `quarantine` mode + admin-resolve flow handles this without losing data.

---

## LT-B5 — FK orphans as a first-class state, leveraging existing `applied_to_index_at`

**Goal.** Replace silent "missing target = no link" with explicit `resolved` / `pending` / `orphaned` state per FK relationship. **Use the existing `object_edits.applied_to_index_at` and the new `link_edit.applied_to_index_at` (LT-B3) columns** for pending detection — no new pending-window timer logic.

**Spec.** The `validateForeignKeys` resolver method becomes `resolveFKWithState(linkType, objectPK, direction)` returning `{state: 'resolved'|'pending'|'orphaned', target?: object, orphan_reason?: string}`. State derivation: target exists in OS index → `resolved`; target missing but `object_edits` shows a recent ADD with `applied_to_index_at IS NULL` → `pending` (the indexer hasn't caught up yet — same definition the Funnel B7 overlay uses); target missing and no pending edit → `orphaned`.

A new background job `link_orphan_scanner` runs hourly per link type, samples `min(100k, total_objects)` source rows, computes the orphan rate, writes to `link_orphan_stats(link_type_id, scanned_at, sample_size, orphan_count, orphan_rate, p_orphan_window_lower, p_orphan_window_upper)` (Wilson confidence interval). Endpoints: `GET /:apiName/orphan-stats` returns the latest stats and trend over 30d; `GET /:apiName/orphans?cursor=...` returns paginated orphan rows for inspection (admin only). The Action layer's existing "FK orphans as warnings, never errors" semantics is *preserved* — Palantir's actual behavior is lazy/eventual link resolution — but orphans now leave a trail. Alert rule: orphan rate jumps >5% week-over-week.

**Acceptance.** (a) Editing an object whose FK target doesn't exist: action succeeds with `warnings: [{type: 'FK_ORPHAN', linkType, target_pk}]`. (b) Resolver returns `state: 'pending'` for an FK whose target was added but `applied_to_index_at IS NULL`. (c) Resolver returns `state: 'pending'` correctly for both Funnel-managed Object Types (using `object_edits.applied_to_index_at`) and link-edit-managed link types (using `link_edit.applied_to_index_at`). (d) Hourly scanner produces stable orphan-rate estimates. (e) `GET /:apiName/orphans` returns a paginated list. (f) Existing API responses unchanged unless the client opts into the new state field via `?include_link_state=true`.

**Risk.** The `pending` definition couples to indexer freshness. If indexer lag spikes (Funnel B6 indexing stuck), the `pending` window grows. This is the correct behavior — surface it via the existing `overlay_to_index_lag_p99` SLI.

---

## LT-B6 — Bidirectional link-type model: replace `is_bidirectional BOOLEAN` with a full reverse spec

**Goal.** Match Palantir's actual link-type semantics: per-direction display name, per-direction property projection, per-direction Action rules, per-direction cardinality view.

**Spec.** Migrate the `is_bidirectional BOOLEAN` column with this additive structure:

```sql
ALTER TABLE link_type ADD COLUMN reverse_api_name TEXT NULL;
ALTER TABLE link_type ADD COLUMN reverse_display_name TEXT NULL;
ALTER TABLE link_type ADD COLUMN reverse_description TEXT NULL;
ALTER TABLE link_type ADD COLUMN reverse_visible BOOLEAN DEFAULT true NOT NULL;
ALTER TABLE link_type ADD COLUMN reverse_property_projection JSONB NULL;
                          -- e.g., {"included":["created_at","weight"],"excluded":["secret_score"]}
ALTER TABLE link_type ADD COLUMN reverse_actions_enabled BOOLEAN DEFAULT true NOT NULL;
ALTER TABLE link_type ADD COLUMN bidirectional_migrated_at TIMESTAMPTZ NULL;
```

Migration job: for every existing link type with `is_bidirectional=true`, populate `reverse_api_name = api_name + '_reverse'`, `reverse_display_name = display_name + ' (reverse)'`, defaults for the rest; `bidirectional_migrated_at = now()`. The `is_bidirectional` column stays for one release as a computed view (`reverse_api_name IS NOT NULL`).

The resolver's `direction='reverse'` now consults the reverse projection: only the listed link properties are returned, others are stripped server-side. Action rules in `linkRules.ts` gain a `direction` parameter — `processAddLinkRule` for forward links is unchanged; for reverse-direction, a new `processAddReverseLinkRule` is invoked iff `reverse_actions_enabled=true`, otherwise `REVERSE_ACTIONS_DISABLED`. Cardinality view: a forward `ONE_TO_MANY` is exposed as `MANY_TO_ONE` from the reverse perspective in the API response.

**Acceptance.** (a) Existing bidirectional links migrate cleanly: `GET /:apiName` returns the new fields with reasonable defaults, and `direction='reverse'` queries return the same data as before. (b) Setting `reverse_property_projection` correctly filters returned properties on reverse queries. (c) `reverse_actions_enabled=false` on a link type causes reverse-direction Add/Remove actions to fail with `REVERSE_ACTIONS_DISABLED`. (d) Cardinality view reversal works correctly. (e) Old `is_bidirectional` boolean still readable via the view for one release. (f) Reverse-direction `link_cdc` events carry `direction='reverse'` field (added to LT-B3 schema).

**Risk.** UI must be updated in parallel (LT-F1). Schedule LT-B6 and LT-F1 in the same release.

---

## LT-B7 — Mandatory Control Properties: extend mergeStage marking-union to link types

**Goal.** Match Palantir's MCP model: per-source-datasource markings on link rows, enforced at query time so users see only the edges they're cleared for. **Extend the Funnel's existing `mergeStage.ts` marking-union behavior** to cover link tables, rather than implementing parallel filtering.

**Spec.** *Prerequisite: LT-B1 (Iceberg M2M storage) and the markings layer.* Add `link_type.mandatory_control_property_id UUID NULL REFERENCES property(property_id)` — points to the property on either source or target object whose value carries the marking. Add `link_type.mcp_propagation_mode ENUM('source','target','union','intersection') DEFAULT 'union'` — how to derive the link's effective markings from source/target object markings. **The Iceberg link table's `markings ARRAY<STRING>` column is populated at write time per the propagation mode, using the same `union_markings()` helper `mergeStage.ts` uses for objects** — share the implementation, do not duplicate.

At read time, every resolver path injects a marking filter: for FK paths, `terms { 'markings': user_markings }` clauses on the OpenSearch query (with `minimum_should_match=link_type.mcp_required_count`); for Iceberg paths, `WHERE arrays_overlap(markings, ?user_markings)` predicate pushed into DuckDB. ClickHouse MVs gain a `WHERE has_all(user_markings, markings)` filter at the API layer. Crucially: filtering happens *server-side at the storage layer*, never client-side.

Add a "marking lineage" debugging endpoint `GET /:apiName/edge/:sourcePK/:targetPK/marking-trace` (admin-only) showing how the effective markings were computed. **For consistency with the Funnel's `bulkUpsertInstances` audit, marking decisions are logged to the same audit channel** the Funnel uses for object-level marking decisions.

**Acceptance.** (a) A link whose source object carries marking `RESTRICTED` does not appear in resolver results for a user lacking `RESTRICTED`. (b) Switching `mcp_propagation_mode='intersection'` correctly restricts edge visibility. (c) Marking-trace endpoint correctly explains the derivation. (d) Performance: marking filter adds <10% latency to FK forward lookups, <20% to M2M Iceberg lookups (measured against a 1B-edge benchmark). (e) Existing link types with no MCP configured behave unchanged. (f) Marking computation matches `mergeStage.ts` byte-for-byte for identical input sets — verified via shared test fixture.

**Risk.** Marking filter at the storage layer is the only acceptable enforcement — application-layer filtering is a security hole. Audit-test by attempting to bypass with crafted requests; every bypass must fail.

---

## LT-B8 — Object-level CDC topic, mirroring per-link CDC pattern

**Goal.** Today the Funnel has `object_edits` (the SoR table) and the per-link `link_cdc.<src>__<link>__<tgt>` topics, but no per-Object-Type CDC topic. Add **`object_cdc.<ot>` topics** mirroring the link pattern so cross-cutting consumers (downstream materialized views, derived properties, audit pipelines) can subscribe to object edits the same way they subscribe to link edits.

**Spec.** *Prerequisite: Funnel B1 — `object_edits` already exists.* This task does not create the table; it adds publishing. Every `INSERT INTO object_edits` from `editApplicator.applyEdits` additionally publishes an Avro event to `object_cdc.<object_type_api_name>`:

```
record ObjectEdit {
  string schema_version;            // "1.0.0"
  string event_id;
  long event_ts_micros;
  string ontology_id;
  string object_type_api_name;
  string primary_key;
  enum operation { CREATE, UPDATE, DELETE };
  union { null, map<string, bytes> } property_changes;  // changed properties only
  array<string> markings;
  string actor_principal_id;
  union { null, string } action_rid;
  union { null, string } correlation_id;     // ties to LinkEdit.correlation_id
  union { null, string } causation_id;
}
```

The publish happens inside the same Postgres transaction as the `object_edits` insert via the transactional outbox pattern (`object_cdc_outbox(event_id, topic, payload, published_at)`); a separate publisher process drains the outbox to Kafka with at-least-once semantics. **This is the same pattern `cdcLinkProducer.ts` uses for link edits** — share the publisher infrastructure.

Cross-cutting integration: an Action that modifies an object property *and* adds a link in one transaction emits both an `ObjectEdit` and a `LinkEdit` with the same `correlation_id`, allowing downstream consumers to reconstruct the full Action atomically. ClickHouse MVs `objects_<api_name>` are added per Object Type with the same DDL pattern as the existing per-link MVs.

**Acceptance.** (a) Every `editObject` action results in a Kafka event on `object_cdc.<ot>` with full provenance, within the same transaction as the `object_edits` insert (no inconsistency window). (b) The events match the Schema Registry contract. (c) ClickHouse `objects_<api_name>` MV stays within 5s of source-of-truth `object_instances`. (d) LT-B5's `pending` state correctly consults `object_edits`. (e) Cross-cutting: an action that modifies a property *and* adds a link emits both events with matching `correlation_id` — verified by a test that inspects both topics. (f) Outbox drain reliability: chaos-test by killing the publisher mid-drain; no event lost, no duplicates.

**Risk.** Volume on `object_cdc.<ot>` can be 10–100× link volume in typical ontologies. Provision Kafka partitions accordingly (rule of thumb: per-OT partition count = max expected concurrent writers × 2). Outbox table can grow large under indexer outages — add a retention job that prunes after `published_at < now()-7d`.

---

## LT-B9 — Pagination upgrade: search_after / point-in-time replacing offset tokens

**Goal.** Eliminate the deep-pagination O(offset) cliff. Match Quickwit's recommended search_after pattern.

**Spec.** Add a new pagination format `searchAfterToken` (base64-encoded `{sort_keys: [...], pit_id: "..."}`). The resolver and Search Around endpoints accept either `pageToken` (legacy offset) or `searchAfterToken`. When clients pass `?paginationMode=search_after`, the resolver uses Quickwit/OpenSearch `search_after` semantics: opens a Point-In-Time on the index, returns sort tiebreakers and pit_id in the next-page token, subsequent calls use both. Default `paginationMode=offset` for backwards compat for one release; flip default to `search_after` after frontend updates.

Hard cap on offset paging: `max_offset=10_000` (matching OpenSearch default) — beyond that, return `OFFSET_TOO_DEEP_USE_SEARCH_AFTER`. The `searchAfterToken` is opaque — clients must not parse it. PIT lifecycle: server tracks PITs in Redis with TTL (sharing the **same Redis instance the Funnel B7 overlay uses**, namespaced under `pit:`); auto-extends on every page request; closes proactively on `pageSize=0` or after final page. M2M Iceberg paths use a similar pattern via DuckDB cursors backed by an Iceberg snapshot ID + last-seen `(source_pk, target_pk)` tuple.

**Acceptance.** (a) Page through 1M results with `searchAfter`: each page returns in <300 ms p95, no degradation across pages. (b) Offset paging beyond 10k returns the typed error. (c) PIT expiration mid-pagination: client gets `PIT_EXPIRED`, opens a new pagination from page 1 explicitly. (d) M2M Iceberg pagination across 1B edges paginates without re-scanning. (e) Legacy `pageToken` clients continue to work unchanged within the offset cap. (f) PIT keys correctly TTL'd in shared Redis without colliding with overlay keys.

**Risk.** PIT in OpenSearch holds a snapshot of segments — long-lived PITs prevent segment merges and bloat disk. The 5-minute TTL is a balance; document operational impact.

---

## LT-B10 — Composite aggregation for link analytics, replacing terms_size=10000 truncation

**Goal.** Make `analyzeLinkType` return correct distributions at billion-row scale. The current `terms aggregation size 10000` returns approximate, often wrong, top-K.

**Spec.** Refactor `analyzeLinkType` to use OpenSearch composite aggregation paginated to completion (or to a configurable `max_buckets=100_000`). Compute exact `min`, `max`, `count`, percentiles via `tdigest` aggregation (mergeable across shards). For M2M Iceberg-backed links, push the analysis to DuckDB: `SELECT source_pk, COUNT(*) FROM iceberg_table GROUP BY source_pk`, with progressive pagination via `OFFSET ... LIMIT 100000` or the Iceberg-native incremental scan.

Return: `{total_source_objects, total_target_objects, total_link_count_exact: BIGINT, total_link_count_method: 'exact'|'approximate', sources_with_no_links_estimate, distribution: {min, max, avg, p50, p90, p95, p99, p99_9}, computation_method: 'composite_agg'|'iceberg_scan'|'sampling', sampled_fraction}`. For very large links (>10B edges) where exact analysis is too expensive, fall back to sampled analysis (bucket-uniform sample of `n=10000` source PKs, extrapolate distribution with confidence intervals) and clearly mark `total_link_count_method: 'approximate'`. Add `GET /:apiName/analysis?precision={exact|sampled|fast}`.

**Acceptance.** (a) On a 100M-edge link, `precision=exact` returns the exact count and a tdigest-based distribution with all percentiles, completing in <30s. (b) On a 10B-edge link, `precision=sampled` returns within 5s with marked confidence intervals on percentiles. (c) `precision=fast` returns metadata-only stats from Iceberg manifests in <500 ms (no row-level scan). (d) Returned distributions match (within tdigest's expected error of <1% relative) a ground-truth computed via `quantile_disc` over the full table. (e) Existing clients without `precision` parameter default to `sampled` to preserve current latency profile.

**Risk.** OpenSearch composite agg pagination has a `_search?size=0&aggs={...}` overhead on every page. For very-many-buckets scenarios, the Iceberg path is dramatically faster — route accordingly based on link size.

---

# D. Link Types — Frontend (10 tasks)

*[Frontend tasks LT-F1 through LT-F10 — most unchanged from v1, with the following revisions for Funnel alignment.]*

## LT-F1 — Link Type editor: full bidirectional model surface

*[Spec unchanged from v1; verified that backend LT-B6 schema additions are non-breaking and that the existing `is_bidirectional` checkbox path falls through correctly.]*

---

## LT-F2 — M2M edge browser with deep pagination

**Goal.** Let users browse the rows of an M2M link type beyond the 10k offset cliff, leveraging LT-B9's `search_after`.

**Spec.** Add a `Edges` tab to the link-type detail view (visible only for M2M cardinality). Render a paginated table of `(source_pk, target_pk, link_props..., markings, created_at)` from `GET /:apiName/edges?paginationMode=search_after&pageSize=100`. A "Load more" button at the bottom triggers the next page using the returned `nextSearchAfterToken`; auto-load on scroll-to-bottom (intersection observer). A search box at the top filters via `?sourcePK=` or `?targetPK=` (server-side filter, not client). A `Source object` column renders the source PK as a clickable chip that opens the object detail in a side panel; same for target.

A `Density indicator` at the top right shows `Total edges: ~1.2B (estimated)` from LT-B10's `precision=fast` endpoint, refresh button to recompute. **Add a freshness indicator that shows the CDC lag for this link's MV** (queries `/api/v1/funnel/clickhouse/cdc-lag?link=<this>`) — if lag >30s, render a "Showing data ~Xs old" notice. Empty state: friendly "No edges yet — actions or imports will populate this." Bulk actions (admin-only): export current filtered view to CSV (LT-B1's Iceberg path supports range scans, max 10M edges per export job).

**Acceptance.** (a) Scroll through 100 pages of 100 edges each (10k edges) without latency increase past page 10. (b) Filter by source_pk returns instantly (<300ms). (c) PIT expiration during long browsing: gracefully restarts pagination with a brief "Refreshing view…" spinner. (d) Density indicator matches LT-B10's `fast` endpoint result. (e) Mobile viewport renders the table as stacked cards. (f) CDC freshness indicator correctly uses the existing Funnel endpoint.

**Risk.** Long-lived PITs accumulate server-side. Frontend should explicitly close PIT on tab navigation away.

---

## LT-F3 — Search Around UI with cardinality estimate + escalation indicator

**Goal.** Surface LT-B2's estimate-then-escalate model so users understand why a query is slow (escalated to ClickHouse) or is returning truncated.

**Spec.** The Search Around modal (already exists for selecting hops) gains a `Estimated result size` line that calls a new `GET /:apiName/searchAround/estimate?...` endpoint which runs only the cardinality estimate (cheap). The line shows `Estimated: ~250k edges, will execute on ClickHouse (escalation threshold: 100k)` with a tooltip explaining the escalation. If estimate >1M, the form gets a prominent warning. A `Result mode` selector: `Auto (recommended)` (default), `Force Quickwit only`, `Force ClickHouse`. Post-execution, the result panel header shows `Returned 100k edges in 4.2s (escalated to ClickHouse)`. **If escalated to ClickHouse, also show the current CDC lag for the involved link MVs** so users know the data may be a few seconds stale relative to OpenSearch.

**Acceptance.** (a) Estimate line populates within 1s for any query. (b) Force-Quickwit mode rejects above-threshold queries client-side before submission. (c) Truncation warning is unmissable when result size approaches max_results. (d) Backend metadata correctly drives the post-execution display. (e) Power-user mode is hidden behind a `Show advanced` toggle. (f) CDC-lag display correctly aggregates lag across involved link MVs.

**Risk.** Cardinality estimate accuracy is best-effort; add a "± 30%" disclaimer.

---

## LT-F4 — Multi-hop traversal builder

*[Spec unchanged from v1, with one revision: each hop's cardinality estimate now also displays whether that hop will run on Quickwit or ClickHouse, matching LT-F3's pattern.]*

---

## LT-F5 — Link analytics dashboard

*[Spec unchanged from v1; ensure the dashboard's "Storage stats" sub-tab queries the Lakekeeper endpoint via the Funnel's existing `/api/v1/funnel/lakekeeper/info` with link-namespace filter, not a parallel endpoint.]*

---

## LT-F6 — Cardinality migration wizard

*[Spec unchanged from v1; reversibility window relies on Iceberg snapshot retention coordinated with LT-B1.]*

---

## LT-F7 — Marking-aware visibility filter

**Goal.** Surface LT-B7's MCP enforcement so users understand which links are filtered out by their access level.

**Spec.** In the link-type detail view and the M2M edge browser (LT-F2), add a marking summary banner: `You can see edges marked with: PUBLIC, INTERNAL. 1.2k edges are hidden from your view due to: RESTRICTED.` Hidden count is fetched server-side via a new `GET /:apiName/visibility-summary` endpoint. **The marking-trace dialog (admin-only) renders the propagation chain in the same visual style as the Funnel's `mergeStage` marking-derivation debug output** so admins moving between subsystems see consistent rendering.

**Acceptance.** (a) Visibility summary correctly reflects the user's effective markings. (b) Hidden counts are accurate to within ±5% for samples (server-side computation). (c) Marking trace correctly explains union/intersection/source/target propagation modes. (d) Banner is dismissible per session but reappears on page reload (compliance requirement). (e) Non-admin users cannot see marking trace; properly authz-gated. (f) Marking-trace rendering matches the Funnel's existing visual conventions.

**Risk.** Showing marking names to users may itself be sensitive. Add a deployment config `markings.show_names_in_ui ENUM('always','admin_only','never')` defaulting to `always`.

---

## LT-F8 — Orphan inspection dashboard

*[Spec unchanged from v1; orphan-state derivation correctly uses LT-B5's `pending` state powered by `applied_to_index_at`.]*

---

## LT-F9 — CDC freshness/lag indicator on link types (using existing Funnel endpoint)

**Goal.** Surface CDC lag from LT-B3 + LT-B7 + Funnel B10 so users can correlate "the link I just added isn't showing up" with "the indexer is 30 seconds behind."

**Spec.** Header of every link-type detail page renders a small freshness pill: green `Up-to-date` (lag <5s), yellow `Slight delay (15s)`, red `Significant delay (>2min)`. **Driven by the existing `GET /api/v1/funnel/clickhouse/cdc-lag` endpoint**, filtered to the relevant link type's MV. Hovering the pill shows a popover with per-backend lag breakdown. On the Edges tab (LT-F2), if a recently-added edge is not visible, a "Recent edits may not be visible yet" banner appears with the freshness info, refresh suggestion.

System-wide health view (admin only): `/admin/cdc-health` page showing lag across all link types — **embeds the same Grafana panels the Funnel exposes for `cdc_lag_seconds`** rather than rendering custom charts; one source of truth for SREs and link-type admins.

**Acceptance.** (a) Pill correctly reflects current lag, updated every 10s. (b) Lag thresholds match the Funnel's existing alert thresholds for consistency (Funnel alerts at >30s per the docs). (c) Edges tab banner appears when last_event_at > most recent visible edge in the table. (d) Admin view loads in <2s for ontologies with 100+ link types. (e) No PII in the CDC status response (just metadata). (f) Endpoint reuse confirmed via network-tab inspection — no new `/cdc-status` endpoint introduced.

**Risk.** Lag can spike during legitimate maintenance (compaction, schema migration). Add an "operational mode" annotation so users see "Maintenance: catching up" instead of generic alarm.

---

## LT-F10 — Replacement pipeline / schema cutover UI for link types (reusing Funnel's state machine)

**Goal.** Mirror the Funnel B9 dual-index cutover for link types when LT-B6 reverse-spec, LT-B7 markings, or other schema changes need a backfill. **Reuse the Funnel's existing replacement state machine and endpoints** — generalized in FNL-H4 to accept link-type targets — rather than implementing a parallel state machine.

**Spec.** When a link-type schema change requires a replacement, the save flow opens `<LinkReplacementWizard>`. Step 1: explanation of what's changing and why a cutover is needed. Step 2: backfill estimate. Step 3: schedule (start now / start at off-hours), soak period (default 7 days, slider 1–14, max matching the Funnel's max), auto-cutover threshold (default `diff rate <0.1% sustained 7d` matching Funnel default). Step 4: monitoring view — shows backfill progress %, live diff rate during soak, dual-write health.

**The wizard calls the same existing endpoints the Funnel uses for Object Type replacement, with a new `target_type='link_type'` query parameter** (added in FNL-H4): `POST /api/v1/funnel/replacement/start?target_type=link_type`, `POST /api/v1/funnel/replacement/<linktype>/complete-backfill?target_type=link_type`, etc. The state machine values (`LIVE → REPLACEMENT_BACKFILL → REPLACEMENT_SOAK → CUTOVER_PENDING → CUTOVER_COMPLETE → OLD_INDEX_DROPPED`) are identical to the Object Type case. Post-cutover: 48h instant-rollback button retained; after 48h, the old version is dropped. All actions audit-logged with reason text.

**Acceptance.** (a) Backfill estimate is within 30% of actual completion time. (b) Soak period correctly logs diff rate per hour to `replacement_diff_log` (the existing Funnel table). (c) Auto-cutover triggers only when sustained diff rate is below threshold for the configured duration. (d) Manual rollback within 48h is one click; after 48h is blocked with explanation. (e) Audit trail captures every state transition with actor. (f) State machine transitions match Object Type replacement exactly — verified by inspecting `object_type_active_index_version` rows for `target_type='link_type'` entries.

**Risk.** Soak period during high-churn windows may show artificially elevated diff rates. Add a `noise floor` config so churn under N events/sec is excluded from diff-rate calculations. Generalization of the state machine (FNL-H4) is a hard dependency — without it, this task cannot ship.

---

# E. Funnel Hardening (NEW — required for the 40 tasks above to work at Palantir scale)

*These tasks address gaps in the implemented Funnel that, if left unaddressed, would block one or more of the 40 Pipeline Builder / Link Types tasks from meeting their acceptance criteria. They are not "improvements to the Funnel for its own sake" — each is a dependency of a task above. The Funnel's own open-items list (workflow `continueAsNew()`, partition evolution, RisingWave) is acknowledged but not extended here unless it directly blocks a task in this spec.*

## FNL-H1 — `ObjectTypeFunnelWorkflow.continueAsNew()` for production scale

**Goal.** Address the Funnel's documented open item (`workflows.ts:91`): without `continueAsNew()`, event history grows unbounded past ~100 active Object Types, eventually hitting Temporal's 50k-event-per-workflow soft limit. **Required for LT-B1 (1B-edge link types) and PB-B8 (auto-fire on every deploy) — both of which dramatically increase the per-workflow event rate.**

**Spec.** Refactor `ObjectTypeFunnelWorkflow` to call `continueAsNew(...)` after every N completed runs (default N=100, configurable via `FUNNEL_WORKFLOW_CONTINUE_AS_NEW_THRESHOLD`). State carried across the boundary: `lastProcessedSignalId`, `runStats` (rolling counters used by SLIs), the per-Object-Type config snapshot. The Postgres `funnel_run` history is the durable record; Temporal history is an optimization. Add an integration test that simulates 500 successive signals and asserts the workflow completes without hitting Temporal's `WorkflowHistoryEventLimit` exception.

**Acceptance.** (a) Workflow completes 500 signals end-to-end without Temporal history-size exceptions. (b) `continueAsNew` boundary preserves all in-flight state — verified by killing Temporal worker mid-boundary and asserting resume from correct point. (c) Per-Object-Type SLI counters survive the boundary correctly. (d) Postgres state continues to be the durable source of truth.

**Risk.** Temporal `continueAsNew` semantics are subtle — search-attributes and signals-in-flight need careful handling. Allocate a week.

**Blocks:** LT-B1 (production scale), PB-B8 (auto-fire frequency).

---

## FNL-H2 — Add `correlation_id`, `causation_id`, `actor_user_id` to `object_edits` and surface in stage outputs

**Goal.** Today `object_edits` has `actor_user_id` but not `correlation_id` or `causation_id`. **LT-B3 (link CDC v2) and LT-B8 (object CDC topic) require these fields** to support cross-cutting Action replay and lineage-bound Markings.

**Spec.** Migration to add:
```sql
ALTER TABLE object_edits ADD COLUMN correlation_id UUID NULL;
ALTER TABLE object_edits ADD COLUMN causation_id UUID NULL;
ALTER TABLE object_edits ADD COLUMN action_rid TEXT NULL;
CREATE INDEX idx_object_edits_correlation ON object_edits(correlation_id) WHERE correlation_id IS NOT NULL;
```
Update `editApplicator.applyEdits` to populate all three fields from the request scope (correlation_id from the inbound HTTP request's `X-Correlation-Id` header or auto-generated UUID; causation_id from the upstream event if applicable; action_rid from the action workflow). The Merge stage propagates these into the Iceberg merged-snapshot summary metadata so they're queryable retroactively. Same migration applied to `link_edit` to maintain symmetry.

**Acceptance.** (a) Every Action that calls `applyEdits` produces `object_edits` rows with non-null `correlation_id` and `action_rid`. (b) Multi-edit Actions: all rows produced by the same Action share the same `correlation_id`. (c) Iceberg snapshot summary on the merged dataset contains the correlation_ids of all consumed edits. (d) `link_edit` rows produced in the same Action carry the same `correlation_id` as the corresponding `object_edits` rows.

**Risk.** Backfill of historical `object_edits` to populate correlation_id is impossible (information lost). Document that historical rows have NULL correlation_id and downstream consumers must tolerate that.

**Blocks:** LT-B3, LT-B8.

---

## FNL-H3 — Extend `funnel_signal.signal_type` enum with `pipelineDeployCompleted`

**Goal.** PB-B8 fires `sourceTransactionCommitted` to trigger Funnel Changelog after a pipeline deploy. That works but loses the provenance (was this triggered by a pipeline deploy or by an external source commit?). Add a dedicated signal type so consumers can distinguish, and so PB-F9's "Funnel runs triggered by this pipeline" panel can filter accurately.

**Spec.** Migration to add `'pipelineDeployCompleted'` to the `funnel_signal.signal_type` enum. The signal payload schema gains optional fields `triggered_by_pipeline_deployment_id UUID NULL`, `triggered_by_pipeline_id UUID NULL`. The Funnel workflow treats `pipelineDeployCompleted` exactly like `sourceTransactionCommitted` for orchestration purposes (same Changelog → Merge → Indexing → Hydration chain) — the distinction is preserved only in the audit trail. Add a `triggered_by_pipeline_deployment_id` column to `funnel_run` so `GET /api/v1/funnel/runs?triggered_by_pipeline_deployment_id=X` returns the relevant runs.

**Acceptance.** (a) `POST /api/v1/funnel/signals` with `signalType=pipelineDeployCompleted` is accepted and triggers the same workflow as `sourceTransactionCommitted`. (b) `funnel_run.triggered_by_pipeline_deployment_id` is correctly populated. (c) Filtering `GET /api/v1/funnel/runs` by pipeline deployment ID returns only the runs caused by that deploy. (d) Existing `sourceTransactionCommitted` consumers unaffected.

**Risk.** Trivial migration; main risk is forgetting to update consumer code in `temporal/workflows.ts` to handle the new signal type.

**Blocks:** PB-B8, PB-F9.

---

## FNL-H4 — Generalize replacement pipeline (`object_type_active_index_version`) to support link types

**Goal.** The existing replacement pipeline handles Object Type schema changes via `object_type_active_index_version`. **LT-F10 (link replacement wizard)** and **LT-B6 (bidirectional schema changes)** need the same machinery for link types. Generalize the state machine to accept link types as a target, rather than building a parallel state machine.

**Spec.** Migration to rename `object_type_active_index_version` → `active_index_version` and add `target_type ENUM('object_type','link_type') NOT NULL DEFAULT 'object_type'` and `target_api_name TEXT NOT NULL`. The PK becomes `(target_type, ontology_id, target_api_name)`. The replacement orchestrator (`services/quickwit/replacement/orchestrator.ts`) gains a `target_type` parameter and dispatches to the appropriate implementation: object-type backfill (existing) or link-type backfill (new code path that backfills the Iceberg link table from LT-B1 into a new ClickHouse MV version). All `/api/v1/funnel/replacement/*` endpoints accept `?target_type=` query parameter, defaulting to `object_type` for backwards compatibility.

The state machine values are unchanged (`LIVE → REPLACEMENT_BACKFILL → REPLACEMENT_SOAK → CUTOVER_PENDING → CUTOVER_COMPLETE → OLD_INDEX_DROPPED` / `ROLLED_BACK`), the diff_rate gate logic is unchanged. Only the *target* of the cutover changes (Quickwit alias for Object Types, ClickHouse MV alias for link types).

**Acceptance.** (a) Existing Object Type replacement flows continue to work without changes. (b) `POST /api/v1/funnel/replacement/start?target_type=link_type&link=foo` initiates a link-type backfill that creates a new MV version, dual-writes during soak, and cuts over correctly. (c) The `replacement_diff_log` table is populated for both target types. (d) Rollback works for both target types within 48h. (e) `GET /api/v1/funnel/replacement/<api>?target_type=link_type` returns correct state.

**Risk.** Backfill semantics for link MVs differ from Quickwit indexes (CH MV refresh vs. Quickwit split publishing). Implement carefully and write integration tests for both paths. Existing column rename has migration risk — coordinate with on-call.

**Blocks:** LT-F10, LT-B6 (when schema change requires replacement).

---

## FNL-H5 — Extend Writeback Overlay to link edits

**Goal.** The Funnel B7 overlay handles object edits with sub-1s visibility. **Link edits do not currently have an overlay** — when a user adds a link via an Action, the link is not visible until Funnel indexing catches up (seconds to minutes). LT-B5's `pending` state mitigates the symptom but not the cause. Add link-edge overlay support so Action-triggered link writes have the same sub-1s visibility as object writes.

**Spec.** Extend the `writebackOverlay.ts` API with `writeOverlayForLinkEdit(linkType, source_pk, target_pk, link_props, markings, operation)`. Inside `actions/editApplicator.ts`, in the same Postgres transaction as the `link_edit` insert, also call `writeOverlayForLinkEdit` to write a Redis key `overlay:link:<linktype>:<source_pk>:<target_pk>` with TTL = `quickwit_commit_timeout_secs * 3` (180s default, matching object overlay). At link-resolver query time (`linkResolverService.ts`), `mergeWithLinkOverlay()` consults overlay keys for any (source_pk, target_pk) pairs returned from the underlying query and overlays the most recent state. The sweeper (`overlay/sweeper.ts`) gains link-overlay handling: deletes `overlay:link:*` keys when the corresponding `link_edit.applied_to_index_at` is set.

Add SLI: `link_overlay_to_index_lag_p99` parallel to existing `overlay_to_index_lag_p99`, alert at >60s.

**Acceptance.** (a) An Action that adds a link: the link is visible in `linkResolverService.resolveLinks()` within 1s of the action returning, regardless of indexer lag. (b) Removing a link via an Action: the removal is visible within 1s. (c) Sweeper correctly deletes link-overlay keys after indexing catches up. (d) `link_overlay_to_index_lag_p99` metric exposed and alertable. (e) Existing object-overlay behavior unchanged.

**Risk.** M2M links can be high-volume — overlay key count can grow large. Add a per-link-type override on the TTL (default 180s, configurable to 60s for high-volume links) to manage Redis memory.

**Blocks:** LT-B5 (correct `pending` state), and the implicit user expectation that "I just added a link, where is it" doesn't require a 30s wait.

---

## FNL-H6 — Lakekeeper namespace bootstrap for `_pipeline.*` and `_links.*`

**Goal.** The Funnel's Lakekeeper bootstrap (`lakekeeperBootstrap.ts`) provisions the `_funnel.*` namespace. **PB-B4 needs `_pipeline.*` and LT-B1 needs `_links.*`** under the same warehouse — extend the bootstrap to provision them up-front so deploys don't fail on first attempt.

**Spec.** Update `services/funnel/lakekeeperBootstrap.ts` to additionally create namespaces `_pipeline` and `_links` under the warehouse during initial bootstrap. Idempotent (skip if exists). Update `POST /api/v1/funnel/lakekeeper/bootstrap` documentation to reflect the expanded scope. Add a `GET /api/v1/funnel/lakekeeper/namespaces` admin endpoint that returns the list of namespaces under the warehouse, useful for verifying setup.

**Acceptance.** (a) Fresh bootstrap on a new Lakekeeper instance creates all three namespaces. (b) Re-running bootstrap on an existing warehouse does not error. (c) `GET /api/v1/funnel/lakekeeper/namespaces` returns `["_funnel", "_pipeline", "_links"]` minimum. (d) PB-B4 and LT-B1 deploys succeed on first attempt without manual namespace creation.

**Risk.** Trivial. Main risk is missing the bootstrap step in production deployments — make it part of the standard deployment runbook.

**Blocks:** PB-B4, LT-B1.

---

# Cross-cutting acceptance gate (unchanged from v1)

Before any task above is considered "done," it must satisfy:

- **Tests.** Unit tests for pure logic (≥80% line coverage for new code), integration tests for cross-component flows (must run in CI under 5 min), property-based tests for any state transition logic (markings, cardinality, retraction).
- **Docs.** Every new endpoint documented in OpenAPI 3.1; every new database column explained in `docs/SCHEMA.md`; every new env var in `docs/CONFIG.md`. **Funnel-integration points additionally documented in `docs/funnel.md`'s cross-feature table.**
- **Observability.** Every new code path emits at least one Prometheus metric and one structured log line; every new endpoint contributes spans to the existing trace.
- **Backwards compatibility.** No breaking change to existing API shapes without a `v2/` prefix or a release-cycle deprecation window. Every feature flag has a documented sunset date.
- **Security review.** Any task touching markings, ACL, or RBAC requires a second engineer's sign-off and an updated threat model entry.
- **Performance regression.** CI runs a benchmark suite per subsystem; >10% regression on any tracked metric blocks merge.
- **Funnel-integration verification.** Any task that depends on a Funnel endpoint or Funnel data structure must have an integration test that exercises the actual Funnel path (not a mock), gated on the Funnel being healthy.

---

# Updated execution order

The execution order has been revised to land Funnel Hardening tasks early so they do not block downstream work.

1. **Funnel Hardening prerequisites (parallel):** FNL-H1, FNL-H2, FNL-H3, FNL-H6. **3 weeks.** No frontend work yet.
2. **Foundation (parallel):** PB-B1 (Temporal/dispatcher mirroring funnel pattern), LT-B1 (Iceberg M2M via Lakekeeper), LT-B3 (CDC v2 on existing per-link topics). **4 weeks.** Frontend not yet started.
3. **Compute swap:** PB-B2 (DuckDB sharing funnel pool), PB-B3 (Parquet outputs). **3 weeks.** Frontend: PB-F1 (WebSocket-based), PB-F4.
4. **Iceberg deepening:** PB-B4 (Iceberg via shared Lakekeeper), PB-B6 (snapshot pinning), LT-B2 (cap escalation via existing CH path). **4 weeks.** Frontend: PB-F2, PB-F3, LT-F3.
5. **Semantic completeness + Funnel link extensions:** FNL-H4 (replacement pipeline generalization), FNL-H5 (link overlay), LT-B4, LT-B5 (using existing applied_to_index_at), LT-B6, LT-B8 (object_cdc topics). **5 weeks.** Frontend: LT-F1, LT-F2, LT-F4, LT-F8.
6. **Security & analytics:** PB-B7 (RBAC reusing merge marking-helper), LT-B7 (MCP via mergeStage extension), LT-B10 (composite agg). **3 weeks.** Frontend: PB-F8, LT-F5, LT-F7.
7. **Streaming & operations:** PB-B5 (streaming with shared ThroughputGuard), PB-B8 (signal via existing endpoint), PB-B9 (observability matching funnel shape), PB-B10 (schema evolution firing schemaChanged), LT-B9. **4 weeks.** Frontend: PB-F5, PB-F6, PB-F7 (Funnel-aware), PB-F9 (Funnel-runs panel), PB-F10, LT-F6, LT-F9 (existing endpoint), LT-F10 (using FNL-H4).

**Total:** ~26 engineer-weeks of focused work for a 3-engineer team across roughly 9 calendar weeks of parallel execution. The Funnel Hardening tasks add 3 weeks vs. v1's 22 — a worthwhile cost given they de-risk every downstream task by ensuring the Funnel substrate can support them at scale.

---

*End of v2 specification. Codex review notes: every task that integrates with the Funnel now references the specific file (`mergeStage.ts`, `funnelDispatcher.ts`, `cdcLinkProducer.ts`, etc.) or endpoint (`/api/v1/funnel/signals`, `/api/v1/funnel/clickhouse/cdc-lag`, etc.) it depends on. If during implementation any of those references prove inaccurate (file moved, endpoint renamed, schema differs), update the task spec rather than working around it — the goal is one mental model across Pipeline Builder, Link Types, and Funnel.*