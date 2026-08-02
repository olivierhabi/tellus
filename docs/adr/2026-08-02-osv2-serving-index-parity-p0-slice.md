# ADR — OSv2 Serving-Index Parity: P0 Slice (Truthful Ack, Tombstones, Link Outbox, Edge Index, Rollout Flags)

Date: 2026-08-02
Status: Accepted (committed; rollout default stays `legacy`)

Landed on `fix/automate-function-production-hardening` as commits
`3e4877b`, `1c995a5`, `8b492f0`, `a6b8bc8`, `3e65ff0`, `d5e48e9`
(verified from a clean checkout at `d5e48e9`). An interleaved
workstream (automate-functions hardening, `dff7601…9809d96`) shares the
branch; no foreign hunks are present in the six commits above.

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
- Tests: 6 new unit files (27 specs — truthful-indexing, streaming-tombstones,
  link-cdc-outbox, link-storage-migrator, serving-rollout,
  searchAround-edgeResolver) + expectation updates to 2 legacy suites
  (`funnel-b6-b8-unit`, `funnel-b9-b10-unit`, 63 specs re-verified) +
  3 new lane-level integration files (7 specs — link-cdc-outbox 3,
  truthful-indexing 1, clickhouse-edges 3).

## Test evidence (verified from a CLEAN CHECKOUT at `d5e48e9`, 2026-08-02)

- `pnpm exec tsc --noEmit` → **clean (exit 0)**.
- `pnpm test:unit` → 292 files / **3722 tests pass**.
- `pnpm exec eslint <all P0 files>` → 0 errors (2 pre-existing-style fs warnings).
- Integration (real PG + Kafka + ClickHouse, lane `tellus_tests`):
  `link-cdc-outbox-integration` 3/3 · `truthful-indexing-integration` 1/1 ·
  `clickhouse-edges-integration` 3/3 → **7/7 pass**.
- Migration probe 153/154/155: UP idempotent-reapply ✓, DOWN executes ✓,
  schema restored ✓ (transactional probe on `tellus_tests`).
- Pre-existing lanes re-run at `d5e48e9`: `funnel-instances-overlay` 7/7 ✓ and
  `failure-injection` 10/10 ✓; `failure-injection-os-outage` 0/1 — **fails
  IDENTICALLY at the pre-P0 base `335ec74` (not a P0 regression; environmental
  — the shared `tellus_tests` lane is used concurrently by another workstream;
  recorded as an open item).**
