# ADR — OSv2 Serving-Index Parity: P0 Slice (Truthful Ack, Tombstones, Link Outbox, Edge Index, Rollout Flags)

Date: 2026-08-02
Status: Accepted (landed; rollout default stays `legacy`)

## Context

Public object reads and link traversals did not yet match OSv2 semantics:

1. The funnel stamped `applied_to_index_at` when Quickwit was unreachable
   or the publish wait timed out — edits looked indexed while the serving
   index had never confirmed them, and the Redis overlay sweeper then
   retired the only read-after-write protection.
2. The streaming consumer dropped Debezium delete events
   (`if (op === "d") continue`) — deleted objects stayed queryable forever.
3. Link CDC was published after commit, fire-and-forget, with a producer
   that permanently disabled itself on first failure.
4. ClickHouse edge tables were plain MergeTree keyed by (source, target)
   without version/operation columns — REMOVE/RETRACT appended rows and
   removed edges remained visible; keys lacked tenant/ontology/branch.
5. Traversal security was fail-open: missing `object_instances` rows
   defaulted to visible and a security-backend error preserved results.
6. `linkStorageMigrator` flipped `storage_backend` even when the target
   migration failed; the only failure signal was a NULL timestamp.
7. The newer Quickwit/ClickHouse traversal implementation had zero
   production callers; many-to-many traversal parsed CSV files
   synchronously in request paths.

## Decisions

### D-92 — Acknowledgement is confirmed-or-nothing

`runIndexingActivity` waits for a published split past the batch Kafka
offset; on timeout it **rejects** with `QuickwitPublishTimeoutError`
(previously it returned whatever splits existed). Both entry paths
(`funnelDispatcher`, Temporal `activities`) have exactly three outcomes:
confirmed → stamp; backend unreachable → `funnel_indexing_deferred`
event (log + counter + gauges) and edits stay pending; mid-attempt
failure → same as unreachable. No four-way ambiguity.

`buildFullIndexBatch` (`funnel/indexingStage.ts`) closes the coverage
gap: pending edits not present in this run's merge output are re-read
from `object_instances` (or become DELETE tombstones if the instance is
gone), so a crash between merge commit and index stamp no longer loses
edits permanently.

Edit order rule: `markEditsAppliedToIndex` runs only after
split-confirmation, never in a deferred branch. The Redis overlay is
retained by the existing sweeper invariant
(`applied_to_index_at > createdAt`), which the truthful stamp makes safe.

### D-93 — Deletes are versioned tombstones, never filtered input

`transformTombstone` converts streaming deletes into tombstone beans;
`Osv2Sink` splits each batch into upserts + tombstones and throws when
there is no `deleteObjects` hook (loud failure preferred over silent
loss). The offset is only committed after attributed delivery; an
unattributable delete aborts with `StreamingDeleteUnattributableError`
and never commits.

### D-94 — The link-CDC outbox is atomic with the edit

`editApplicator.applyEdits` calls `stageLinkCdcEvent` on the same
`PoolClient` that inserts `link_edit` — commit-or-rollback together.
The old post-commit `void publishLinkCdc(...)` loop is deleted; the
Redis overlay remains post-commit as a read-after-write cache (never
the source of truth).

`startLinkCdcDrainer` (boot path, killed by
`LINK_CDC_DRAINER_DISABLED=true`) claims overdue rows
`FOR UPDATE SKIP LOCKED` and publishes with bounded exponential backoff
+ full jitter (250ms → 60s cap, ≤20 attempts), dead-letters exhausted
rows, and stamps `published_at` only on broker acceptance. The
kafkajs producer no longer permanently disables itself on a single
connect failure.

`published_at` means "handed to the broker" — **never** "visible in the
serving edge index". Action/indexing acknowledgement must not read it.

### D-95 — Versioned plus isolated edge identity

`link_<src>__<link>__<tgt>` is now:

```
ReplacingMergeTree(event_version)
ORDER BY (tenant_id, ontology_id, branch_id, source_pk, target_pk)
```

with `operation LowCardinality(String)`, `deleted UInt8`, `event_id`,
`event_version UInt64`, plus `cdc_offset`, `source_ts`, `ingested_at`.

The MV maps the full v2 payload (previously discarded
`operation`/`event_id`/`ontology_id`/... columns). `ensureLinkTable`
upgrades an existing plain MergeTree in place: rename to
`<name>__legacy_mergetree`, create versioned, copy with synthetic
versions from `max(cdc_offset)`. The legacy table is kept as the
rollback object for the window.

Traversal SQL uses argMax per identity + explicit isolation predicates;
`buildReverseSql` provides the symmetrical reverse projection. An older
ADD can never resurrect a REMOVE/RETRACT tombstone; duplicate deliveries
of the same (identity, event_version) are idempotent; a valid newer ADD
re-creates the edge.

`traverse.isolation` is **required** — an absent tenant/ontology/branch
would silently fan the query across scopes, so it throws.

### D-96 — Security fails closed at the endpoint

`dropPksUserCannotSee` / `defaultEndpointSecurityLookup`:

- PK absent from `object_instances` ⇒ **deny** (was: visible-by-default).
- security backend error ⇒ **withhold all results** with a warning, and
  bump `traversal_security_lookup_errors_total` (was: keep results).
