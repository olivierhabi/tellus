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