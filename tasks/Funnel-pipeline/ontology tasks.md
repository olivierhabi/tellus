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

### B6 — Build the Indexing stage against Quickwit via its native Kafka source

**Goal:** Produce Quickwit splits (immutable Tantivy segments with hotcache footers) on S3 from the merged dataset. One Quickwit index per Object Type.

**Spec:** For each Object Type, create a Quickwit index named `ot_<object_type_api_name>` with a doc mapping derived from the Object Type's property definitions. Map `searchable=true` properties to `fast=false, indexed=true, stored=true`, `sortable=true` to `fast=true`, `filterable=true` to `indexed=true`. Map property types: string→text with `default` tokenizer, integer/long→i64, double/float→f64, boolean→bool, date/timestamp→datetime, geopoint→`LatLng`. Configure the index with a Kafka source consuming `merged.<object_type>` topic. Implement the Index activity as: (1) read new snapshots from the merged Iceberg table, (2) stream their rows as JSON docs into the Kafka topic feeding Quickwit, (3) wait for Quickwit's metastore to report splits published past the last Kafka offset. Use Quickwit's per-index `commit_timeout_secs=60` for interactive freshness. Configure merge policy to compact splits under 10M docs into mature splits of ~10M docs. After Quickwit publishes, UPDATE `object_edits SET applied_to_index_at = now()` for edits that were in this batch.

**Acceptance:** A merged dataset update of 1M rows publishes to Quickwit within 90 seconds and is queryable via Quickwit's search API. Deleting an object (operation=DELETE in changelog) is correctly absent from subsequent searches. Property flags in the Object Type editor demonstrably control index behavior (turn off `searchable`, verify full-text search on that property returns nothing).

**Risk:** Quickwit's delete-by-query cadence is hours-to-days — unacceptable for interactive edits. This is why B7 exists.

---

### B7 — Implement the Writeback Overlay (Redis + Postgres) for interactive edit visibility

**Goal:** Make user edits visible in search results within 1 second, despite Quickwit's slow delete cadence. This is the hardest architectural problem in the entire migration.

