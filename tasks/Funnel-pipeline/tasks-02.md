
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