- Recovery note: the 06:42 tarball
  `…/opencode/tellus-recovery/tellus-p0-slice-20260802-064233.tgz` was verified
  **byte-identical for all 39 P0 files** against the working tree (the
  other agent's stash restore recovered them); no tarball extraction was
  needed. The other agent's in-flight files preserved untouched:
  `workflows.ts`/`mergeStage.ts`/`worker.ts`, functions/*, automate/*,
  migration 156, funnel `activities.ts` `objectsIndexed` hunk (absorbed
  into their commits separately).

## Claim → code traceability (all verified against the committed tree)

| ADR decision | Code path | Symbols / files | Tests proving it | Failure test | Rollout | Status |
|---|---|---|---|---|---|---|
| D-92 truthful ack | funnelDispatcher + temporal activities → indexing | `QuickwitPublishTimeoutError` (quickwit/indexingActivity.ts:151, throw :190); `recordIndexingDeferred`/`updatePendingIndexGauges` (funnel/indexingStage.ts:131,153) | truthful-indexing-unit; b6-b8-unit 'rejects with QuickwitPublishTimeoutError' | truthful-indexing-integration (applied_to_index_at NULL, indexed=false) | always-on | **Verified** |
| D-92 repair pass | indexing stage batch construction | `buildFullIndexBatch` (funnel/indexingStage.ts:44) | truthful-indexing-unit (repair-from-instances + gone-instance tombstone) | — (no live-Quickwit repair probe yet) | always-on | **Partial** |
| D-93 tombstones | streaming consumer → transform → sink | `transformTombstone`, `hashShard` (stage2-transform.ts:34,86); `StreamingDeleteUnattributableError` (streaming-consumer.ts:19); Osv2Sink loud-throw (osv2-sink.ts:50) | streaming-tombstones-unit (2) | unattributable-delete ⇒ no offset commit (unit) | always-on | **Partial** (sink→backend delivery not e2e-proven) |
| D-94 outbox atomicity | action txn staging | `stageLinkCdcEvent` (linkCdcOutbox.ts:60) called inside `applyEdits` txn (editApplicator.ts) | link-cdc-outbox-integration #1 (rollback leaves NO row) | same | always-on | **Verified** |
| D-94 drainer | outbox → broker | `drainLinkOutboxOnce` (:130), `startLinkCdcDrainer` (:228); backoff 250ms→60s, ≤20 attempts (:115-117); dead-letter | link-cdc-outbox-unit (5) + integration #2/#3 | broker-failure backoff + dead-letter unit | `LINK_CDC_DRAINER_DISABLED` | **Verified** |
| D-94 producer recovery | kafkajs producer lifecycle | cdcLinkProducer.ts:50-59 (no permanent disable on connect failure) | — (no dedicated reconnection test) | — | always-on | **Partial** |
| D-95 versioned edge schema | CH DDL + insert | `ensureLinkTable` `__legacy_mergetree` upgrade (linkMaterializedView.ts:116-141); `insertLinkRows` | clickhouse-edges-integration (ADD/REMOVE/re-ADD; engine upgrade in place) | — | build-time | **Verified** for insert/query; **Partial** for Kafka-engine live ingest (not e2e-wired) |
| D-95 active-edge projection + reverse | CH SQL | argMax-per-identity, `buildReverseSql` (clickhouseTraversal.ts; throw at :87-88) | clickhouse-edges-integration (forward+reverse, out-of-order re-ADD) | — | always-on for CH path | **Verified** |
| D-95 isolation required | CH SQL | `runClickHouseTraversal` throws without ontologyId/branchId (:83-88) | clickhouse-edges-integration (cross-tenant ⇒ empty) | cross-tenant probe (integration) | always-on | **Verified** |
| D-96 fail-closed security | endpoint screening | `defaultEndpointSecurityLookup` (searchAroundService.ts); deny-on-missing (:225); withhold-on-error + `traversal_security_lookup_errors_total` (:270); `traversal_authorization_denied_total` (:234) | clickhouse-edges-integration (markings both directions) | markings-denied probes (integration) | always-on | **Verified** for edge-serving path; **Partial** as global model (PG lookup still the backend; Stage-4 indexed markings pending) |
| D-97 migrator truthfulness | storage migration | `STORAGE_MIGRATION_FAILED` (linkStorageMigrator.ts:131; 500 in responseFormatter.ts:454; KNOWN_CODES in links.ts:111) | link-storage-migrator-unit (3) | sidecar-down + checksum-mismatch cases | always-on | **Verified** |
| D-98 rollout resolution | flag table | `resolveServingMode` (servingFlags.ts:51; order :53-61; env fallback :71) | serving-rollout-unit (10) | missing-table ⇒ legacy fallback | DB table `serving_rollout` | **Verified** |
| D-98 shadow compare | shadow mode | `compareShadow` (shadowCompare.ts:37); digests-only logs; `serving_shadow_compare_total`, `serving_shadow_indexed_latency_seconds` | serving-rollout-unit (canonicalization, mismatch, error-safe) | indexed-side error ⇒ mismatch, never throws | per-scope | **Partial** (no production traffic in shadow yet) |
| D-98 wiring | routes + OSS traverse | `maybeServingEdgeResolver` (linkServingStore.ts:131); routes/links.ts searchAround; routes/objects.ts (2 routes); oss/productionDeps.ts traverse (2 call sites); `edgeResolver` seam (linkResolverService.ts) | searchAround-edgeResolver-unit (2) | empty-store ⇒ well-formed empty response | mode=legacy ⇒ no-op | **Verified** (code-path); behavior change only under shadow/indexed |

Legend: **Verified** = code + dedicated positive AND failure test, run against
`d5e48e9` from a clean checkout. **Partial** = code + some tests, one or more
of the required proofs outstanding (named above). **Missing** = not started.

## Stage-3 addendum (2026-08-02 — link-index confirmation)

Implemented the read-after-write ack barrier:

* Migration `157_link_index_confirmation.sql`: `link_cdc_outbox.outbox_seq
  BIGSERIAL UNIQUE` (globally monotonic edge-event offset) +
  `link_edge_watermarks` per (tenant, ontology, branch, link type)
  observability table.
* `src/services/serving/edgeIndexWatermark.ts`: `confirmEdgeIndexVisibility`
  (SOUND per-event probing — a later seq can never mask an absent one) and
  `waitForLinkWatermark` (SOUND set-difference against published outbox
  rows ≤ minOffset; window-guarded by `WATERMARK_WINDOW_LIMIT`; throws
  `StoreWatermarkTimeout`). Metrics: `link_index_ack_wait_seconds`,
  `link_index_ack_deferred_total{reason}`, `link_edge_index_watermark`,
  `link_edge_index_lag`.
* `LinkServingStore.waitForWatermark` implemented (was interface-only).
* `editApplicator.applyEdits` (Step 6b) waits for confirmation when
  `LINK_INDEX_ACK_REQUIRED=true` (default OFF until the Kafka→CH ingest
  topology is live); timeout/outage ⇒ `linkIndexAck.confirmed:false`
  + deferred count — NEVER fabricated.
* Evidence: `tests/unit/serving/edgeIndexWatermark-unit.test.ts` (11),
  updated outbox unit (`RETURNING outbox_seq` + tx ff), integration
  `tests/funnel/integration/link-index-ack-integration.test.ts` (4/4):
  stage→drain→index→confirm chain on REAL PG+Kafka+CH (consumer stand-in
  = `insertLinkRows`, pending self-replacement by the MV once Stage 8
  wires it), deferred-on-outage, cross-scope invisibility, strict
  `StoreWatermarkTimeout`, and the watermark does not advance on failed
  confirmation.
* Lane self-containment: `tests/laneEnv.ts` now pins the ClickHouse
  credentials (the compose container requires `tellus`; anonymous is
  denied). #
   `waitForWatermark` is declared on both store interfaces
   (`serving/contracts.ts:74,132`, `StoreWatermarkTimeout` :82) but has
   **no implementation** — implement confirmed edge watermarks keyed by
   (tenant, ontology, branch, link type), wire Action completion to wait
   for the required edge version, defer on timeout/outage, and expose
   lag/wait/failure metrics. Do NOT treat `published_at` as visibility.
2. Object search/get: wire the ObjectServingStore contract the same way
   links are wired (rollout `legacy → shadow → indexed` per resource).
3. End-to-end CDC topology test (Kafka-engine → CH MV → LinkServingStore
   → public REST Search Around), image
   `clickhouse/clickhouse-server:24.8-alpine` (present locally;
   pin it in the CI lane config).
4. Soak-gate thresholds: `serving_shadow_indexed_latency_seconds`,
   `traversal_authorization_denied_total`, dead-letter rate, watermark
   lag; define per-environment SLOs before any `→indexed` promotion.
5. Benchmark suite (`tests/linkBenchmark.js` extension) for forward and
   reverse traversal at 1k / 100k / 1M edge fan-outs.
6. Rollout to `shadow` for staging tenants per the deployment sequence,
   then promote `→indexed` after the soak window; rollback = set the
   rollout row back to `legacy` (code default is rollback-safe).
7. Fix/flake-hunt `failure-injection-os-outage-integration` in the
   shared lane (fails identically at `335ec74`; lane is used
   concurrently — isolate or serialize with the other workstream).
