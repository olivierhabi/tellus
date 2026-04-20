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

---