**Spec:** On every Action writeback, in the same API request handler: (1) insert into `object_edits`, (2) UPSERT into `object_instances` with the new property values, (3) write a record to Redis keyed as `overlay:<object_type>:<primary_key>` with value = full current object JSON and a TTL of `quickwit_commit_timeout_secs * 3` (so ~3 minutes). At query time in your Query API: run the Quickwit search, collect result PKs, MGET overlay keys from Redis for those PKs, and for any overlay hit *replace* the Quickwit-returned document with the overlay value. Also run a secondary Redis SCAN for overlay keys matching the query filters (for recent edits that haven't been indexed yet) and merge them into the result set. When Quickwit eventually indexes the edit (B6 finishes), the `applied_to_index_at` timestamp is set; a background sweeper deletes the overlay key if `applied_to_index_at > overlay.created_at`. Monitor `overlay_to_index_lag_p99` as a first-class SLI — if it exceeds 60 seconds, page.

**Acceptance:** A user edits an object and refreshes the Object Explorer — the new value is visible immediately. Shutting down the indexer for 10 minutes still shows correct edit values because the overlay TTL is honored. The overlay never serves stale data (staleness defined as: value older than the latest indexed version for that PK).

**Risk:** This is the system's correctness-critical component. Write an integration test suite that randomizes edit timing vs index publish timing and asserts eventual consistency + immediate visibility. Don't launch without this test.

---

### B8 — Implement the Hydration stage and search-node management

**Goal:** Reproduce Palantir's "download index files to search node disks" pattern using Quickwit's hot-cache and optional local split cache, with triggered cache warming.

**Spec:** Deploy Quickwit searchers as a StatefulSet in Kubernetes with local NVMe volumes (200 GB per searcher) mounted at `/quickwit/data/cache`. Enable Quickwit's `searcher.split_cache` with `max_num_bytes=180_000_000_000` (leave headroom). Implement a Hydration activity that, after an Indexing stage completes, issues Quickwit's split cache prefetch API for the newly published splits — this forces the download from S3 before first query hit, eliminating cold-start latency. Use rendezvous hashing (Quickwit does this automatically) to route a given split's queries to the same searcher consistently so the local cache is warm. For replacement pipelines (B9), Hydration targets a secondary set of searchers pre-warmed with the new index version before cutover.

**Acceptance:** P99 query latency for a 1B-row Object Type is under 500ms for typical filter+sort queries after Hydration completes. Cold queries (before hydration) are under 2s (range-GET path via hotcache). Killing a searcher and replacing it re-warms within 5 minutes.

**Risk:** Local disk provisioning in Kubernetes is operationally annoying. Have your platform team sign off on NVMe-backed StorageClasses before B3 starts, not when you're blocked at B8.

---

### B9 — Implement the Replacement Pipeline for schema changes (dual-index + soak)

**Goal:** Allow schema changes on an Object Type at 1B scale without blocking queries. This reproduces Palantir's patented dual-index cutover pattern (US11886410B2).

**Spec:** When an Object Type's schema changes (property added/removed, type changed, indexing flags changed), do not mutate the live Quickwit index. Instead, create a new Quickwit index `ot_<object_type>__v<N+1>`, run a full backfill from the merged Iceberg dataset into the new index, and *simultaneously* keep the live index updated via the normal Funnel. During backfill, the Indexing stage dual-writes to both indices. When the backfill completes, enter a "soak period" (default 7 days, configurable per-Object-Type up to 14 to match Palantir). During soak, queries shadow-execute against both indices and diffs are logged. If diff rate stays below 0.1% for the soak duration, an atomic alias flip (maintained in Postgres as `object_type_active_index_version`) cuts traffic over. Keep the old index online for 48 hours post-cutover for instant rollback, then drop. Heuristic for auto-triggering replacement pipeline: Palantir's published threshold is >80% of rows changed in one transaction — use the same.

**Acceptance:** Adding a new searchable property to a 1B-row Object Type completes the full replacement in under 24 hours with zero query downtime. A deliberately-induced diff (mutating a property in only one of the two indices) is detected within the soak period.

**Risk:** This is the second-hardest problem behind writeback. Get it right once and you can evolve schemas freely; get it wrong and your first schema change causes an incident.

---

### B10 — Implement Search Arounds with ClickHouse as the large-traversal fallback

**Goal:** Support graph traversals across link types with Palantir's two-tier model — Quickwit for hops up to 100k objects, ClickHouse for anything larger.

**Spec:** For hops ≤100k: use Quickwit's `search_stream` endpoint to stream u64 fast-field values (linked PKs) at 3M+ rows/sec, then feed as a `TermSet` filter into the next hop's Quickwit query. For hops >100k (detect by estimating cardinality from the first hop's aggregation): escalate to ClickHouse. Maintain a ClickHouse cluster (3 shards × 2 replicas) with materialized views per link type: `link_<source_type>__<link_name>__<target_type> (source_pk, target_pk, link_properties, markings[])`, refreshed from the same Kafka CDC stream that feeds Quickwit. Multi-hop traversals are expressed as ClickHouse SQL with JOINs; Quickwit returns the first-hop PK set, ClickHouse does the rest, final PK set goes back to Quickwit for the terminal search. Enforce markings at the API layer: subtract result PKs whose markings the requesting user lacks. Cap total returned rows at 100k to match Palantir's default; allow admin override up to 1M with warning.

**Acceptance:** A 3-hop traversal (Order → Customer → Account → Transaction) on a dataset where hop 1 returns 500k and hop 2 returns 5M completes in under 10 seconds. Same query with all hops under 100k completes in under 1 second using Quickwit alone.

**Risk:** ClickHouse materialized view refresh lag can desync link tables from the source of truth. Monitor per-link-type `cdc_lag_seconds` and alert at >30s.