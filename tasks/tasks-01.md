# Implementing the Object Data Funnel in Tellus

**A staff-level specification for the `[Gena] All Orders → Changelog → Merge Changes → Indexing → OSv2` pipeline**

---

Before the task list, four framing notes I'd give any engineer picking this up cold.

**First, anchor on the right mental model.** The Funnel is a pipeline that *produces datasets*, and the search engine is a hydrator. Every stage writes an immutable, append-only Foundry-owned dataset. If you build the stages as "compute that writes to Elasticsearch," you've already failed the 1:1 goal — the output of each stage must be a materialized dataset (Iceberg table in your case) that the next stage reads independently. This makes stages resumable, debuggable, and swappable.

**Second, the "Object Type" is the unit of isolation.** One Temporal workflow per Object Type. One Quickwit index per Object Type. One merged dataset per Object Type. Resist any temptation to share pipelines across Object Types — the 1:1 match with Palantir requires this isolation, and it's how you'll scale past 100 Object Types without cross-contamination.

**Third, dual-writing is your safety net.** Every task below that changes the hot path assumes you keep Elasticsearch running in parallel until Quickwit is proven per Object Type. Don't cutover a single Object Type until its shadow-query diff rate is below 0.1% for seven days.

**Fourth, the backend tasks are ordered by dependency, not by theme.** Do them in order. The frontend tasks can be parallelized across a small team after frontend task F1 lands.

---

## Backend tasks (execute in order)

### B1 — Introduce Postgres as the System of Record for object instances and edits

**Goal:** Break the assumption that Elasticsearch owns object state. Every object instance and every user edit must be durable in Postgres before it touches any search index.

**Spec:** Create a polymorphic table `object_instances (ontology_id, object_type_api_name, primary_key, properties JSONB, markings TEXT[], source_datasource_id, source_transaction_id, last_modified_at, version BIGINT)` with `(ontology_id, object_type_api_name, primary_key)` as the PK and a `version` column bumped on every write. Create `object_edits (edit_id UUID, ontology_id, object_type_api_name, primary_key, property_api_name, new_value JSONB, edit_strategy ENUM('user_edit_wins','latest_wins'), actor_user_id, created_at, applied_to_merged_at TIMESTAMP NULL, applied_to_index_at TIMESTAMP NULL)`. Edits are append-only; never UPDATE. Create partial indexes on `applied_to_merged_at IS NULL` and `applied_to_index_at IS NULL` so the Merge and Index stages can cheaply scan pending work.

**Acceptance:** (a) Every Action writeback lands in `object_edits` inside the same DB transaction as the user-visible response. (b) `object_instances` is populated by the Merge stage, not the Action path. (c) You can shut down Elasticsearch and no edits are lost.

**Risk:** This is the foundation. If you skip it, every downstream task becomes a workaround. Budget 2 weeks for migration of existing ES-resident edits.

---

### B2 — Adopt Apache Iceberg as the dataset format for all Funnel-internal datasets

**Goal:** Replace your current `foundry_datasets` raw-file model with Iceberg so Changelog becomes a manifest diff instead of a file scan, and so you inherit snapshot isolation and atomic swaps for free.

**Spec:** Stand up an Iceberg REST catalog (Lakekeeper or Apache Polaris — both Apache 2.0, both production-ready as of 2026). Back the warehouse with S3 (MinIO in dev). Rewrite your dataset ingestion path so uploads land as Iceberg tables, not Parquet files in a directory. Use DuckDB's `iceberg` extension from Node via `@duckdb/node-api` for writes, or run a thin PyIceberg sidecar if you need partitioned writes (DuckDB's Iceberg writer has gaps on partition evolution). Every table must have `format-version=2` minimum, `write.delete.mode=merge-on-read` disabled for source datasets (we want copy-on-write semantics for backing datasources), and `history.expire.min-snapshots-to-keep=100` so you have time-travel depth for debugging. Register all Foundry-owned internal datasets (changelog, merged, index) under a namespace prefix `_funnel.<object_type_api_name>.*` so they're invisible to end users by default.

**Acceptance:** Every new dataset upload produces an Iceberg table with a snapshot. You can query `SELECT * FROM backing_datasource.orders FOR VERSION AS OF <snapshot_id>` and get historical state. Your existing raw-Parquet datasources are either migrated or explicitly flagged as legacy.

**Risk:** Iceberg writers in pure Node.js are immature. Budget for a PyIceberg sidecar if DuckDB's extension blocks you on partition evolution or schema evolution.

---

### B3 — Stand up Temporal and model the Funnel as a durable workflow per Object Type

**Goal:** Replace whatever ad-hoc orchestration you have (cron, BullMQ, axios-driven triggers) with Temporal workflows that give you durable state, retries, replay, and signals. This is the spine of the Funnel.