- marking decision uses `userSees` AND-semantics per endpoint; denials
  bump `traversal_authorization_denied_total`.

Both edge-level (in-SQL) and endpoint-level (at the API boundary)
markings enforce the same AND rule, consistent with plan #§7.

### D-97 — Migrator flips the flag only on confirmed success

`migrateLinkStorage` now throws `STORAGE_MIGRATION_FAILED` (mapped to
500) when the sidecar is missing/unsuccessful or `sidecar.count !=
csv.count`, records `migration_failed_at` + `last_migration_error`, and
leaves `storage_backend` unchanged. Previously the row advertised an
Iceberg backend that had no data, so `/edges` went empty and analysis
lied about `computationMethod`.

### D-98 — Rollout is per-scope, never one switch

`serving_rollout(scope_kind, scope_key, mode)` with the resolution order
`capability → link_type → object_type → branch → ontology → tenant →
global env SERVING_STORE_MODE → code default 'legacy'`. Modes:

- `legacy` — unchanged pre-cutover path (rollback-safe default);
- `shadow` — run legacy + indexed, compare canonicalized digests,
  always return legacy; mismatches logged with counts + digests only;
- `indexed` — serve edges from the versioned ClickHouse index.

`src/services/serving/contracts.ts` defines `ObjectServingStore` /
`LinkServingStore` (+ `IsolationScope`, `VersionedEdge` with tombstones
+ `event_version`) so routes never see backend-specific logic; DI picks
the implementation per the current mode.

`maybeServingEdgeResolver` (shared by `routes/links.ts`,
`routes/objects.ts`, and `oss/productionDeps.traverse`) computes the
edgeResolver seam — honored inside
`linkResolverService.searchAround` (new `options.edgeResolver`).
Filters/pagination/security/response shape stay in `searchAround`,
so the public API contract is bit-compatible across modes.

## Schema changes

| file | contents |
|---|---|
| `src/migrations/153_link_cdc_outbox.sql` (+ `.down.sql`) | outbox for link CDC + pending/dead/lookup indexes |
| `src/migrations/154_link_migration_truthfulness.sql` (+ `.down.sql`) | `link_type.migration_failed_at`, `last_migration_error` |
| `src/migrations/155_serving_rollout.sql` (+ `.down.sql`) | per-scope rollout flag table |

Migration probe verified forward + rollback on a fresh PG.

## New modules / key files

- `src/services/funnel/indexingStage.ts` — `buildFullIndexBatch`, `recordIndexingDeferred`, pending gauges.
- `src/services/searchAround/linkCdcOutbox.ts` — `stageLinkCdcEvent`, `drainLinkOutboxOnce`, `startLinkCdcDrainer`.
- `src/services/serving/{contracts,servingFlags,shadowCompare,linkServingStore}.ts`.
- `src/services/searchAround/linkMaterializedView.ts` — versioned schema + in-place engine upgrade + `insertLinkRows`.
- `src/services/searchAround/clickhouseTraversal.ts` — argMax SQL, `buildReverseSql`, required isolation.
- Tests under `tests/{unit,funnel/integration}/{links,funnel}` — 27 new unit + 25 new lane-level integration specs.

## Test evidence (this session, lane times)

- `pnpm test:unit` → 292 files / 3712 tests, **pass**.
- Integration (real PG + Kafka + ClickHouse):
  - `link-cdc-outbox-integration` 3/3 (atomicity rollback proof, broker drain, idempotency);
  - `truthful-indexing-integration` 1/1 — Quickwit down: `applied_to_index_at IS NULL`, `indexed=false`;
  - `clickhouse-edges-integration` 3/3 — ADD/REMOVE/reADD lifecycle, cross-tenant empty, markings both directions;
  - `funnel-instances-overlay-integration` 7/7;
  - `failure-injection-integration` 10/10, `failure-injection-os-outage-integration` 1/1.
- Tarball snapshot: `…/opencode/tellus-recovery/tellus-p0-slice-20260802-064233.tgz` — captured because an
  external `git reset --hard` destroyed the uncommitted working tree
  mid-session; please reclaim previously stashed work before relying on
  any files not yet committed.

## Next steps (Phase 2 continuation)

1. High-throughput Quickwit hop for edges: `ot_link_*` index + confirmed
   acceptance criteria (hops ≤ 100k).
2. Apply the same serving-store rollout to object search/get — the
   ObjectServingStore contract is in place, wiring is the next slice.
3. End-to-end CDC topology smoke (Kafka-engine → CH) in the lane stack
   (image needs to be present in CI: `clickhouse/clickhouse-server:24.8-alpine`).
4. Soak-gate thresholds: `serving_shadow_indexed_latency_seconds`,
   `traversal_authorization_denied_total`, dead-letter rate, watermark
   lag; define per-environment SLOs before any `→indexed` promotion.
5. Benchmark suite (`tests/linkBenchmark.js` extension) for forward and
   reverse traversal at 1k / 100k / 1M edge fan-outs.
6. Rollout to `shadow` for staging tenants per the deployment sequence
   (in the ADR output), then promote `→indexed` after the soak window.
