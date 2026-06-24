# Tellus Quiver — Implementation Task Specifications

> 20 production-grade task specifications (10 backend + 10 frontend) for delivering **Tellus Quiver** — a typed, reactive, dataflow analytical canvas bound to the Tellus Ontology, modelled on Palantir Foundry's Quiver. These specifications are written as contracts, not tutorials. An AI implementation agent (or a senior engineer) executing these tasks should produce a system that conforms to the blueprint document `tellus-quiver-blueprint.md` with full architectural fidelity.

---

## Global Conventions

These conventions apply to every backend and frontend task. They are not repeated per-task except where deviated from.

### Resource Identifiers
All RIDs follow `ri.<service>.main.<type>.<uuid>`.
- `ri.tellus-quiver.main.analysis.<uuid7>`
- `ri.tellus-quiver.main.dashboard.<uuid7>`
- `ri.tellus-quiver.main.visual-function.<uuid7>`
- `ri.tellus-quiver.main.template.<uuid7>` (legacy; new resources are dashboards)

UUIDs are UUIDv7 (time-ordered) for index-locality on Cassandra primary-key partitioning.

### Inter-service Communication
All inter-service calls are Conjure HTTP/JSON RPC. JVM clients use Dialogue with AIMD concurrency limiters, exponential-backoff retries (max 4 attempts, base 250 ms, max 4 s, jitter ±25 %), client-side load balancing, and JWT bearer authentication propagating user identity.

### State-Mutating Semantics
Every state-mutating endpoint MUST:
- Accept `Idempotency-Key: <uuid7>` header. Keys cached for 24 h in Redis (`tellus-quiver:idempotency:<key>` → `(rid, sequence, response_bytes)`).
- Accept `If-Match: <etag>` for resource-scoped updates. Conflict returns `412 Precondition Failed` with errorCode `VERSION_MISMATCH`.
- Return canonical Conjure error envelope: `{ errorCode, errorName, errorInstanceId, parameters }`.

### Authentication & Authorization
- All requests authenticate via short-lived JWT issued by Tellus Multipass (Keycloak-backed). Tokens carry `sub` (user RID), `org` (organization RIDs), `mks` (active markings), and `groups`.
- Internal service-to-service calls use service-account JWTs scoped via `aud=tellus-quiver-service`.
- Authorization is enforced at every resource boundary by querying Compass (`isAuthorized(userRid, resourceRid, operation)`) and OMS (`canApplyAction(userRid, actionTypeRid)`); results cached 30 s.
- Markings (CBAC) and Organizations (mandatory access controls) gate resource visibility before any business logic executes.

### Observability
- OpenTelemetry traces emitted with W3C `traceparent` propagation; sampler 1 % in prod, 100 % in dev.
- Metrics via Dropwizard Metrics → Micrometer → Prometheus exporter on `:7071/metrics`. All histogram metrics use `Timer` with sliding-window p50/p95/p99 reservoirs.
- Structured JSON logs via Witchcraft (`service.1.log` event format) with `traceId`, `spanId`, `userId`, `orgId`, `requestId`.
- Health endpoint: `GET /health` returns Witchcraft `HealthCheckResponse` per `palantir/witchcraft-api`.

### Database Migrations
- Flyway-style ordered migrations under `src/main/resources/db/migration/V001__init.sql`, `V002__...`.
- Additive only; column drops gated by feature flag and 2-release deprecation window.
- Every table has `created_at`, `updated_at`, `etag` columns; `etag` mutates on every write (truncated SHA-256 of full row).

### Error Code Taxonomy (Conjure ErrorType)
```
INVALID_ARGUMENT    400  CARD_TYPE_INPUT_MISMATCH, CYCLIC_DAG, MALFORMED_INSTRUCTION,
                         OBJECT_SET_LIMIT_EXCEEDED, TRANSFORM_TABLE_ROW_LIMIT,
                         INVALID_PARAMETER_BINDING, INVALID_VEGA_SPEC
NOT_FOUND           404  ANALYSIS_NOT_FOUND, CARD_NOT_FOUND, CANVAS_NOT_FOUND,
                         VERSION_NOT_FOUND, DASHBOARD_NOT_FOUND, VISUAL_FUNCTION_NOT_FOUND
PERMISSION_DENIED   403  INSUFFICIENT_PERMISSION, MARKING_REQUIRED,
                         LLM_TOOL_UNAUTHORIZED, ACTION_APPLY_FORBIDDEN
FAILED_PRECONDITION 412  VERSION_MISMATCH, ONTOLOGY_BRANCH_UNAVAILABLE,
                         ANALYSIS_LOCKED, OT_BASE_VERSION_TOO_OLD
DEADLINE_EXCEEDED   504  COMPUTE_DEADLINE_EXCEEDED, TS_HYDRATION_TIMEOUT,
                         OSS_QUERY_TIMEOUT, LLM_TIMEOUT
RESOURCE_EXHAUSTED  429  COMPUTE_QUOTA_EXCEEDED, RATE_LIMIT_EXCEEDED
CONFLICT            409  IDEMPOTENCY_KEY_REPLAY, OT_TRANSFORM_FAILED
INTERNAL            500  COMPUTE_BACKEND_ERROR, OMS_UNAVAILABLE, OSS_UNAVAILABLE,
                         CODEX_UNAVAILABLE
```

### Definition-of-Done — Universal
A task is Done when (and only when):
1. All listed deliverables merged behind a feature flag.
2. Unit tests ≥ 85 % branch coverage on new code.
3. Integration tests against ephemeral Docker-Compose stack (Cassandra, Postgres, Redis, mock OMS, mock OSS).
4. Conjure IR published to `tellus-conjure-registry` and consumed by at least one client.
5. Prometheus metrics defined, scraped, and visible in the Tellus Grafana folder `tellus-quiver`.
6. Runbook entry in `runbooks/tellus-quiver/<task-id>.md` with alert thresholds and SOPs.
7. ADR (Architecture Decision Record) filed under `docs/adr/`.

---

# BACKEND TASKS

---

## Task B1 — tellus-quiver-service Foundation & Analysis Document Storage

**Goal:** Stand up `tellus-quiver-service` with Analysis CRUD, RID allocation, Compass integration, and durable storage of Analysis documents.

**Owner service:** `tellus-quiver-service` (Witchcraft, Java 21, Gradle 8, gradle-conjure)

**Depends on:** Multipass (auth), Compass (filesystem), AtlasDB-on-Cassandra (storage)

### Deliverables
- New repo `tellus-quiver-service` initialized from `tellus-witchcraft-service-template`.
- Conjure API definition `tellus-quiver-api/src/main/conjure/quiver-service.yml`.
- Schema migrations `V001__init_quiver.sql` through `V003__indexes.sql`.
- Endpoints: `createAnalysis`, `getAnalysis`, `updateAnalysisMetadata`, `deleteAnalysis`, `listAnalysesInFolder`.
- Compass integration: every Analysis creation registers a `RESOURCE_TYPE=tellus-quiver-analysis` resource under the requested parent folder.
- Soft-delete with 30-day Trash window; hard-delete via Compass purge job.