**Spec:** Deploy Temporal (self-hosted or Temporal Cloud). Use the TypeScript SDK on Node 22. Define one long-running parent workflow per Object Type: `ObjectTypeFunnelWorkflow(ontologyId, objectTypeApiName)`. This workflow listens on three signals: `sourceTransactionCommitted`, `editBatchPending`, and `schemaChanged`. On each signal, it spawns child workflows for the appropriate stage chain. Model each stage (Changelog, Merge, Indexing, Hydration) as an activity with its own timeout (Changelog: 1 hour, Merge: 2 hours, Indexing: 4 hours, Hydration: 30 minutes) and its own retry policy (exponential backoff, 5 attempts for Changelog/Merge, 3 for Indexing, 10 for Hydration). Pipeline state (current stage, objects indexed, errors) is persisted both in Temporal's history *and* projected into your Postgres `funnel_runs` table via a side-effect activity after each stage completes, because the frontend reads from Postgres, not Temporal.

**Acceptance:** Killing a Temporal worker mid-pipeline and restarting it resumes from the exact activity boundary. The `GET /v2/ontology/.../reindex/status` endpoint returns data from Postgres that reflects Temporal's state within 1 second.

**Risk:** Temporal's learning curve is real. Allocate 1 week for the team lead to internalize determinism rules (no non-deterministic code in workflows, all I/O in activities). The entire pipeline's correctness depends on getting this right.

---

### B4 — Build the Changelog stage as an Iceberg snapshot diff

**Goal:** Produce an append-only changelog Iceberg table per Object Type per datasource that captures every INSERT/UPDATE/DELETE since the previous run, derived from Iceberg snapshot metadata rather than full data scans.

**Spec:** Implement the `computeChangelog(objectTypeApiName, datasourceId, fromSnapshotId, toSnapshotId)` activity. Use Iceberg's `SnapshotScan` / incremental read via DuckDB's `iceberg_snapshots()` and `iceberg_scan(..., snapshot_id_from=..., snapshot_id_to=...)` to pull only changed files. For each changed row, emit `(primary_key, operation ENUM('INSERT','UPDATE','DELETE'), properties JSONB, source_transaction_id, source_commit_timestamp)` and APPEND to `_funnel.<object_type>.changelog.<datasource_id>` Iceberg table. Enforce Palantir's hard rule: **duplicate primary keys within a single source transaction fail the build**. Cross-transaction, "most recent transaction wins" is handled at Merge time — Changelog just records. For streaming sources, the activity is replaced by a long-running workflow that consumes Kafka with exactly-once checkpointing (commit Kafka offsets into the Iceberg table's snapshot summary so checkpoint and dataset commit are atomic). Throughput-cap streaming Object Types at 2 MB/s per type to match Palantir's own limit — this prevents a runaway source from swamping the indexer.

**Acceptance:** For a source dataset with 1B rows and a transaction that changes 100k rows, the Changelog stage completes in under 60 seconds and writes a changelog dataset of exactly 100k rows. Deletes are captured with `operation='DELETE'` and the full prior property set. A PK appearing twice in one source transaction causes the activity to fail with a clear error.

**Risk:** Iceberg incremental read is the efficient path; if you fall back to full scans at 1B rows you'll pay hourly Changelog costs. Verify the incremental path end-to-end before you scale.

---

### B5 — Build the Merge stage as a DuckDB multi-way join across datasources and edits

**Goal:** Produce a merged Iceberg dataset per Object Type that represents the current authoritative state: every PK joined across all backing datasources, with user edits overlaid per the configured conflict strategy.

**Spec:** Implement `mergeChanges(objectTypeApiName, changelogSnapshots[], editsBatch[])` activity. Load the previous merged snapshot as the base. Apply the changelog(s) from all N datasources (N up to 70 per Palantir's limit) via DuckDB SQL: one MERGE INTO statement per datasource, joined on PK. For edits, left-join `object_edits` rows with `applied_to_merged_at IS NULL`. Implement the two conflict strategies from Palantir's docs exactly: `user_edit_wins` (the default: once edited, a property is pinned against source updates; unedited properties track source) and `latest_wins` (requires a `source_timestamp` column on the datasource; edit wins iff `edit.created_at > source.source_timestamp`). Enforce the column-wise MDO rule: each property comes from exactly one datasource, hard-fail if config violates this. Compute effective markings per row as `array_agg(DISTINCT m)` across all contributing datasources' markings. Write output to `_funnel.<object_type>.merged` as a new Iceberg snapshot. After commit, UPDATE `object_edits SET applied_to_merged_at = now()` for consumed edits — do this inside an activity, not the workflow, so it's retry-safe.

**Acceptance:** A 10-datasource Object Type with 100M rows in the base merged dataset and 50k pending edits completes Merge in under 15 minutes. Conflict resolution is correct per the two strategies (write property-based tests that verify the Palantir semantics). Marking arrays are correctly unioned.

**Risk:** DuckDB on a single node tops out around 5B rows for a 10-way join. If you need to scale past that per Object Type, you'll need RisingWave or Spark — but most Object Types won't hit this, so don't pre-optimize.

---