### API Contract (excerpt)
```yaml
types:
  AnalysisRid: { alias: rid }
  AnalysisDocument:
    fields:
      rid: AnalysisRid
      parentFolderRid: rid
      displayName: string
      description: optional<string>
      notebookMetadata: NotebookMetadata
      cards: map<CardId, Card>
      canvases: list<Canvas>
      parameters: map<CardId, Parameter>
      currentVersion: long
      etag: string
      createdAt: datetime
      updatedAt: datetime
  CreateAnalysisRequest:
    fields:
      parentFolderRid: rid
      displayName: string
      description: optional<string>
      seedFromObjectSet: optional<ObjectSetReference>
      seedFromTemplate: optional<rid>
services:
  QuiverService:
    base-path: /quiver/api
    endpoints:
      createAnalysis:
        http: POST /analyses
        args: { request: CreateAnalysisRequest }
        returns: AnalysisDocument
      getAnalysis:
        http: GET /analyses/{rid}
        args: { rid: AnalysisRid, branch: optional<header<string>> }
        returns: AnalysisDocument
      updateAnalysisMetadata:
        http: PATCH /analyses/{rid}
        args: { rid: AnalysisRid, ifMatch: header<string>, request: UpdateMetadataRequest }
        returns: AnalysisDocument
      deleteAnalysis:
        http: DELETE /analyses/{rid}
        args: { rid: AnalysisRid, ifMatch: header<string> }
      listAnalysesInFolder:
        http: GET /folders/{folderRid}/analyses
        args: { folderRid: rid, pageToken: optional<string>, pageSize: optional<integer> }
        returns: AnalysesPage
```

### Data Model (Cassandra via AtlasDB)
```sql
CREATE TABLE quiver_analysis (
  rid                 TEXT PRIMARY KEY,
  parent_folder_rid   TEXT NOT NULL,
  display_name        TEXT NOT NULL,
  description         TEXT,
  created_by          TEXT NOT NULL,
  created_at          TIMESTAMP NOT NULL,
  updated_at          TIMESTAMP NOT NULL,
  current_version     BIGINT NOT NULL DEFAULT 0,
  etag                TEXT NOT NULL,
  document_blob_uri   TEXT NOT NULL,        -- pointer to Blobster blob
  is_deleted          BOOLEAN NOT NULL DEFAULT FALSE,
  deleted_at          TIMESTAMP,
  CHECK (current_version >= 0)
);
CREATE INDEX quiver_analysis_by_folder ON quiver_analysis (parent_folder_rid);
```
Documents > 1 MB are stored in Blobster; small documents inline in the row's `document_inline` BLOB column.

### Concurrency & Idempotency
- `createAnalysis`: `Idempotency-Key` mandatory; replays return identical RID.
- `updateAnalysisMetadata`: `If-Match: <etag>` mandatory.
- `deleteAnalysis`: `If-Match` mandatory.

### SLOs
- `getAnalysis` p99 ≤ 250 ms (cold), p99 ≤ 50 ms (warm).
- `createAnalysis` p99 ≤ 500 ms.
- `listAnalysesInFolder` p99 ≤ 300 ms for ≤ 1000 analyses per folder.

### Prometheus Metrics
```
tellus_quiver_analysis_create_latency_ms_bucket{outcome=success|failure}
tellus_quiver_analysis_get_latency_ms_bucket{cache=hit|miss}
tellus_quiver_analysis_size_bytes{percentile=p50|p95|p99}
tellus_quiver_analysis_active_total{org=...}
tellus_quiver_compass_register_failures_total
```

### Test Strategy
- Unit: document serialization round-trip; ETag stability.
- Integration: end-to-end create → get → update → delete; permission propagation from Compass.
- Property: random valid `AnalysisDocument` survives serialize → store → load → equality check.

### Out of Scope
- Card execution (Task B5).
- OT instructions (Task B3).
- Versioning beyond the trivial `currentVersion` counter (Task B4).

---

## Task B2 — Card DAG Model, Type System, and DAG Validator

**Goal:** Implement the canonical Card data model, the type system that gates input/output bindings, and the DAG validator that prevents cycles and type mismatches.

**Owner service:** `tellus-quiver-service` (library `tellus-quiver-dag-core`)

**Depends on:** B1

### Deliverables
- Java module `tellus-quiver-dag-core` with `Card`, `CardType`, `OutputType`, `InputSlot`, `Dag` classes.
- `CardTypeRegistry` — a registry (loaded via Java SPI) declaring, for every supported card type, its declared input slots and output type.
- `DagValidator.validate(AnalysisDocument)` returning a structured `ValidationResult`.
- A `topologicalOrder(Dag)` algorithm (Kahn's) returning the DAG in dependency order; throws `CYCLIC_DAG` on cycle.
- A `pruneUnreferencedCards(Dag, retainedRoots)` algorithm for canvas-removal reference counting.

### Card Type Registry (initial set)
```
OBJECT_SET                    inputs: {}                           output: OBJECT_SET
FILTER_OBJECT_SET             inputs: { src: OBJECT_SET, predicate: BOOLEAN_FORMULA }  output: OBJECT_SET
SEARCH_AROUND                 inputs: { src: OBJECT_SET, linkApiName: STRING }         output: OBJECT_SET
AGGREGATION                   inputs: { src: OBJECT_SET, group: ARRAY<STRING>, agg: ARRAY<AGG_SPEC> }  output: TRANSFORM_TABLE
TRANSFORM_TABLE               inputs: { src: OBJECT_SET | TRANSFORM_TABLE | MATERIALIZATION }  output: TRANSFORM_TABLE
MATERIALIZATION               inputs: { src: OBJECT_SET | TRANSFORM_TABLE }  output: MATERIALIZATION
JOIN_MATERIALIZATION          inputs: { left: MATERIALIZATION, right: MATERIALIZATION, on: ARRAY<STRING>, kind: JOIN_KIND }  output: MATERIALIZATION
EXPRESSION                    inputs: { ... formula references ... }  output: NUMBER | STRING | BOOLEAN | DATETIME
TIME_SERIES_PLOT              inputs: { src: OBJECT_SET | OBJECT, propertyApiName: STRING }  output: TIME_SERIES_PLOT
TIME_SERIES_CHART             inputs: { plots: ARRAY<TIME_SERIES_PLOT> }  output: TIME_SERIES_CHART
ROLLING_AGGREGATE             inputs: { src: TIME_SERIES_PLOT, window: DURATION, op: AGG_OP }  output: TIME_SERIES_PLOT
EVENT_SET                     inputs: { src: TIME_SERIES_PLOT, threshold: NUMBER, op: COMPARATOR }  output: EVENT_SET
NUMERIC_FORMULA               inputs: { ... }  output: NUMBER
BOOLEAN_FORMULA               inputs: { ... }  output: BOOLEAN
CATEGORICAL_CHART             inputs: { src: TRANSFORM_TABLE | OBJECT_SET, x: STRING, y: STRING }  output: CATEGORICAL_CHART
PIVOT_TABLE                   inputs: { src: TRANSFORM_TABLE | OBJECT_SET }  output: TRANSFORM_TABLE
VEGA_PLOT                     inputs: { spec: VEGA_SPEC, data: TRANSFORM_TABLE | OBJECT_SET }  output: VEGA_PLOT
PARAMETER_*                   inputs: {}  output: STRING|NUMBER|DATETIME|BOOLEAN
PROPERTY_VALUE_SELECT         inputs: { src: OBJECT_SET, propertyApiName: STRING }  output: STRING|NUMBER
ACTION_BUTTON                 inputs: { actionApiName: STRING, paramBindings: map<STRING, ANY> }  output: NONE
FUNCTION_CALL                 inputs: { functionRid: RID, paramBindings: map<STRING, ANY> }  output: <function-declared>
VISUAL_FUNCTION_CALL          inputs: { visualFunctionRid: RID, paramBindings: map<STRING, ANY> }  output: <visual-fn-declared>
AIP_GENERATE_RESULT           inputs: { context: ARRAY<CardId>, prompt: STRING }  output: ARRAY<Card>
```

### Validator Rules
1. Every `card.inputs[slot]` must point to an existing `cardId` whose `outputType` ∈ `cardType.declaredInputSlots[slot].acceptedTypes` (covariant; `OBJECT_SET` is acceptable wherever `TRANSFORM_TABLE` is, with implicit promotion).
2. The graph induced by `inputs` MUST be acyclic.
3. `parameter` cards have no inputs and no incoming edges.
4. `canvas.ordering[]` may only reference existing card IDs.
5. Total cards per analysis ≤ 500 (soft warn at 200).
6. Total canvases per analysis ≤ 50.

### Card ID Allocation
Card IDs are short alpha-numeric like `$A`, `$B`, ..., `$Z`, `$AA`, `$AB`, ..., generated by a per-analysis monotonic counter. The leading `$` is part of the ID. IDs are immutable for the life of a card; deleting a card does not free its ID.

### Test Strategy
- Property: random valid DAGs validate successfully; randomly mutated DAGs (introduce cycle, type mismatch) fail with the correct error code.
- Golden file: the 30 most common card combinations (object-set → filter → search-around → aggregation → chart) all validate.

### Out of Scope
- Card execution.
- OT (instructions emitted by edits, but Card definitions live here, not the protocol).

---

## Task B3 — Operational Transform Engine for Real-Time Collaboration

**Goal:** Implement the OT protocol (server-side state + transformer + WebSocket transport + instruction log) that lets multiple users edit the same Analysis document concurrently with deterministic convergence.

**Owner service:** `tellus-quiver-service` (subsystem `tellus-quiver-collab`)

**Depends on:** B1, B2

### Deliverables
- `Instruction` Conjure union with these variants:
  - `addCard(Card)`
  - `updateCardConfig({cardId, configJsonPatch, baseCardVersion})` — uses RFC 6902 JSON Patch
  - `bindInput({cardId, slot, sourceCardId})`
  - `unbindInput({cardId, slot})`
  - `deleteCard({cardId})`
  - `addCanvas(Canvas)` / `deleteCanvas({canvasId})` / `renameCanvas({canvasId, name})`
  - `placeCardOnCanvas({cardId, canvasId, position, size})`
  - `removeCardFromCanvas({cardId, canvasId})` — does NOT delete the card
  - `reorderCanvasCards({canvasId, ordering})`
  - `updateParameter({parameterId, valueJson})`
  - `setHidden({cardId, hidden})`
- Conjure endpoint `submitInstructions(rid, baseVersion, idempotencyKey, instructions)` returning `InstructionAck { newVersion, transformedInstructions }`.
- WebSocket endpoint `/quiver/api/analyses/{rid}/stream` (upgrades from HTTPS) for live broadcast.
- Server-side OT transformer: given `(localOps, remoteOps)` it returns `(localOps', remoteOps')` such that applying `localOps; remoteOps'` ≡ applying `remoteOps; localOps'`.
- Instruction log table `quiver_instruction_log` for replay and audit.
- Presence service (`tellus-quiver-collab/presence`): tracks `(userRid, analysisRid, cursorPosition, selectedCardIds)`; broadcasts to peers.

### Conflict Resolution Rules
- **Last-writer-wins** for `updateCardConfig` field-level when both clients edit the same JSON path; the loser's change is dropped and the loser is notified via the WebSocket as a `serverRebase` event.
- **Merge** for `bindInput` to different slots.
- **Tombstone** for `deleteCard`: any instruction that mutates a tombstoned card is dropped silently.
- **Reordering** for `placeCardOnCanvas`: positions of concurrent placements offset by ±32 px to avoid exact overlap.

### Data Model
```sql
CREATE TABLE quiver_instruction_log (
  rid               TEXT NOT NULL,
  seq               BIGINT NOT NULL,        -- monotonic per analysis
  instruction       JSONB NOT NULL,
  applied_by        TEXT NOT NULL,
  applied_at        TIMESTAMP NOT NULL,
  client_op_id      TEXT NOT NULL,          -- client-generated for dedup
  PRIMARY KEY ((rid), seq)
);
CREATE INDEX quiver_instruction_by_user ON quiver_instruction_log (applied_by);
```

### Endpoints
```yaml
submitInstructions:
  http: POST /analyses/{rid}/instructions
  args:
    rid: AnalysisRid
    baseVersion: header<long>
    idempotencyKey: header<string>
    body: list<Instruction>
  returns: InstructionAck
  errors: [VERSION_MISMATCH, OT_BASE_VERSION_TOO_OLD, OT_TRANSFORM_FAILED, MALFORMED_INSTRUCTION]
streamCollab:
  http: GET /analyses/{rid}/stream         # upgrades to WebSocket
  returns: stream<CollabEvent>             # appliedInstruction | presenceUpdate | serverRebase
```

### SLOs
- `submitInstructions` p99 ≤ 100 ms (no compute on this path).
- WebSocket end-to-end propagation p95 ≤ 200 ms within same region; ≤ 500 ms cross-region.
- OT transformer correctness: 0 divergent documents in a 1 M-instruction property test.

### Prometheus Metrics
```
tellus_quiver_ot_instruction_apply_latency_ms_bucket{type=...}
tellus_quiver_ot_transform_latency_ms_bucket
tellus_quiver_ot_conflicts_total{resolution=lww|merge|tombstone|reorder}
tellus_quiver_collab_active_sessions{analysisRid=...}
tellus_quiver_ws_disconnects_total{reason=client|server|timeout}
```

### Test Strategy
- **Property test**: random concurrent instruction streams from N=4 simulated clients, verify all clients converge to identical document.
- **Tombstone test**: client A deletes card while client B updates its config; B's update is dropped; both converge.
- **Out-of-order test**: deliver instructions in random order; transformer correctly rebases.
- **Replay test**: replay `quiver_instruction_log` from `seq=0` produces the canonical document.

### Out of Scope
- Permanent versioning / save/revert UX (B4).
- Compute on instruction apply (B5).

---

## Task B4 — Versioning, Working-State Autosave, and History

**Goal:** Implement immutable snapshot saves (named versions) and ephemeral working-state autosave keyed by URL fragment.

**Owner service:** `tellus-quiver-service`

**Depends on:** B1, B3

### Deliverables
- `quiver_analysis_version` table with full document snapshots.
- `quiver_working_state` table with short-TTL working state (24 h).
- Endpoints: `saveVersion`, `getVersion`, `listVersions`, `revertToVersion`, `createWorkingState`, `getWorkingState`.
- Diff utility for showing version history (`computeDiff(v1, v2) → DocumentDiff`).
- A weekly Cassandra TTL job purging working states past 24 h.

### Data Model
```sql
CREATE TABLE quiver_analysis_version (
  rid               TEXT NOT NULL,
  version           BIGINT NOT NULL,
  document_blob_uri TEXT NOT NULL,
  parent_version    BIGINT,
  saved_by          TEXT NOT NULL,
  saved_at          TIMESTAMP NOT NULL,
  message           TEXT,
  is_named_save     BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY ((rid), version)
) WITH CLUSTERING ORDER BY (version DESC);

CREATE TABLE quiver_working_state (
  rid               TEXT NOT NULL,
  state_id          TEXT NOT NULL,            -- 10-char URL fragment
  user_rid          TEXT NOT NULL,
  document_blob_uri TEXT NOT NULL,
  created_at        TIMESTAMP NOT NULL,
  updated_at        TIMESTAMP NOT NULL,
  expires_at        TIMESTAMP NOT NULL,
  PRIMARY KEY ((rid, state_id))
) WITH default_time_to_live = 86400;
```

### URL Fragment Format
Working-state IDs are 10-character base36 (`[a-z0-9]{10}`); ~3.6×10¹⁵ namespace, collision-free for any practical analysis lifetime.

### Endpoints
```yaml
saveVersion:
  http: POST /analyses/{rid}/versions
  args: { rid, ifMatch: header<string>, request: SaveVersionRequest { message: optional<string>, named: boolean } }
  returns: VersionInfo
revertToVersion:
  http: POST /analyses/{rid}/versions/{version}:revert
  args: { rid, version, ifMatch: header<string> }
  returns: AnalysisDocument
createWorkingState:
  http: POST /analyses/{rid}/working-states
  args: { rid, request: { fromVersion: optional<long> } }
  returns: WorkingStateInfo
```

### SLOs
- `saveVersion` p99 ≤ 1 s for ≤ 5 MB documents.
- `revertToVersion` p99 ≤ 500 ms.
- Working-state autosave throughput ≥ 100 writes/s/analysis (frontend debounces to 1/s in practice).

### Prometheus Metrics
```
tellus_quiver_save_version_latency_ms_bucket{named=true|false}
tellus_quiver_revert_latency_ms_bucket
tellus_quiver_working_state_size_bytes{percentile=p50|p95|p99}
tellus_quiver_working_state_ttl_purges_total
```

### Out of Scope
- Branching of analyses (defer to a later task; current scope reuses Tellus dataset/ontology branches via header propagation).

---

## Task B5 — tellus-quiver-compute-coordinator (Card Execution Planner & Router)

**Goal:** Stand up a new service that, given a `(analysisRid, cardId, parameterOverrides, branch)` request, plans the execution of the card and its upstream dependencies, fans out to the correct backend (OSS, Materialization, Codex, Functions, AIP), enforces deadlines, and returns a typed `CardResult`.

**Owner service:** `tellus-quiver-compute-coordinator` (new Witchcraft service)

**Depends on:** B1, B2; OSS, OMS, Codex-equivalent, MMDP, Functions service

### Deliverables
- New service repo `tellus-quiver-compute-coordinator`.
- `Planner` — given a `Dag` and a target `cardId`, returns the upstream subgraph in topological order, deduplicated.
- `Executor` — for each node, dispatches to the registered backend and caches results.
- `BackendRouter` — pluggable interface; registered backends for: OBJECT_SET (OSS), MATERIALIZATION (MMDP/Furnace), TRANSFORM_TABLE (in-memory Polars), TIME_SERIES (Codex), FUNCTION (Functions service), AIP (aip-logic-service).
- Result cache `quiver_card_output_cache` keyed on `(cardId, configHash, upstreamHashes, branch, ontologyVersion)`.
- Deadline enforcement: client supplies `X-Deadline: <isoInstant>`; coordinator propagates remaining budget to backends.

### Endpoint
```yaml
computeCard:
  http: POST /compute/cards
  args:
    request: ComputeCardRequest
  returns: CardResult
  errors: [COMPUTE_DEADLINE_EXCEEDED, COMPUTE_BACKEND_ERROR, OBJECT_SET_LIMIT_EXCEEDED, ...]

ComputeCardRequest:
  fields:
    analysisRid: rid
    cardId: CardId
    parameterOverrides: map<CardId, any>
    branch: optional<string>
    deadlineMs: long
    cacheBehavior: enum { READ_WRITE | READ_ONLY | BYPASS | REFRESH }
```

### Cache Key
```
hash = SHA256(cardId || configHash || sortedUpstreamHashes || branch || ontologyVersionForBranch)
configHash = SHA256(canonicalJson(card.config) + canonicalJson(parameterOverrides intersected with card's parameter dependencies))
```

### Data Model
```sql
CREATE TABLE quiver_card_output_cache (
  cache_key        TEXT PRIMARY KEY,
  result_type      TEXT NOT NULL,
  result_blob_uri  TEXT,                     -- for large results
  result_inline    BLOB,                     -- for small results (≤ 64 KB)
  computed_at      TIMESTAMP NOT NULL,
  expires_at       TIMESTAMP NOT NULL,
  hit_count        BIGINT NOT NULL DEFAULT 0
) WITH default_time_to_live = 3600;          -- 1 h base TTL; refreshed on hit
```

### SLOs
- Cache-hit p99 ≤ 50 ms.
- Cache-miss p99 ≤ 5 s for object-set cards (delegated to OSS), ≤ 30 s for materializations, ≤ 10 s for time-series.
- Cache hit-ratio ≥ 80 % on warm analyses.

### Prometheus Metrics
```
tellus_quiver_compute_latency_ms_bucket{cardType=...,backend=...,cache=hit|miss}
tellus_quiver_compute_errors_total{cardType=...,errorCode=...}
tellus_quiver_compute_cache_hit_ratio
tellus_quiver_compute_inflight{backend=...}
tellus_quiver_compute_deadline_exceeded_total{cardType=...}
```

### Test Strategy
- Backend mocks for OSS/Codex/MMDP, verify routing.
- Deadline propagation test: deadline = 100 ms; backend stub sleeps 200 ms; coordinator returns DEADLINE_EXCEEDED at the boundary.
- Cache invalidation test: ontology version bump invalidates dependent cards.

### Out of Scope
- Each backend's internals (B6, B7, B8).

---

## Task B6 — Object Set Card Execution (OSS Integration)

**Goal:** Implement execution for `OBJECT_SET`, `FILTER_OBJECT_SET`, `SEARCH_AROUND`, `AGGREGATION`, `PROPERTY_VALUE_SELECT`, `ACTION_BUTTON` card types via OSS (your Object Set Service).

**Owner service:** `tellus-quiver-compute-coordinator` (subsystem `quiver-objectset-backend`)

**Depends on:** B5; OSS, OMS, Funnel, Actions service

### Deliverables
- Adapter `OssObjectSetBackend` implementing `BackendRouter.handle(card, upstream)`.
- OSS client (Conjure-generated) with the following methods used:
  - `createTemporaryObjectSet(definition, branch) → TemporaryObjectSetRid` (24 h TTL).
  - `aggregateObjectSet(definition, groupBy, aggregations, mode=PREFER_SPEED, branch)`.
  - `searchAround(rootDefinition, linkApiName, branch)`.
  - `loadObjectSetPage(definition, pageToken, pageSize, branch)`.
  - `applyAction(actionApiName, paramBindings, ifMatch, branch)`.
- Limits enforcement (return `OBJECT_SET_LIMIT_EXCEEDED`):
  - Input set ≤ 100 K when targeting OSv1 storage.
  - Result ≤ 10 M for filter/search-around on OSv2.
  - Search-around depth ≤ 3 within a single coordinator request.
- Branch propagation header `X-Tellus-Branch: <branch>` on every OSS call.
- Action invocation: validates user has `applyAction` permission in OMS before delegating.

### Aggregation Mode
- Default `PREFER_SPEED`; `PREFER_ACCURACY` available via card config.
- Aggregation result shape: `TransformTable { columns: [...], rows: [...] }`.

### SLOs
- Object-set load (≤ 1000 rows) p99 ≤ 500 ms.
- Aggregation (≤ 100 K input, ≤ 10 groups) p99 ≤ 2 s.
- Search-around (depth 1, ≤ 100 K input) p99 ≤ 3 s.

### Prometheus Metrics
```
tellus_quiver_oss_query_latency_ms_bucket{operation=load|aggregate|search_around|filter}
tellus_quiver_oss_query_errors_total{errorCode=...}
tellus_quiver_oss_temporary_set_creation_total
tellus_quiver_oss_action_apply_total{outcome=success|failure}
```

### Out of Scope
- OSS itself (already implemented per Tellus prior work).
- Streaming-pipeline writeback (Funnel handles).

---

## Task B7 — Materialization & Transform Compute (MMDP/Polars)

**Goal:** Implement execution for `MATERIALIZATION`, `JOIN_MATERIALIZATION`, `EXPRESSION`, `PIVOT_TABLE`, `CATEGORICAL_CHART` cards.

**Owner service:** `tellus-quiver-compute-coordinator` (subsystem `quiver-materialization-backend`) + new sidecar `tellus-quiver-mat-runner` for heavy compute.

**Depends on:** B5; MMDP (your Apache Calcite + Arrow Flight SQL), Iceberg, Polars

### Deliverables
- Two execution tiers:
  - **Polars/DuckDB tier** (in-coordinator-process) for inputs ≤ 10 M cells (rows × columns) and ≤ 2 GB memory budget.
  - **Spark tier** (delegated to MMDP) for everything else.
- Tier selector based on declared input cardinality (from upstream cache hints) and configured thresholds.
- SQL synthesis: every materialization is compiled to a Calcite logical plan; Polars-tier translates the plan to a Polars LazyFrame; Spark-tier submits via Arrow Flight SQL.
- Iceberg snapshot pinning: every materialization records the Iceberg snapshot ID it read so cache invalidation tracks dataset commits.
- Result format: Arrow IPC streams returned via Blobster-stored URI for results > 1 MB; inline for smaller.

### Data Model Additions
```sql
ALTER TABLE quiver_card_output_cache ADD COLUMN iceberg_snapshots JSONB;
-- { "ri.tellus.main.dataset.<uuid>": <snapshotId>, ... }
```

### SLOs
- Polars-tier materialization (≤ 1 M rows) p99 ≤ 5 s.
- Spark-tier materialization p99 ≤ 60 s for 100 M rows.
- Join materialization (Polars-tier, two ≤ 1 M-row inputs, hash join) p99 ≤ 10 s.

### Prometheus Metrics
```
tellus_quiver_mat_compute_latency_ms_bucket{tier=polars|spark,operation=mat|join|pivot|expression}
tellus_quiver_mat_input_rows{percentile=p50|p95|p99}
tellus_quiver_mat_tier_selection_total{tier=polars|spark,reason=...}
tellus_quiver_mat_iceberg_snapshot_age_seconds
```

### Test Strategy
- Tier selection tests with synthetic workloads.
- Calcite plan equivalence: `plan(mat → join → pivot)` produces the same result whether evaluated in Polars or Spark (golden datasets).

### Out of Scope
- MMDP itself.
- Browser-side transform tables (frontend Task F5).

---

## Task B8 — Time-Series Card Execution (Codex Integration)

**Goal:** Implement execution for `TIME_SERIES_PLOT`, `TIME_SERIES_CHART`, `ROLLING_AGGREGATE`, `EVENT_SET`, `TIME_SERIES_FORMULA`.

**Owner service:** `tellus-quiver-compute-coordinator` (subsystem `quiver-timeseries-backend`)

**Depends on:** B5; Tellus Codex (your time-series store)

### Deliverables
- Codex client (Conjure) with operations:
  - `getSeries({objectRid|objectSetDefinition}, propertyApiName, timeRange, branch) → SeriesData`.
  - `aggregateSeries(seriesRefs, op, window) → SeriesData`.
  - `detectEvents(seriesRef, threshold, comparator) → EventSet`.
- Display-time bucketing to ≤ 1000 buckets per series; bucket op selectable (avg/min/max/sum/last/first).
- Per-axis hydration: a `TIME_SERIES_CHART` card with N axes triggers N independent hydration jobs that share no state — invalidating axis 1 does not invalidate axis 2.
- X-axis linking: chart-card config carries `xAxisGroupId`; coordinator propagates it to renderer (frontend handles synchronization).
- Cold-hydration handling: first query for a `(seriesRef, timeRange)` returns 202 with a hydration token; client polls until ready (timeout per global SLO).

### Data Model — none (Codex owns persistence)

### SLOs
- Warm hydration p99 ≤ 500 ms (≤ 1000 buckets).
- Cold hydration p95 ≤ 10 s.
- Rolling aggregate p99 ≤ 2 s for ≤ 1 M raw points.
- Event detection p99 ≤ 1 s for ≤ 1 M raw points.

### Prometheus Metrics
```
tellus_quiver_ts_hydration_latency_ms_bucket{state=warm|cold}
tellus_quiver_ts_buckets_returned{percentile=p50|p95|p99}
tellus_quiver_ts_event_detection_latency_ms_bucket
tellus_quiver_ts_hydration_timeouts_total
```

### Out of Scope
- Codex internals.

---

## Task B9 — AIP Integration (Generate / Configure / Assist)

**Goal:** Implement the LLM-orchestration surface used by Quiver: AIP Generate (NL → suggested cards), AIP Configure (NL → card-config patch), AIP Assist (chat).

**Owner service:** `tellus-quiver-compute-coordinator` (subsystem `quiver-aip-backend`) + integration with `tellus-aip-logic-service`

**Depends on:** B1, B2, B5; tellus-aip-logic-service, OMS, OSS

### Deliverables
- Three endpoints:
  - `aipGenerate({analysisRid, contextCardIds, prompt}) → stream<AipGenerateEvent>` (SSE).
  - `aipConfigure({analysisRid, cardId, prompt}) → stream<AipConfigureEvent>` returning a card-config JSON Patch.
  - `aipAssist({analysisRid, conversationId, message}) → stream<AipAssistEvent>` for chat.
- Tool registry exposed to the LLM with these tools (typed, manifest-driven per US12493473):
  - `object_query` — filter / aggregate / inspect / traverse for any configured object type.
  - `function_call` — invoke any allowed Tellus Function or AIP Logic function.
  - `apply_action` — invoke a deterministic action (bypasses LLM for the apply itself).
  - `update_application_variable` — set a `Parameter` card's value.
  - `command` — Quiver-specific: add a card, delete a card, bind input.
  - `ontology_context` — ontology look-up replacing legacy semantic-search tool.
- Property-value hints generator (for Generate): summarizes upstream object set's property domains (string: top-N distinct values; numeric: min/max/quantiles) with bounded sample size.
- Reasoning trace persistence: every Generate/Configure/Assist call writes a trace row for "View reasoning" UX.
- Authorization: every tool invocation passes through Tellus Multipass authorization for the *user* (not the service); `LLM_TOOL_UNAUTHORIZED` on denial.

### Data Model
```sql
CREATE TABLE quiver_aip_trace (
  rid              TEXT PRIMARY KEY,
  analysis_rid     TEXT NOT NULL,
  user_rid         TEXT NOT NULL,
  surface          TEXT NOT NULL,   -- GENERATE|CONFIGURE|ASSIST
  prompt           TEXT NOT NULL,
  trace_blob_uri   TEXT NOT NULL,
  tool_invocations JSONB,
  created_at       TIMESTAMP NOT NULL,
  total_tokens     INTEGER,
  cost_usd_micros  BIGINT
);
CREATE INDEX quiver_aip_trace_by_analysis ON quiver_aip_trace (analysis_rid, created_at DESC);
```

### SSE Event Schema
```
event: tool_call          { tool, input }
event: tool_result        { tool, output }
event: token              { delta }
event: card_proposal      { card }                # Generate
event: config_patch       { jsonPatch }           # Configure
event: assistant_message  { content }
event: done               { traceRid }
event: error              { errorCode, message }
```

### SLOs
- AIP Generate first-token latency p95 ≤ 2 s.
- AIP Configure end-to-end p95 ≤ 8 s.
- Tool invocation overhead (per call) p99 ≤ 200 ms beyond the underlying backend's latency.

### Prometheus Metrics
```
tellus_quiver_aip_first_token_latency_ms_bucket{surface=generate|configure|assist}
tellus_quiver_aip_tool_invocation_total{tool=...}
tellus_quiver_aip_tool_unauthorized_total{tool=...}
tellus_quiver_aip_tokens_used_total{surface=...,model=...}
tellus_quiver_aip_cost_usd_micros_total{surface=...,model=...}
```

### Test Strategy
- Deterministic LLM mocks return canned tool-call sequences; assert produced sub-DAG matches golden file.
- Tool-authorization tests: user without `applyAction` permission cannot invoke `apply_action` even when LLM proposes it.
- Property-value-hint cardinality bounds enforced (no PII leak via excessive sampling).

### Out of Scope
- LLM provider integration (`tellus-aip-logic-service` owns this).

---

## Task B10 — Dashboards, Templates (Legacy), and Visual Functions

**Goal:** Implement publishing of three Quiver-derived resource types: **Dashboards** (publishable views over an analysis with parameter inputs), **Visual Functions** (published reusable sub-DAGs), and **Templates** (legacy; create-only path retained for one release).

**Owner service:** `tellus-quiver-service`

**Depends on:** B1, B2; Compass

### Deliverables
- Resource registration in Compass for `tellus-quiver-dashboard` and `tellus-quiver-visual-function` (Templates already registered).
- Endpoints:
  - `publishDashboard(analysisRid, request) → DashboardRid`.
  - `getDashboard(rid) → Dashboard`.
  - `embedDashboardInObjectView(dashboardRid, objectViewRid, paramBindings)` — registers an embed-record in OE (Tellus Object Explorer).
  - `embedDashboardInWorkshop(dashboardRid, workshopModuleRid, paramBindings)` — registers an embed-record in Workshop.
  - `publishVisualFunction(analysisRid, request) → VisualFunctionRid`.
  - `getVisualFunction(rid) → VisualFunction`.
- A Visual Function's input/output type signature is derived from its declared exposed Parameter cards and the output type of its declared root card.
- Visual Function execution = inlining the sub-DAG into the consumer's coordinator request (no isolated-process boundary).
- Dashboard parameter-binding schema: `Map<String externalParamName, CardId internalParameterCardId>`.

### Data Model
```sql
CREATE TABLE quiver_dashboard (
  rid                  TEXT PRIMARY KEY,
  analysis_rid         TEXT NOT NULL,
  display_name         TEXT NOT NULL,
  parameter_schema     JSONB NOT NULL,
  current_version      BIGINT NOT NULL,
  etag                 TEXT NOT NULL,
  created_by           TEXT NOT NULL,
  created_at           TIMESTAMP NOT NULL
);
CREATE TABLE quiver_visual_function (
  rid                  TEXT PRIMARY KEY,
  analysis_rid         TEXT NOT NULL,
  display_name         TEXT NOT NULL,
  input_schema         JSONB NOT NULL,
  output_type          TEXT NOT NULL,
  root_card_id         TEXT NOT NULL,
  current_version      BIGINT NOT NULL,
  etag                 TEXT NOT NULL,
  created_by           TEXT NOT NULL,
  created_at           TIMESTAMP NOT NULL
);
```

### SLOs
- `publishDashboard` p99 ≤ 1 s.
- Dashboard load (parameters bound, all cards rendered) p95 ≤ 3 s for ≤ 50 cards.

### Prometheus Metrics
```
tellus_quiver_dashboard_publish_total
tellus_quiver_visual_function_publish_total
tellus_quiver_dashboard_embed_total{surface=object_view|workshop}
tellus_quiver_visual_function_inline_total
```

### Out of Scope
- Workshop / OE rendering of embedded dashboards (separate service teams own).

---

# FRONTEND TASKS

---

## Task F1 — App Shell, Routing, Auth, and Layout Skeleton

**Goal:** Stand up the `tellus-quiver-frontend` SPA with routing, Multipass auth, layout shell, and Blueprint.js theming.

**Owner module:** `tellus-quiver-frontend` (React 18, TypeScript 5, Vite, Blueprint.js v5, react-router v6)

**Depends on:** Tellus Multipass front-door

### Deliverables
- Routes:
  - `/quiver/analyses/:rid` — analysis editor.
  - `/quiver/analyses/:rid?state=:stateId` — working-state restore.
  - `/quiver/dashboards/:rid` — dashboard view.
  - `/quiver/folders/:folderRid/new` — create-analysis flow.
- Auth bootstrap: redirect to `/multipass/api/oauth2/authorize?client_id=tellus-quiver-frontend&...` on 401; cookie-based token (`TELLUS_TOKEN`) cleared on logout.
- Layout skeleton: top bar (analysis title, save button, branch indicator, presence avatars, share, AIP Assist trigger), left sidebar (canvases list + add-card panel), main area (canvas/graph viewport), right inspector (selected-card config), bottom toolbar (apply button, parameter values).
- Blueprint.js dark/light theme; system-preference default; user override persisted to local storage.
- Error boundary at the route level; Sentry-equivalent (your observability) integration.

### Concurrency
- Single-tab guarantee: BroadcastChannel-based detection that prevents two tabs from opening the same `(rid, userId)` working-state ID; second tab opens a read-only mirror.

### Test Strategy
- Cypress E2E covering login → open analysis → log out.
- Component tests for layout responsiveness (mobile breakpoint disables canvas mode).

### Out of Scope
- Canvas/graph rendering (F3/F4).
- State management (F2).

---

## Task F2 — Analysis Document State Management & OT Client

**Goal:** Implement the canonical client-side state model for an Analysis: a normalized store, the OT client engine, optimistic edits, and snapshotting for undo/redo.

**Owner module:** `tellus-quiver-frontend/state`

**Depends on:** F1, B1, B3

### Deliverables
- Redux Toolkit store (or Zustand-equivalent — pick one and document in ADR; recommended Redux Toolkit for OT determinism).
- Normalized slices: `cards: Record<CardId, Card>`, `canvases: Record<string, Canvas>`, `parameters: Record<CardId, Parameter>`, `meta: AnalysisMeta`.
- OT client engine:
  - Maintains `localPending: Instruction[]` (issued but unack'd).
  - On server confirm of remote instructions, transforms `localPending` against them and re-applies.
  - On 412 `OT_BASE_VERSION_TOO_OLD` from `submitInstructions`, performs full document re-fetch and rebases.
- Optimistic update pattern: every user edit immediately updates local state AND appends to `localPending`; visual indication ("saving" state) on the affected card until ack.
- Undo/redo stacks (per-user; size cap 100): undoable instruction set is the user's *own* instructions only.
- Selectors with reselect-style memoization for: `selectCardById`, `selectDownstreamCards(cardId)`, `selectVisibleCardsOnCanvas(canvasId)`.

### Public API (for other frontend modules)
```ts
interface QuiverStore {
  getCard(id: CardId): Card | undefined;
  getCanvas(id: string): Canvas | undefined;
  dispatch(instruction: Instruction): void;        // optimistic + queues to OT
  subscribe(selector, callback): Unsubscribe;
  undo(): void;
  redo(): void;
  getPendingCount(): number;
  on(event: 'rebased' | 'conflict' | 'desync', cb): Unsubscribe;
}
```

### Test Strategy
- Property test simulating two clients via shared in-memory transport: 1000 random instruction sequences, both clients converge to identical document.
- Undo/redo tests with concurrent remote edits (undo skips a card a peer deleted).

### Out of Scope
- WebSocket transport (F8).
- Card rendering (F5).

---

## Task F3 — Canvas Mode Renderer

**Goal:** Implement the spatial canvas: card positioning, drag, resize, pan/zoom, snap-to-grid, performance-tuned for 200+ cards.

**Owner module:** `tellus-quiver-frontend/canvas`

**Depends on:** F2, F5

### Deliverables
- A custom canvas (React + DOM-based, NOT a `<canvas>` element — needed for accessible card content) using CSS transforms for pan/zoom; cards are absolutely-positioned `<div>`s with `transform: translate3d(...)` for GPU compositing.
- Pan: middle-mouse drag, space-bar+drag, or two-finger pan.
- Zoom: ⌘/Ctrl-scroll, pinch; range 0.25× — 2.0×.
- Card placement: snap-to-grid (32 px); collision-free auto-layout for "auto-arrange" command.
- Resize: 8 directional handles per card; Shift maintains aspect ratio; live preview during drag.
- Multi-select: Shift-click, marquee rubberband; group move.
- Reference counting: removing a card from canvas issues `removeCardFromCanvas` instruction. Deleting a card that no canvas references shows confirmation dialog and issues `deleteCard`.
- Virtualization: only cards intersecting the viewport (+ 200 px overscan) are mounted; off-viewport cards rendered as low-detail placeholders.
- Visibility-driven evaluation: when a card enters the viewport (and analysis Load setting = `Visible`), dispatches `computeCard`. When it exits, evaluation is paused (cache result remains).

### Performance Targets
- 60 fps pan/zoom with 100 cards on viewport (M2 MacBook Air).
- 30 fps with 200 cards.
- Initial render p95 ≤ 1.5 s for 200-card analyses.

### Test Strategy
- Storybook: 50, 100, 200, 500-card synthetic analyses.
- Playwright: drag, resize, pan, zoom, marquee select.

### Out of Scope
- Graph mode (F4).
- Card content (F5).

---

## Task F4 — Graph Mode Renderer

**Goal:** Implement the graph view of the DAG with auto-layout and edge rendering.

**Owner module:** `tellus-quiver-frontend/graph`

**Depends on:** F2

### Deliverables
- Layout via `dagre` (Sugiyama hierarchical) by default; force-directed via `d3-force` as fallback for cyclic-suspect DAGs (validator should prevent, but defensive).
- SVG-based edge rendering with bezier curves; edge style indicates type compatibility (solid = native type, dashed = type-promoted).
- Node style indicates card type (icon + color from a 16-token type palette).
- Click on node selects card in shared state (canvas mode + inspector follow).
- Drag node = override layout for that node; relayout on demand.
- Edge hover shows the slot name (`src`, `predicate`, `linkApiName`, etc).
- Branch indicator badge per node when card resolves on a non-trunk branch.

### Performance Targets
- Initial layout ≤ 500 ms for 200-card DAGs.
- 30 fps interaction (drag, hover) at 200 cards.

### Out of Scope
- Editing the DAG from graph mode (allowed, but uses the same dispatch as canvas mode).

---

## Task F5 — Card Type Registry & Card Components

**Goal:** Implement the plugin-style card system: a registry of card types each with an editor, a renderer, and metadata; common card chrome.

**Owner module:** `tellus-quiver-frontend/cards`

**Depends on:** F2

### Deliverables
- TypeScript interface:
  ```ts
  interface CardPlugin<TConfig, TOutput> {
    type: CardType;
    icon: React.ComponentType;
    displayName: string;
    declaredInputs: Record<string, OutputType[]>;
    outputType: OutputType;
    Editor: React.ComponentType<{ config: TConfig; onChange: (c: TConfig) => void }>;
    Renderer: React.ComponentType<{ output: TOutput | undefined; config: TConfig; loading: boolean; error?: Error }>;
    suggest?: (upstream: Card[]) => CardSuggestion[];
  }
  ```
- Plugin implementations for the 26 card types in B2's registry.
- Common card chrome: header (icon, displayName, hidden-toggle, options menu), body (Renderer), footer (input bindings drawer, error indicator).
- Browser-side **Transform Table** engine (DuckDB-WASM recommended; hand-rolled JS as fallback): row limit 50 000, transformations applied sequentially, intermediate results memoized in IndexedDB.
- AIP Configure entry point on every card (button in header).

### Test Strategy
- Each plugin has a Storybook story + a Vitest snapshot test.

### Out of Scope
- Add-card UX (F6).
- Time-series renderer specifics (F7).

---

## Task F6 — Add-Card UX with Type-Directed Suggestions

**Goal:** Implement the "+" button and search bar that suggest cards filtered by upstream output type, plus a global library/marketplace browser.

**Owner module:** `tellus-quiver-frontend/add-card`

**Depends on:** F5, B9 (for AIP Generate), B10 (for Visual Function discovery)

### Deliverables
- "+" affordance on every card: opens a popover listing cards whose `declaredInputs[*].acceptedTypes` includes the source's `outputType`. Suggestions are sorted by relevance (per `CardPlugin.suggest`).
- Top-level "Add data" search that resolves object types, time-series-property card seeds, dataset references, Functions, Visual Functions; uses OMS + Compass + Functions registry endpoints.
- Library panel (right-sidebar tab): browses Functions, Visual Functions filterable by input type.
- AIP Generate entry point: free-text → call `aipGenerate` → preview suggested sub-DAG → user accepts or modifies before commit.
- Keyboard shortcut: `/` opens add-card search.

### Test Strategy
- Type-compatibility golden tests for every (sourceType, targetType) pair.
- AIP Generate: stub backend, assert suggested cards render in preview pane.

### Out of Scope
- Backend tool registry (B9 owns).

---

## Task F7 — Time-Series Plot Renderer

**Goal:** Implement the high-performance time-series plot with 1000-bucket downsampling, scrubber, multi-axis, x-axis linking, and per-axis hydration awareness.

**Owner module:** `tellus-quiver-frontend/timeseries-plot`

**Depends on:** F5, B8

### Deliverables
- Custom `<canvas>`-based renderer using OffscreenCanvas where supported.
- Display-time bucketing: receive ≤ 1000 buckets per series from backend; render LTTB-downsampled if >1000 (defensive).
- Multi-axis support: independent y-axis per plot or shared y-axis when units match (auto-detect).
- X-axis scrubber: drag to filter; wheel to zoom; double-click to reset; keyboard arrows to step.
- X-axis linking: charts sharing `xAxisGroupId` move together (driven via shared store slice).
- Tooltip on hover shows bucket value (configurable: range / min / max / average per Settings).
- Cold-hydration UX: skeleton placeholder + "Hydrating..." label; auto-retries the fetch when token resolves.
- Streaming mode: per-axis stream toggle wires up an SSE/WS subscription that pushes bucket updates without invalidating other axes.

### Performance Targets
- 60 fps scrubbing on 12-axis chart with 1000 buckets each.
- ≤ 200 ms re-render on x-axis range change (warm cache).

### Out of Scope
- Codex itself.

---

## Task F8 — Real-Time Collaboration Client (WebSocket + Presence)

**Goal:** Implement the WebSocket client, instruction streaming, presence (cursors, selections), and conflict UX.

**Owner module:** `tellus-quiver-frontend/collab`

**Depends on:** F2, B3

### Deliverables
- WebSocket client connecting to `wss://.../quiver/api/analyses/{rid}/stream`.
- Auto-reconnect with exponential backoff (1 s → 60 s); on reconnect, fetch full document and rebase pending instructions.
- Inbound event types:
  - `appliedInstruction` → routed to OT engine for transform & local apply.
  - `presenceUpdate` → cursor / selection broadcast.
  - `serverRebase` → user-visible "Your edit was rebased" toast with link to view diff.
- Outbound: `submitInstructions` over HTTP (not WS) for durable acks; presence updates over WS (ephemeral).
- Presence avatars in top bar (max 8 visible, "+N" overflow).
- Cursor rendering: each peer's cursor as a labeled flag at last-known-position (throttled to 10 Hz).
- Selection rendering: peer's selected card has a colored border in their assigned color (deterministic hash of userRid → palette of 12).

### Performance Targets
- Cursor update propagation p95 ≤ 200 ms.
- WebSocket reconnect storm tolerance: 100 simultaneous reconnects to one analysis; no client errors.

### Test Strategy
- 4-headless-browser Playwright orchestration: random concurrent edits, assert convergence after 60 s.

### Out of Scope
- OT transformer itself (in F2).

---

## Task F9 — AIP UI Surfaces (Generate / Configure / Assist) with Reasoning Trace

**Goal:** Implement the three AIP user-facing surfaces with streaming output, diff-apply UX, and reasoning trace viewer.

**Owner module:** `tellus-quiver-frontend/aip`

**Depends on:** F2, F5, B9

### Deliverables
- **AIP Generate**: free-text input → SSE-streamed response → rendered as a chain-of-thought (each LLM step is a labeled card with input/output) → final proposed sub-DAG previewed in a dimmed overlay → user clicks "Add to canvas" or "Modify and add" or "Discard".
- **AIP Configure**: triggered from any card's chrome → text input prefilled with placeholder ("Describe how to change this card") → SSE streams a JSON Patch → side-by-side diff (current config vs proposed config) → user clicks "Apply" (issues `updateCardConfig` instruction) or "Reject".
- **AIP Assist**: chat panel (bottom-right), conversation persisted server-side; messages stream in.
- Reasoning-trace viewer: drawer accessible from any AIP-generated card's options menu; shows tool calls, inputs, outputs, timings, total tokens, cost.
- Property-value-hint preview: when AIP Generate references object-set hints, show user a "What was sent to the LLM" expandable section (audit transparency).
- Tool-authorization errors render inline ("This action requires permission X — request access from your admin").

### UX Constraints
- Streaming is interruptible: user clicks "Stop" to cancel; backend abort signal sent.
- Generate's preview overlay is non-modal: user can pan/zoom canvas while preview is up.

### Test Strategy
- Mock SSE source replays canned token streams; snapshot test the resulting UI states.
- Diff-apply golden tests: 20 (currentConfig, jsonPatch) pairs; assert applied result matches expected.

### Out of Scope
- Backend LLM orchestration (B9).

---

## Task F10 — Dashboards Publisher, Parameter Binding, and Embed UX

**Goal:** Implement the UX for publishing Dashboards from an analysis, binding external parameters, and managing embeds.

**Owner module:** `tellus-quiver-frontend/dashboards`

**Depends on:** F1, F5, B10

### Deliverables
- "Publish as Dashboard" command: dialog selecting which canvases are exposed and which Parameter cards are external inputs. Inputs map to a JSON-schema generated from each Parameter's type.
- Dashboard preview mode (read-only) renders an analysis with parameters set externally.
- Embed-in-Workshop wizard: select target Workshop module, map Workshop variables → Dashboard parameters, save embed record.
- Embed-in-Object-View wizard: select target Object View, bind primary object to a Parameter card of type `OBJECT`, save embed record.
- Dashboard share UI: generates a shareable URL with parameters in query string; access controlled by Compass permissions.
- Dashboard versioning: every publish creates a new immutable version; consumers can pin to a version or follow latest.
- Visual Function publisher (sister flow): "Publish as Visual Function" exposes the input parameters and a chosen root card as the function's output.

### Test Strategy
- E2E: create analysis → add 5 cards including 2 parameters → publish dashboard → open dashboard URL → set parameters via query string → assert correct render.
- Permission test: revoke read on dashboard; URL returns 403.

### Out of Scope
- Workshop / Object Explorer rendering of embeds (other teams).

---

# Cross-Cutting Concerns

## Branch Propagation
Every backend operation that touches OMS / OSS / Codex / MMDP propagates the analysis's active branch via `X-Tellus-Branch: <branch>` header. Frontend reads the active branch from `tellus-branch-selector` (a shared component already used by other Tellus apps) and stamps it into all requests via Dialogue interceptor.

## Marking & Organization Enforcement
Compass's existing marking/org enforcement gates Analysis-level access. Per-card-output marking enforcement is **NOT** implemented in v1; if a user can read the Analysis, they see all card outputs. (Future work: per-card-output marking inheritance from upstream object sets.)

## Localization
- All user-facing strings via `tellus-i18n` (ICU MessageFormat); minimum locales `en-US`, `fr-FR`, `de-DE` at GA.
- Date/time rendering via `Intl.DateTimeFormat` with the user's timezone preference (Tellus account setting).

## Accessibility
- WCAG 2.1 AA: every card chrome action keyboard-accessible; canvas pan/zoom has keyboard equivalents; cards have ARIA roles `region` with `aria-label` from `displayName`; AIP streams announced via `aria-live=polite`.

---

# Delivery Sequencing (recommended)

Phase 1 (Foundation): B1, F1, F2, B2, B4
Phase 2 (Compute Core): B5, B6, F5, F3
Phase 3 (Collab): B3, F8, F4
Phase 4 (Time-series & Materialization): B7, B8, F7
Phase 5 (AIP & Publishing): B9, B10, F9, F6, F10

Each phase is feature-flagged behind `tellus.quiver.<phase>` flags. Phase 1 ships an Analysis editor with no compute; Phase 2 enables object-set/aggregation cards; Phase 3 enables multiplayer; Phase 4 enables time-series; Phase 5 enables AIP and publishing.

---

# Out of Scope for v1 (Documented for clarity)

- Branching of Analysis documents themselves (analyses always live on the trunk; ontology/dataset branches are propagated as queries, not as analysis branches).
- Per-card-output marking inheritance.
- Mobile-native canvas mode (mobile users get dashboard read-only).
- Quiver-as-a-tool exposure to AIP Agents (the reverse flow: AIP-using-Quiver-via-tool-call) is deferred.
- Custom card-type SDK for third-party developers (internal plugin registry only in v1).