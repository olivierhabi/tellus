# Tellus Workshop — Implementation Tasks (10 Backend + 10 Frontend)

> Engineering-contract spec. Companion to the Tellus Workshop architecture spec, the 30-task Ontology v3 spec, and the 10-task Multipass auth spec.
> Scope: every interaction in the attached **Phase 5 (read-only) + Phase 6 (write-back)** Orders Inbox walkthrough must be implementable end-to-end after these 20 tasks land.
> Style: same as the v3 / Multipass specs — error names in `Tellus:Workshop:PascalCase` form, Conjure-style error envelope, Prometheus metric naming `tellus_workshop_*`, P50/P95/P99 SLOs, ETag/If-Match where mutating, explicit idempotency keys.
> Date: 2026-05-03.

---

## 0. Conventions (apply to every task unless overridden)

### 0.1 Error envelope (Conjure-format, identical to Ontology v3 spec)

```json
{
  "errorCode":       "INVALID_ARGUMENT" | "NOT_FOUND" | "CONFLICT" | "PERMISSION_DENIED"
                   | "FAILED_PRECONDITION" | "REQUEST_ENTITY_TOO_LARGE" | "INTERNAL" | "TIMEOUT",
  "errorName":       "Tellus:Workshop:<PascalCase>",
  "errorInstanceId": "<uuid v4>",
  "parameters":      { /* safe-to-log structured context */ }
}
```

Status mapping is identical to the Ontology v3 spec. Error names MUST be in `<Service>:<PascalCase>` form. Replica clients depend on `errorName`, never on text.

### 0.2 ETag scheme

`ETag: W/"<sha256(definition_jsonb || updated_at_micros)>"`. Returned on every read of a mutable resource; required as `If-Match` on every PUT. Missing or stale → `412 Precondition Failed` with `errorName: "Tellus:Workshop:ResourceVersionMismatch"`. Workshop never accepts blind PUTs.

### 0.3 Idempotency

All POSTs that allocate state accept header `Idempotency-Key: <uuid v4>`. Server stores `(idempotency_key, user_id, route, sha256(body))` for **24h** in Postgres table `idempotency_record`. Same key + same body → cached response; same key + different body → `409 Conflict` `Tellus:Workshop:IdempotencyKeyReused`.

### 0.4 Metric naming

Histograms ending in `_seconds`, counters ending in `_total`, gauges no suffix. Labels limited to low-cardinality dimensions. Per-RID labels are forbidden — use exemplars instead.

### 0.5 Branch awareness

Every Workshop call accepts optional `?branch=<branchRid>`. Default = main. Branch is forwarded verbatim on every downstream OMS / OSS / Functions / Actions call. **Forgetting to forward branch on any single path breaks Foundry-style branching for the entire app.**

### 0.6 Authentication

All endpoints require Multipass JWT bearer (per the auth spec). 401 on missing/expired; 403 on insufficient role. JWTs carry the user's CBAC markings; downstream services receive the same JWT (no service-account fan-out).

---

## 1. DAG Overview

```
                      ┌────────────────── Auth (Multipass) ──────────────────┐
                      └──────────────────────────────┬───────────────────────┘
                                                     │
                                         ┌───────────┴──────────────┐
                                         ▼                          ▼
       ┌──────────── Ontology / OMS / OSS / Actions (prior specs) ────────────┐
       │                                                                       │
       ▼                                                                       ▼
   B06 OMS bulk-meta proxy ◄──── B04 OM→Workshop bootstrap                    B09 Action-Type authoring
       ▲                                                                       ▲
       │                                                                       │
   ┌───┴───────────────────────────────────────────────────────────────────────┘
   │
   B01 Workshop Module Service (CRUD + ETag)
       ▲
       ├── B02 Schema validator + Variable-Graph compiler
       ├── B03 Versioning + Publish + /latest/ /dev/ resolver
       ├── B05 OSS Object-Set Load Proxy ──┐
       ├── B07 Filter Expression Compiler ─┤
       ├── B08 Aggregation Query endpoint ─┤
       └── B10 Action Apply + Refresh Bus ◄┘

                          F01 Editor Shell
                              │
                ┌─────────────┼──────────────┬──────────────┬─────────────┐
                ▼             ▼              ▼              ▼             ▼
              F02 Header   F03 Section   F04 Variable   F09 Button     F10 View-mode
                          /Layout       Runtime        Group + Action  + Modal +
                                        ▲              Binding UI      Refresh
                                        │
                  ┌─────────────────────┼──────────────┐
                  ▼                     ▼              ▼
              F05 Object Table     F06 Filter List  F07 Charts
                  └───────► F08 Object Set Title (active-object sink)
```

---

# PART A — BACKEND TASKS (B01 – B10)

---

## B01 — Workshop Module Service (CRUD + ETag/If-Match)

**Depends on:** Multipass auth (A0), Compass resource registry (T0).
**Service:** `workshop-service` (new).
**Maps to:** Phase 5 Step 1 ("Save" modal creating module), implicit save throughout Phase 5/6.

### Contract

```
POST   /workshop/api/v1/modules
GET    /workshop/api/v1/modules/{rid}
PUT    /workshop/api/v1/modules/{rid}                  (If-Match required)
DELETE /workshop/api/v1/modules/{rid}                  (If-Match required)
GET    /workshop/api/v1/modules?parentFolderRid=...&pageToken=...&pageSize=100
```

`POST` body:
```json
{
  "displayName":     "Olivier Orders Inbox",
  "description":     "",
  "parentFolderRid": "ri.compass.main.folder.<uuid>",
  "ontologyRid":     "ri.ontology.main.ontology.<uuid>",
  "branchRid":       null,
  "definition":      { /* initial empty module per §B02 schema */ }
}
```

`POST` response: `201 Created`, `Location: /workshop/api/v1/modules/<rid>`, `ETag: W/"..."`, body = full module document.

### DDL (Flyway `V101__workshop_module.sql`)

```sql
CREATE TABLE workshop_module (
  rid               TEXT PRIMARY KEY
                       CHECK (rid LIKE 'ri.workshop.main.module.%'),
  ontology_rid      TEXT NOT NULL,
  display_name      TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  description       TEXT CHECK (description IS NULL OR length(description) <= 2000),
  current_semver    TEXT NOT NULL DEFAULT '0.1.0',
  published_semver  TEXT,
  definition        JSONB NOT NULL,
  etag              TEXT NOT NULL,
  schema_version    INT  NOT NULL DEFAULT 4,
  parent_folder_rid TEXT NOT NULL,
  branch_rid        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by        TEXT NOT NULL,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by        TEXT NOT NULL,
  deleted_at        TIMESTAMPTZ
);
CREATE INDEX idx_module_ontology ON workshop_module(ontology_rid) WHERE deleted_at IS NULL;
CREATE INDEX idx_module_folder   ON workshop_module(parent_folder_rid) WHERE deleted_at IS NULL;
CREATE INDEX idx_module_branch   ON workshop_module(branch_rid) WHERE branch_rid IS NOT NULL;
```

### Concurrency

- PUT requires `If-Match: W/"..."`. Server takes `SELECT ... FOR UPDATE` on the row, recomputes ETag, compares, writes new definition + bumps `current_semver` (delegated to B03), mints new ETag, COMMIT.
- DELETE is soft (sets `deleted_at`); idempotent on repeated requests.
- Display-name uniqueness within `parent_folder_rid` enforced via partial unique index `UNIQUE (parent_folder_rid, lower(display_name)) WHERE deleted_at IS NULL`. Violation → `409` `Tellus:Workshop:ModuleNameConflict`.

### Errors

| errorName | HTTP | When |
|---|---|---|
| `Tellus:Workshop:ModuleNotFound` | 404 | `rid` unknown or soft-deleted |
| `Tellus:Workshop:ResourceVersionMismatch` | 412 | `If-Match` missing or stale |
| `Tellus:Workshop:ModuleNameConflict` | 409 | duplicate name in folder |
| `Tellus:Workshop:InvalidModuleSchema` | 400 | delegated to B02 |
| `Tellus:Workshop:OntologyNotFound` | 400 | `ontologyRid` unknown |
| `Tellus:Workshop:ParentFolderNotFound` | 400 | parent folder does not exist or user lacks Editor on it |

### Idempotency

POST creation accepts `Idempotency-Key`. Repeat with same body → same RID, 200 (not 201).

### Metrics

```
tellus_workshop_module_load_seconds{result}            histogram
tellus_workshop_module_save_seconds{result}            histogram   # save = PUT
tellus_workshop_module_create_seconds{result}          histogram
tellus_workshop_module_delete_seconds{result}          histogram
tellus_workshop_module_list_seconds                    histogram
tellus_workshop_module_etag_mismatch_total             counter
tellus_workshop_module_size_bytes                      histogram   # size of `definition` JSONB
```

### SLOs

| Op | P50 | P95 | P99 |
|---|---|---|---|
| GET | 60 ms | 180 ms | 450 ms |
| PUT | 100 ms | 250 ms | 600 ms |
| POST | 120 ms | 280 ms | 700 ms |
| LIST (page=100) | 80 ms | 220 ms | 500 ms |

### Edge cases

- `definition` JSONB ≤ **2 MiB**; reject larger with `413` `Tellus:Workshop:ModuleTooLarge`.
- Concurrent PUT race: only one wins; the loser MUST be told to refetch. Editor must surface "Your view is out of date — reload to keep editing." Never auto-merge.
- Folder-move is a separate Compass operation; Workshop service rejects PUT that changes `parentFolderRid`.

### Acceptance

- Phase 5 Step 1 "Save" prompt POSTs a module with the chosen name, gets back a `rid`, and the editor (F01) immediately renders.
- Every "Save and publish" click in Phase 5 Step 7 / Phase 6 Step 3 PUTs successfully against the captured ETag.

---

## B02 — Module Schema Validator + Variable-Graph Compiler

**Depends on:** B01.
**Service:** library inside `workshop-service`; also reusable by frontend via `/workshop/api/v1/modules/_validate`.
**Maps to:** every save in Phase 5/6 (defense in depth — F04 also enforces locally).

### Contract

```
POST /workshop/api/v1/modules/_validate
Body: { "definition": { ... } }
Response 200: { "valid": true, "compiled": { "varGraph": [...], "widgetTree": {...} } }
Response 400: standard error envelope
```

Same validator runs in-process inside B01 PUT/POST.

### Validation rules (must reject if any fails)

1. **JSON Schema 2020-12 conformance** to the Tellus Workshop module schema (per architecture spec §3). Schema doc shipped in repo at `/schemas/workshop-module-v4.json`.
2. **Variable IDs are unique** within `definition.variables`. Duplicate → `Tellus:Workshop:DuplicateVariableId`.
3. **Variable graph is a DAG** — Kahn's algorithm. Cycle → `Tellus:Workshop:VariableGraphCycle` with `parameters.cyclePath: [varId, ...]`.
4. **No orphan widget references** — every `widgets[*].id` is referenced exactly once by some section's `children[].ref`. Orphan → `Tellus:Workshop:OrphanWidgetReference`.
5. **No dangling variable refs** — every binding `inputs[k] = "v_xyz"` resolves to an existing variable. Dangling → `Tellus:Workshop:DanglingVariableReference`.
6. **Type compatibility** at every binding edge. Object Table input slot accepts only `objectSet`; Filter List output is `objectSetFilter`; "Filter using a variable" constraint on an `objectSet` variable accepts only `objectSetFilter`. Mismatch → `Tellus:Workshop:VariableTypeMismatch`.
7. **External-ID uniqueness** within `moduleInterface.variables` and within `routing.promotedExternalIds`. Duplicate → `Tellus:Workshop:DuplicateExternalId`.
8. **Loop / embed coherence** — `loopConfig.embeddedModuleRid` must resolve and its module-interface must be satisfied by `interfaceMapping`. Violation → `Tellus:Workshop:EmbeddedModuleInterfaceUnsatisfied`.
9. **Auto-generated active-object variable invariant** — when an Object Table widget exposes `outputs.activeObject = "v_table_1_active_object"`, that variable MUST exist with type `object` and `definitionType = widgetOutput`. (See Phase 5 Step 7.)

### Compiled artifact

The compiler emits `compiled.varGraph` as a topo-sorted list, each entry: `{ id, type, definitionType, deps: [varId], evaluator: <opaque payload> }`. Frontend uses this directly — no recompilation in browser hot path.

### Errors

All `errorCode = INVALID_ARGUMENT`, `400`. Each error includes `parameters` with enough context (varId, widgetId, path) for the editor to surface inline.

### Metrics

```
tellus_workshop_validate_seconds{result}               histogram
tellus_workshop_validate_failure_total{error_name}     counter
tellus_workshop_compile_var_count                      histogram
tellus_workshop_compile_widget_count                   histogram
```

### SLO

P50 ≤ 25 ms, P95 ≤ 80 ms, P99 ≤ 250 ms (CPU-bound, no I/O).

### Edge cases

- Hidden widgets still validate (validator does not consider runtime visibility).
- Module-interface `required: true` variables with no caller-provided value at runtime is a runtime concern, not a validation failure.
- Cycle detection is on the **definition graph**, not the runtime evaluation graph (the latter can have safe back-edges via events writing to vars).

### Acceptance

- Saving a module with a Filter List output bound back to its own input (Phase 5 Step 4 "Filter using a variable" misconfigured to point at itself) MUST be rejected with `Tellus:Workshop:VariableGraphCycle` and the cycle path returned.

---

## B03 — Versioning + Publish + `/latest/` `/dev/` Resolver

**Depends on:** B01, B02.
**Maps to:** Phase 5 Step 7 "Save and publish"; Phase 6 Step 3 "Save and publish" + "View".

### Contract

```
POST /workshop/api/v1/modules/{rid}/versions
       (called automatically on every PUT in B01; SemVer minor bump)
POST /workshop/api/v1/modules/{rid}/versions/{semver}:publish
GET  /workshop/api/v1/modules/{rid}/versions
GET  /workshop/api/v1/modules/{rid}/versions/{semver}
GET  /workshop/api/v1/modules/{rid}/resolve/latest        → published doc
GET  /workshop/api/v1/modules/{rid}/resolve/dev           → current doc
```

Default save behavior: minor bump (`0.1.0 → 0.2.0 → 0.3.0`). If autoPublish setting is on (default true), the `:publish` is called transactionally with the version create; otherwise the version is held as "draft."

### DDL (`V102__workshop_module_version.sql`)

```sql
CREATE TABLE workshop_module_version (
  rid           TEXT NOT NULL REFERENCES workshop_module(rid) ON DELETE CASCADE,
  semver        TEXT NOT NULL CHECK (semver ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  branch_rid    TEXT NOT NULL DEFAULT '',
  definition    JSONB NOT NULL,
  is_published  BOOLEAN NOT NULL DEFAULT false,
  saved_by      TEXT NOT NULL,
  saved_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  changelog     JSONB,
  PRIMARY KEY (rid, semver, branch_rid)
);
CREATE INDEX idx_mv_rid_published_branch
  ON workshop_module_version(rid, branch_rid, is_published)
  WHERE is_published;
```

### Resolution rules

- `/resolve/latest` returns the version with `is_published = true` and the highest SemVer for the active branch (or main if no branch). 404 if no published version exists yet → `Tellus:Workshop:NoPublishedVersion`.
- `/resolve/dev` returns the latest saved version regardless of publish state. Always exists for a saved module.

### Concurrency / idempotency

- `:publish` is idempotent — POST twice on the same `(rid, semver)` is a no-op `200`.
- Version create is sequenced under the same `SELECT ... FOR UPDATE` as the B01 PUT.
- SemVer bump is **monotonic**: `MAX(semver) + (0,1,0)`. Concurrent PUTs serialize naturally because of the row lock.

### Errors

| errorName | HTTP | When |
|---|---|---|
| `Tellus:Workshop:VersionNotFound` | 404 | semver doesn't exist on this branch |
| `Tellus:Workshop:NoPublishedVersion` | 404 | `/resolve/latest` with no publish history |
| `Tellus:Workshop:PublishOnDeletedModule` | 409 | publishing a soft-deleted module |
| `Tellus:Workshop:VersionAlreadyPublished` | 200 (not error) | second publish call — no-op |

### Metrics

```
tellus_workshop_publish_seconds{result}         histogram
tellus_workshop_resolve_seconds{kind}           histogram   # kind=latest|dev
tellus_workshop_version_create_seconds          histogram
tellus_workshop_published_versions              gauge       # per process
```

### SLOs

`resolve/latest` and `resolve/dev` are read-hot — P95 ≤ 80 ms, P99 ≤ 200 ms. Cache the resolved document in Redis with TTL 60 s, invalidate on publish via Redis pub/sub.

### Edge cases

- Republishing a previously-published older version is allowed (rollback) — must update `published_semver` on `workshop_module` to the published one and emit audit event `WORKSHOP_MODULE_ROLLED_BACK`.
- Branch-specific versions never auto-resolve from main — `?branch=` is required to see branch versions.

### Acceptance

- After Phase 5 Step 7 "Save and publish," `/resolve/latest` returns the just-saved version.
- After Phase 6 Step 3 "View" toggle, frontend hits `/resolve/dev` (since user is the editor) or `/resolve/latest` (if shared link).

---

## B04 — Ontology Manager → Workshop Bootstrapping Endpoint

**Depends on:** B01, B06, Compass.
**Service:** `workshop-service` + Ontology Manager UI.
**Maps to:** Phase 5 Step 1 — clicking "Create new" on the **Ontology Manager Overview page → Usage section → Workshop app card.**

### Contract

```
POST /workshop/api/v1/modules:bootstrapFromOntology
{
  "ontologyRid":      "ri.ontology.main.ontology.<uuid>",
  "branchRid":        null,
  "displayName":      "Olivier Orders Inbox",
  "parentFolderRid":  "ri.compass.main.folder.<uuid>",
  "seed": {
    "primaryObjectTypeApiName": "Order",     // optional but typical from OM context
    "createDefaultObjectSetVariable": true
  }
}
→ 201 Created, ETag, body = full module document including:
   - One pre-created object-set variable named "<TypeName> Object Set"
     bound to base set of `seed.primaryObjectTypeApiName`
   - Empty header widget placeholder
   - Empty root section
```

### Behavior

The bootstrap endpoint is the only Workshop creation path that gets to *seed* the module definition non-trivially. Direct B01 POST creates a truly empty module. The Ontology Manager surfaces a "Create new" button on the Usage card that calls this endpoint; the seeding eliminates the otherwise-tedious "create a base object-set variable" step that virtually every Workshop module begins with.

### Errors

| errorName | HTTP |
|---|---|
| `Tellus:Workshop:OntologyNotFound` | 400 |
| `Tellus:Workshop:ObjectTypeNotInOntology` | 400 |
| `Tellus:Workshop:PermissionDenied` (no Editor on parent folder) | 403 |

### Idempotency

`Idempotency-Key` required from caller (Ontology Manager UI generates a v4 UUID per click and retries on transport failure).

### Metrics

```
tellus_workshop_bootstrap_seconds{result, seed_kind}     histogram
tellus_workshop_bootstrap_seed_object_type_total          counter
```

### SLO

P50 ≤ 200 ms, P95 ≤ 500 ms, P99 ≤ 1.2 s. Most cost is the OMS lookup (B06) to verify the seed object type exists.

### Acceptance

- Phase 5 Step 1 ends with the Workshop canvas mounted. After this task, the module returned by bootstrap already has an `Order Object Set` variable in `definition.variables`, eliminating one editor step.

---

## B05 — OSS Object-Set Load Proxy (Workshop-facing)

**Depends on:** OSS service (T0).
**Service:** `workshop-service` thin proxy layer + paging cache.
**Maps to:** Phase 5 Step 3 (Object Table data fetch), Step 4 (filtered fetch), Step 7 (active object resolution from PK).

### Contract

```
POST /workshop/api/v1/objectSets:load
{
  "ontologyRid":   "ri.ontology.main.ontology.<uuid>",
  "branch":        null,
  "objectSet":     { /* OSS object-set definition node, see arch spec §6.2 */ },
  "select":        ["itemName", "assignee", "status", "...properties..."],
  "orderBy":       { "fields": [{"field": "orderDueDate", "direction": "asc"}] },
  "pageSize":      1000,
  "pageToken":     null,
  "executionMode": "PREFER_ACCURACY",     // default; PREFER_SPEED only if caller opts in
  "snapshotConsistency": false,
  "includeComputeUsage": false
}
→ 200 { "data": [...], "nextPageToken": "...", "totalCount"?: 5821 }
```

`totalCount` returned only when `executionMode = PREFER_ACCURACY` and the underlying OSS supports it; otherwise field is omitted.

### Behavior

- This is a thin proxy; it does **not** materialize objects — it streams OSS responses through. The proxy's only added value is: (a) enforcing default `executionMode = PREFER_ACCURACY`, (b) enforcing per-user rate limits, (c) injecting branch consistently, (d) recording per-module usage telemetry.
- Caller passes the **already-compiled** OSS objectSet definition node. The compilation from Workshop's variable-and-filter representation to OSS's node tree happens in B07; this endpoint accepts the post-compilation form.

### Concurrency / consistency

- No cache. OSS responses are pass-through. Callers wanting cached reads must use B07's compiled-set hash.
- `snapshotConsistency=true` is honored when paginating a large result so subsequent page loads see the same snapshot.

### Errors

| errorName | HTTP | When |
|---|---|---|
| `Tellus:Workshop:OSSObjectSetTooLarge` | 413 | per OSS, exceeds threshold for non-Spark eval |
| `Tellus:Workshop:OSSInvalidObjectSet` | 400 | malformed objectSet node |
| `Tellus:Workshop:OSSLinkTypeNotFound` | 400 | search-around to unknown link type |
| `Tellus:Workshop:OSSPermissionDenied` | 403 | row/property security policy denies access |
| `Tellus:Workshop:OSSTimeout` | 504 | downstream timeout (default 20s) |

### Rate limiting

100 req/s per user across all `/objectSets:load`. 429 with `Retry-After`. AIMD limiter on the OSS downstream client.

### Metrics

```
tellus_workshop_oss_load_seconds{object_type_api_name, result}      histogram
tellus_workshop_oss_load_rows                                        histogram
tellus_workshop_oss_load_bytes                                       histogram
tellus_workshop_oss_load_throttled_total                             counter
```

### SLOs

P50 ≤ 200 ms, P95 ≤ 800 ms, P99 ≤ 2 s for `pageSize ≤ 1000`. Larger pages must downgrade SLO linearly — caller responsibility to choose page size.

### Edge cases

- The Object Table widget (F05) loads `pageSize=500` by default for inbox-style lists; charts (F07) need `pageSize=10000` cap with `PREFER_SPEED` for aggregation drill-through.
- Empty object set → `200 { "data": [], "totalCount": 0, "nextPageToken": null }`. Frontend MUST handle.

### Acceptance

- After Phase 5 Step 3 binds the table to `Order Object Set`, the table is populated by a single call to this endpoint with the compiled base-set node.
- After Phase 5 Step 4 adds Filter List constraint, the same endpoint is called with the post-filter compiled node.

---

## B06 — OMS Metadata Bulk-Load Proxy

**Depends on:** OMS service (T0).
**Service:** `workshop-service` thin proxy + Redis cache.
**Maps to:** Phase 5 Step 3 ("Add all properties," column types), Step 4 (per-property filter type pickers), Step 7 (active object property bag), Phase 6 Step 1 (Action Type properties), Step 2 (Action Type picker).

### Contract

```
GET /workshop/api/v1/ontologies/{ontologyRid}/metadata?branch=...
→ 200 {
   "objectTypes":      [...],
   "linkTypes":        [...],
   "actionTypes":      [...],
   "queryTypes":       [...],
   "interfaceTypes":   [...],
   "sharedPropertyTypes": [...]
 }

GET /workshop/api/v1/ontologies/{ontologyRid}/objectTypes/{apiName}?branch=...
GET /workshop/api/v1/ontologies/{ontologyRid}/linkTypes/{apiName}?branch=...
GET /workshop/api/v1/ontologies/{ontologyRid}/actionTypes/{apiName}?branch=...
GET /workshop/api/v1/ontologies/{ontologyRid}/queryTypes/{apiName}?branch=...
```

The bulk endpoint is what the editor's pickers use; the per-name endpoints are for runtime resolution.

### Caching

Per-`(ontologyRid, branch)` Redis cache, TTL **30 s**. On OMS schema mutation (signaled via Redis pub/sub channel `oms.schema.invalidated`), cache is purged immediately.

### Errors

| errorName | HTTP |
|---|---|
| `Tellus:Workshop:OntologyNotFound` | 404 |
| `Tellus:Workshop:ObjectTypeNotFound` | 404 |
| `Tellus:Workshop:OMSTimeout` | 504 |

### Metrics

```
tellus_workshop_oms_bulk_seconds{result, cache}        histogram   # cache=hit|miss
tellus_workshop_oms_per_name_seconds{kind, result}     histogram
tellus_workshop_oms_cache_hit_ratio                    gauge
```

### SLOs

Bulk: P50 (cache hit) ≤ 20 ms, P95 ≤ 60 ms; (cache miss) P95 ≤ 400 ms, P99 ≤ 1 s.

### Edge cases

- Eventually-consistent OMS: a freshly-created Action Type (Phase 6 Step 1) may not appear in the editor's picker for a few seconds. The Action picker UI (F09) MUST display a "Recently created? Refresh" affordance that bypasses cache.
- Property-list responses can be large (object types with 250+ properties). Bulk endpoint paginates `actionTypes` and `queryTypes` only; object/link/interface/shared-property types are returned in full (per Foundry's `getOntologyFullMetadata` contract).

### Acceptance

- After Phase 5 Step 3 click "Add all properties," the editor has the property list with types/labels/icons available with no extra round trip.
- After Phase 6 Step 1 saves the Action Type, Step 2 picker shows it within 30 s (or immediately if user clicks Refresh).

---

## B07 — Filter Expression Compiler (Workshop FilterList → OSS Where-Clause)

**Depends on:** B05, B06.
**Service:** library inside `workshop-service`; exposed at `/workshop/api/v1/objectSets:compile` for client-driven compile + cache lookups.
**Maps to:** Phase 5 Step 4 — every filter UI type translates to OSS predicate nodes; "Filter using a variable" constraint propagates filter outputs back into the source object-set definition.

### Compiler input

```json
{
  "ontologyRid":          "...",
  "branch":               null,
  "baseObjectSet":        { /* OSS node — typically `base` over an object type */ },
  "appliedFilters": [
    { "propertyApiName": "itemName",
      "kind": "multiSelect",
      "values": ["Widget A", "Widget B"] },
    { "propertyApiName": "orderDueDate",
      "kind": "timeline",
      "from": "2026-04-01T00:00:00Z",
      "to":   "2026-06-30T23:59:59Z" },
    { "propertyApiName": "quantity",
      "kind": "histogramRange",
      "min": 100,
      "max": 500,
      "includeNulls": false },
    { "propertyApiName": "status",
      "kind": "multiSelect",
      "values": ["assigned"] }
  ]
}
```

### Compiler output

```json
{
  "compiled": { /* OSS objectSet node, ready for B05 */ },
  "compiledHash": "sha256:..."
}
```

### Compilation rules

| Filter kind | OSS predicate |
|---|---|
| `multiSelect` (≥1 value) | `{ "type": "in", "field": "<prop>", "values": [...] }` |
| `multiSelect` (0 values) | filter is omitted (no constraint) |
| `timeline` | `{ "type": "and", "value": [{ "type": "gte", ... }, { "type": "lte", ... }] }` |
| `histogramRange` | same as timeline but numeric; `includeNulls` adds `or (isNull)` branch |
| `string` (text input) | `{ "type": "contains", "field": "...", "value": "..." }` (case-insensitive) |
| `boolean` | `{ "type": "eq", "field": "...", "value": true|false }` |

All applied filters AND'd together at the top level. Filter output variable schema:

```json
{
  "kind": "objectSetFilter",
  "version": 1,
  "filters": [ /* same shape as appliedFilters */ ]
}
```

### "Filter using a variable" constraint

When an `objectSet` variable's definition includes:

```json
{
  "constraints": [
    { "kind": "filterByVariable", "filterVariableId": "v_order_filters" }
  ]
}
```

…the compiler resolves `v_order_filters` to the FilterList output, then applies it on top of the variable's base set, returning a single fused OSS node. This is the mechanism for the Phase 5 Step 4 "Filter using a variable" wiring.

### Errors

| errorName | HTTP |
|---|---|
| `Tellus:Workshop:UnknownFilterKind` | 400 |
| `Tellus:Workshop:FilterPropertyNotInObjectType` | 400 |
| `Tellus:Workshop:FilterTypeIncompatibleWithProperty` | 400 (e.g. histogram on a string) |
| `Tellus:Workshop:CircularFilterReference` | 400 (filter variable refers transitively to its own consumer) |

### Metrics

```
tellus_workshop_filter_compile_seconds{result}            histogram
tellus_workshop_filter_compile_predicates                 histogram
tellus_workshop_filter_compile_hash_collisions_total      counter
```

### SLO

P50 ≤ 5 ms, P95 ≤ 20 ms, P99 ≤ 50 ms. Pure CPU work. Frontend can call this every keystroke for live preview.

### Edge cases

- Empty filter set → compiler returns `baseObjectSet` unchanged. The OSS load skips the filter wrap.
- A filter on a property that's been **removed** from the ontology after a Workshop save → compiler returns `400` `Tellus:Workshop:FilterPropertyNotInObjectType` and B02 surfaces this on next save.
- "Apply if non-empty" semantics: timeline with `from=null AND to=null` is omitted.

### Acceptance

- All 11 filters in Phase 5 Step 4 (Item Name multi-select, Assignee multi-select, Consolidated Customer ID multi-select, Customer Name (default), Days Until Due (default histogram), Customer ID multi-select, Order Due Date timeline, Order ID multi-select, Quantity histogram, Status multi-select, Unit Price (default histogram)) compile to the expected OSS predicate tree.

---

## B08 — Aggregation Query Endpoint (Group-By + Bin)

**Depends on:** B05.
**Service:** `workshop-service` proxy → OSS aggregation API.
**Maps to:** Phase 5 Step 6 — Pie Chart "Group By Status," Bar Chart XY ("X-Axis: Days Until Due, Bar Series Segment By: Status").

### Contract

```
POST /workshop/api/v1/objectSets:aggregate
{
  "ontologyRid": "...",
  "branch":      null,
  "objectSet":   { /* compiled OSS node — typically the same as the table's */ },
  "aggregations": [
    { "name": "count", "type": "count" },
    { "name": "sumQty", "type": "sum", "field": "quantity" }
  ],
  "groupBy": [
    { "field": "status", "kind": "exact" },
    { "field": "daysUntilDue",
      "kind": "fixedWidthBuckets",
      "bucketWidth": 1, "minimumValue": 0, "maximumValue": 30 }
  ],
  "executionMode": "PREFER_SPEED"
}
→ 200 { "buckets": [
    { "key": [{ "field": "status", "value": "assigned" },
              { "field": "daysUntilDue", "value": { "from": 0, "to": 1 } }],
      "metrics": { "count": 142, "sumQty": 8210 } },
    ...
] }
```

### Group-by kinds (must support, all from public OSS aggregation API)

- `exact` (categorical)
- `fixedWidthBuckets` (numeric ranges; configurable bucket width, min, max)
- `dateRangeBuckets` (date histogram; resolution = day|week|month|quarter|year)
- `top-N` (top-N distinct values)

### Aggregation kinds

`count`, `sum`, `avg`, `min`, `max`, `approxDistinct`. All scoped to a numeric / date property.

### Errors

| errorName | HTTP |
|---|---|
| `Tellus:Workshop:AggregationFieldNotFound` | 400 |
| `Tellus:Workshop:AggregationKindIncompatible` | 400 (e.g. sum on a string) |
| `Tellus:Workshop:AggregationTooManyBuckets` | 413 (>10000) |

### Metrics

```
tellus_workshop_aggregate_seconds{object_type_api_name, result}    histogram
tellus_workshop_aggregate_buckets_returned                          histogram
tellus_workshop_aggregate_groupby_dimensions                        histogram
```

### SLOs

P50 ≤ 250 ms, P95 ≤ 1 s, P99 ≤ 2.5 s for `executionMode = PREFER_SPEED` and bucket count ≤ 1000.

### Edge cases

- Pie Chart with `Group By: Status` over an object set that has a single status value renders a single slice — must include zero-count slices only when frontend explicitly asks (via `includeEmptyBuckets: true`).
- Bar XY with `Days Until Due` numeric x-axis MUST default to `fixedWidthBuckets` (NOT one bar per distinct value) to avoid the "visual squashing" the doc explicitly calls out in Phase 5 Step 6.

### Acceptance

- Pie Chart binds with `groupBy: [{ field: "status", kind: "exact" }]` and renders the slices.
- Bar XY with X-Axis Days Until Due, Segment By Status compiles to `groupBy: [{ field: "daysUntilDue", kind: "fixedWidthBuckets", ... }, { field: "status", kind: "exact" }]` and the frontend uses both dimensions to draw stacked vertical bars.

---

## B09 — Action-Type Authoring API (in OMS)

**Depends on:** OMS service (T0). **Lives in OMS, not workshop-service**, but Workshop-critical, so spec'd here for completeness.
**Maps to:** Phase 6 Step 1 — the Modify-Object Action Type wizard.

### Contract

```
POST /ontology-metadata/api/v1/ontologies/{ontologyRid}/actionTypes
     ?branch=...
     If-Match: <ontology_etag>
{
  "apiName":     "olivierAssignOrder",
  "displayName": "Olivier Assign Order",
  "description": "",
  "operation": {
    "kind":            "modifyObject",
    "objectTypeApiName": "Order"
  },
  "parameters": [
    { "id": "p_order",
      "displayName": "Order",
      "type": { "kind": "objectReference", "objectTypeApiName": "Order" },
      "required": true,
      "validation": [],
      "binding": { "kind": "primaryKey" } },
    { "id": "p_assignee",
      "displayName": "Assignee",
      "type": { "kind": "string" },
      "required": true,
      "validation": [],
      "binding": { "kind": "userInput" } },
    { "id": "p_status",
      "displayName": "Status",
      "type": { "kind": "string" },
      "required": true,
      "binding": { "kind": "staticValue", "value": "assigned" } }
  ],
  "edits": [
    { "kind": "modifyProperty",
      "objectParameterId": "p_order",
      "propertyApiName": "assignee",
      "valueExpression": { "kind": "parameter", "id": "p_assignee" } },
    { "kind": "modifyProperty",
      "objectParameterId": "p_order",
      "propertyApiName": "status",
      "valueExpression": { "kind": "parameter", "id": "p_status" } }
  ],
  "submissionCriteria": {
    "kind": "userIn",
    "users": ["multipass-user-id-of-creator"]
  }
}
→ 201 Created, ETag, body = full action type
```

### Wizard flow → API mapping

| Wizard step | API field |
|---|---|
| "Modify object(s)" radio | `operation.kind = "modifyObject"` |
| "+ Add property" → Assignee, Status | two `parameters` + two `edits` |
| Assignee = Parameter (default) | `binding.kind = "userInput"` |
| Status = Static value "assigned" | `binding.kind = "staticValue", value = "assigned"` |
| Submission criteria = User → self | `submissionCriteria.kind = "userIn"` |

### Authorization

Caller must have **Editor** on the ontology AND **Editor** on the target object type.

### Concurrency

Action types are versioned with the ontology's ETag; `If-Match` enforces optimistic concurrency.

### Errors

| errorName | HTTP |
|---|---|
| `Tellus:OMS:ActionTypeApiNameConflict` | 409 |
| `Tellus:OMS:ParameterReferencesUnknownProperty` | 400 |
| `Tellus:OMS:StaticValueTypeMismatch` | 400 |
| `Tellus:OMS:SubmissionCriteriaSubjectNotFound` | 400 |

### Metrics

```
tellus_oms_action_type_create_seconds{kind, result}     histogram
tellus_oms_action_type_count{ontology}                  gauge
```

### SLO

P50 ≤ 150 ms, P95 ≤ 400 ms, P99 ≤ 800 ms. Includes ontology graph re-validation.

### Edge cases

- Phase 6 Step 1 sets Status as static "assigned" — the Action Type SHOULD therefore omit Status from the runtime parameter form. Workshop's auto-generated form (F09/F10) MUST hide static-bound parameters.
- Submission criteria "User → self" creates a singleton allow-list; later editing the action type to add more users is a separate PUT.

### Acceptance

- After Phase 6 Step 1 wizard completes, OMS has an `olivierAssignOrder` action type with two user-bound parameters (Order PK, Assignee) and one static-bound parameter (Status="assigned").

---

## B10 — Action Apply + Post-Apply Refresh Bus

**Depends on:** B09 (action types must exist), Actions service (T0).
**Service:** `workshop-service` proxy + WebSocket subscription bus.
**Maps to:** Phase 6 Step 3 — clicking Submit on the action modal triggers apply, modal closes, table re-fetches, charts re-render.

### Apply contract (proxy to Actions service)

```
POST /workshop/api/v1/actions/{actionApiName}:apply
     ?ontologyRid=...&branch=...
     Idempotency-Key: <uuid v4>             (REQUIRED)
{
  "parameters": {
    "p_order":    { "primaryKey": 80060 },
    "p_assignee": "Anna Smith"
  },                                        // Static-bound params NOT sent — server fills
  "options": {
    "returnEdits": "ALL",
    "mode":        "VALIDATE_AND_EXECUTE"
  }
}
→ 200 {
   "validation": { "result": "VALID", ... },
   "edits": {
     "edits": [{ "type": "modifyObject", "primaryKey": 80060,
                 "modifiedProperties": ["assignee", "status"] }],
     "addedObjectCount": 0, "modifiedObjectCount": 1, "deletedObjectCount": 0
   }
 }
```

### Validation-only contract

```
POST /workshop/api/v1/actions/{actionApiName}:validate
```

Same body, returns `validation` only. Used by F09 to gate the Submit button.

### Refresh-bus contract

```
WS /workshop/api/v1/modules/{rid}/live?moduleSemver=0.42.0&branch=...

Server → Client on action commit (any user, any context):
  { "type": "objectsChanged",
    "objectTypeApiName": "Order",
    "primaryKeys": [80060],
    "modifiedProperties": ["assignee", "status"] }

Client subscribes per visible object-set variable. On `objectsChanged` whose
object type intersects the variable's target type, client re-fetches via B05.
```

The bus is fed by the Actions service publishing to Kafka topic `tellus.actions.committed.v1` after every successful apply; workshop-service consumes the topic and fans out to subscribed clients.

### Concurrency / idempotency

- `Idempotency-Key` MANDATORY. Same key + same body → cached response. Same key + different body → `Tellus:Workshop:IdempotencyKeyReused`.
- Actions service handles OSv2 stale-object detection. On `Actions:StaleObjectVersion`, workshop-service MUST surface as `Tellus:Workshop:ActionStaleObject` 409 — the client should NOT auto-retry; the user must reload.

### Errors

| errorName | HTTP | When |
|---|---|---|
| `Tellus:Workshop:ActionTypeNotFound` | 404 | apiName unknown |
| `Tellus:Workshop:ActionParameterMissing` | 400 | required user-input parameter missing |
| `Tellus:Workshop:ActionValidationFailed` | 422 | submissionCriteria / per-parameter validation failed |
| `Tellus:Workshop:ActionStaleObject` | 409 | OSS object version mismatch |
| `Tellus:Workshop:ActionPermissionDenied` | 403 | caller lacks Apply on the action |
| `Tellus:Workshop:IdempotencyKeyReused` | 409 | same key, different body |
| `Tellus:Workshop:ActionTimeout` | 504 | downstream Action service timeout (default 60s) |

### Metrics

```
tellus_workshop_action_apply_seconds{action_api_name, result}        histogram
tellus_workshop_action_validate_seconds{action_api_name, result}     histogram
tellus_workshop_action_stale_object_total{action_api_name}           counter
tellus_workshop_live_ws_connections                                  gauge
tellus_workshop_live_ws_messages_sent_total{message_type}            counter
tellus_workshop_live_ws_messages_dropped_total{reason}               counter
```

### SLOs

- Apply (single object, no FoO): P50 ≤ 300 ms, P95 ≤ 900 ms, P99 ≤ 2.5 s.
- Validate-only: P50 ≤ 80 ms, P95 ≤ 250 ms, P99 ≤ 600 ms.
- WS message delivery (commit → client): P50 ≤ 500 ms, P95 ≤ 1.5 s, P99 ≤ 4 s.

### Edge cases

- Action that modifies properties that the calling user **cannot read** (column-level OSP): apply succeeds, but the post-apply refresh response will mask the modified property values. Client must accept that the table cell may show "—" not the new value. Bug-class hazard if not anticipated.
- Refresh-bus reconnect: client reconnects with backoff (1s, 2s, 4s, max 30s) and immediately re-subscribes; server replays no missed messages — client MUST do a full B05 reload of every subscribed variable on reconnect to recover the post-disconnect state.
- A user submitting Phase 6 Step 3 with no row selected (active object var = null) → 400 `Tellus:Workshop:ActionParameterMissing` with `parameters.parameterId = "p_order"`. F09 must disable Submit until active object is set.

### Acceptance

- Phase 6 Step 3 Submit:
  1. F10 calls `:validate` first (returns VALID), then `:apply` with `Idempotency-Key`.
  2. Server returns `edits.modifiedProperties = ["assignee", "status"]`.
  3. WS pushes `objectsChanged` to all subscribed clients.
  4. Object Table re-fetches; row 80060 shows new Assignee + Status.
  5. Pie Chart and Bar XY re-aggregate; status distribution shifts.

---

# PART B — FRONTEND TASKS (F01 – F10)

> Stack baseline (matches Tellus Workshop architecture spec):
> React 18 + TypeScript 5, Blueprint v6, Redux Toolkit + RTK Query, MapLibre GL JS for maps, Vega-Lite via react-vega for charts. State for the variable graph is **separate** from RTK — see F04.

---

## F01 — Workshop Editor Shell

**Depends on:** B01, B03, B04, B06.
**Maps to:** Phase 5 Step 1 (canvas mount) and the entire editing experience throughout Phase 5/6.

### Components

```
<EditorShell moduleRid={rid} initialMode="edit">
  <Toolbar>                                          // top bar
    <ModuleTitle />
    <SaveAndPublishButton />                         // bottom-right rail also has "View" toggle
    <ModeToggle edit|view />
    <BranchPicker />
    <UndoRedo />
  </Toolbar>
  <LeftRail>                                         // tree of pages, sections, widgets, variables
    <PagesPanel />
    <VariablesPanel />                               // critical — drives F04
    <WidgetCatalog />                                // for "+ Add widget" picker
  </LeftRail>
  <CanvasViewport>                                   // where the rendered module shows
    <PageRenderer />
  </CanvasViewport>
  <RightRail>                                        // contextual config for selected widget/section
    <SelectionConfigPanel />
  </RightRail>
</EditorShell>
```

### State management

- **Module document** in Redux store, slice `module`. Holds the full JSON returned by B01 GET, plus a derived `etag`.
- **Selection** in slice `selection`: `{ kind: "widget" | "section" | "variable" | "page", id }`.
- **Editor mode** in slice `editor`: `mode: "edit" | "view"`, `dirty: boolean`, `lastSavedSemver: string`.
- **Variable values & evaluation status** is NOT in Redux — see F04.

### Save flow

- "Save and publish" → POST `/_validate` first (defense in depth — server is canonical, but local validate gives instant feedback). On valid, PUT `/modules/{rid}` with `If-Match`. On 412, show modal "Your view is out of date — Reload" with explicit Reload button (no auto-reload — preserves local edits at user's choice).
- Auto-save off by default. Dirty state surfaces in the Save button as "Save\*".

### View / Edit toggle

- "View" toggles `mode`; the canvas re-renders using the **last published semver** if it exists, else the current dev version. Toggling back to "Edit" restores the editor.
- The toggle is the same UI gesture as Phase 6 Step 3 "View" button.

### Routing

- `/workspace/workshop/{rid}` — editor at dev version
- `/workspace/workshop/{rid}/view/latest` — viewer at latest published
- `/workspace/workshop/{rid}/view/dev` — viewer at current dev
- Promoted external IDs from URL query string passed into module-interface variables on initial render.

### Telemetry

```
tellus_workshop_editor_shell_load_seconds{result}                histogram
tellus_workshop_editor_save_seconds{result}                       histogram
tellus_workshop_editor_save_etag_mismatch_total                   counter
tellus_workshop_editor_undo_total / _redo_total                   counter
```

### Edge cases

- Browser back button after dirty edit → `beforeunload` confirmation dialog.
- Two browser tabs editing the same module → second tab's PUT will 412 — Reload modal.
- Loss of network during PUT → retry with same `If-Match` and same `Idempotency-Key` (POST creation only). For PUT, do not retry transparently; show "Save failed — Retry" button.

### Acceptance

- Phase 5 Step 1: clicking "Create new" from Ontology Manager calls B04, then navigates to `/workspace/workshop/{rid}` with the editor mounted.
- Phase 6 Step 3: "Save and publish" then "View" transitions canvas to the published-semver viewer.

---

## F02 — Header Widget

**Depends on:** F01, Blueprint v6 component primitives.
**Maps to:** Phase 5 Step 2 — the global module header.

### Widget spec

```ts
type HeaderWidget = {
  id: string;
  type: "header";
  config: {
    title:   string;                // required, ≤ 120 chars
    subtitle?: string;
    icon?:   { kind: "blueprint", name: string };  // Blueprint icon names
    color?:  string;                                // hex or named token (e.g. "Cerulean" → #2965CC)
    alignment?: "left" | "center";
  };
  display: { visibilityVariableId?: string };
};
```

### Right-rail config UI

- Module Title text input, character counter
- Icon picker — searchable Blueprint icon grid (~500 icons; lazy-render only visible rows; debounce search 200 ms)
- Color picker — Tellus design-system named colors (Cerulean, Forest, Indigo, Rose, Gold, Slate, Vermillion, Turquoise, Violet, Lime) plus a custom hex input. Preview swatch updates live.
- Alignment toggle (left/center)
- Visibility — bind to a boolean variable (optional)

### Rendering

Renders inside the toolbar slot. In view mode, header is sticky at the top of the viewport. In edit mode, click selects header → right rail shows config.

### Acceptance

- Phase 5 Step 2 puts "Olivier Orders Inbox" into Module Title field, picks a document icon, picks Cerulean. Saving and reloading restores all three.

---

## F03 — Section / Layout Engine

**Depends on:** F01.
**Maps to:** Phase 5 Step 3 (Flex sizing column width=2), Step 5 (background color, collapsible, section title), Step 6 (split section above + columns horizontal split + section title "Charts").

### Section spec

```ts
type Section = {
  id: string;
  layout: "rows" | "columns" | "tabs" | "flow" | "toolbar" | "loop";
  header: {
    visible: boolean;
    title?: string;
    format?: "block" | "contained" | "floating";
    collapsible: boolean;
    initiallyCollapsed: boolean;
    collapsedIcon?: string;       // e.g. "menu-closed"
    expandedIcon?: string;        // e.g. "menu-open"
  };
  sizing: { mode: "auto" | "absolute" | "flex"; value?: number };
  padding: "none" | "compact" | "comfortable" | { h: number; v: number };
  background?: { color?: string; borderStyle?: "none" | "thin" | "shadow" };
  scrolling?: { enabled: boolean };
  children: Array<
    | { kind: "section"; ref: string }
    | { kind: "widget";  ref: string }
  >;
};
```

### Layout engine behavior

- `rows` and `columns` use CSS Grid. `flow` uses flex-wrap. `tabs` renders Blueprint `Tabs` with one rendered tab body at a time.
- Sizing:
  - `auto`: child content drives size
  - `absolute`: fixed pixel size (`value` is px)
  - `flex`: flex-grow weight (`value` is the weight, e.g. `2` means twice the share)
- "Split section above" / "Split section below" / "Split section left" / "Split section right" mutate the parent section: insert a new sibling section, current section becomes a child or stays based on direction. **The split operation must preserve all child IDs** — moving a widget to a new parent section never reassigns its ID (referential integrity).
- Drag-and-drop reorder of children inside a section.
- Section background color picker mirrors F02 color picker (named tokens + custom hex), with named tokens including "Light gray 4" used in Phase 5 Step 5.
- Collapsible: when `collapsible=true`, section header shows toggle. Collapsed state stored in browser's session-only state (not persisted to module — collapsing is a UI affordance, not a saved property).

### Loop layout

- Children are rendered once per item in the bound object set or array variable.
- Each iteration has its own variable scope (per architecture spec §4.3).
- Embedded module ref + interface mapping per iteration.

### Right-rail config

- Layout direction selector (rows/columns/tabs/flow/toolbar/loop)
- Section header toggle, title, format, collapsible flags, icons
- Sizing mode + value
- Padding selector
- Background color + border style
- "Split" toolbar buttons (above/below/left/right) on hover of section in edit mode

### Telemetry

```
tellus_workshop_section_split_total{direction}            counter
tellus_workshop_section_drag_reorder_total                counter
```

### Edge cases

- Splitting a section that contains a widget bound to the active-object variable of a table inside the same section: the widget's binding survives because it's by ID, not by position.
- Switching layout from `rows` to `columns` preserves children but may visually break — show preview in right rail before commit.
- Collapsed sections in view mode still evaluate variables for their children if mode is edit (eager) — but in view mode, collapsed children's variables are lazy.

### Acceptance

- Phase 5 Step 3: Section column width changed to Flex / value=2 — table column expands relative to the filter rail.
- Phase 5 Step 5: Filter section background = Light gray 4, collapsible enabled with menu-closed/menu-open icons, title "Filter Orders".
- Phase 5 Step 6: Split section above creates a new top section; horizontal columns split inside the top section; section title "Charts" set.

---

## F04 — Variable System Runtime

**Depends on:** F01, B02 (compiled var graph).
**Maps to:** Phase 5 Step 3 (object set variable creation modal), Step 4 (filter output variable + "Filter using a variable" constraint), Step 7 (auto-generated active-object variable), Phase 6 Step 2 (Parameter Defaults binding to active-object variable).

### State store

Variable values live in a **dedicated reactive store** (NOT Redux) because the graph is hot, fine-grained, and must not trigger React re-renders for unrelated subscribers. Implementation: a topological-sorted DAG with per-node `BehaviorSubject`-style observables (built on a small custom signal library, ~600 LoC, modeled on the architecture-spec §4 evaluation rules).

```ts
interface VariableNode<T> {
  id: string;
  type: VariableType;
  definitionType: "static" | "function" | "objectProperty"
                | "objectSetDefinition" | "variableTransformation"
                | "widgetOutput" | "moduleInterface";
  deps: string[];                        // upstream var IDs
  evaluator: (deps: Record<string, unknown>) => Promise<T> | T;
  recomputeBehavior: "automatic" | "manual";
  // runtime
  value:   T | undefined;
  status:  "unevaluated" | "evaluating" | "ready" | "error";
  error?:  Error;
  subscribers: Set<(v: T | undefined) => void>;
  cacheKey?: string;                     // for function-backed memoization
}
```

### Evaluation modes

- **Edit mode (eager):** all reachable nodes evaluate immediately on any upstream change. Bounded concurrency = 8 parallel function-backed evaluations.
- **View mode (lazy):** only nodes whose downstream sinks are visible. Sink visibility is computed from page/tab/overlay/loop visibility tree.

### Variable creation modal

Triggered from Phase 5 Step 3's "New object set variable" link in widget config. Modal fields:
- Variable name (display)
- Type (objectSet | scalar | array | struct | objectSetFilter | timeSeriesSet | object)
- Definition type (per allowed list per type)
- Type-specific config:
  - For `objectSet` definitionType=objectSetDefinition: starting object set picker → object type list from B06; mode selector base/intersect/union/etc. → defaults to base
  - For function-backed: function picker from B06 query types
- Constraints (optional):
  - "Filter using a variable" → variable picker filtered to `objectSetFilter` type only

Modal closes → variable added to module document → topology re-sorted → if cycle introduced (defense in depth, even though F04 catches), block save.

### "Filter using a variable" mechanism

When a filter variable is added as a constraint to an object set variable:
1. Module document mutation: `definition.variables[v_orders].constraints.push({ kind: "filterByVariable", filterVariableId: "v_order_filters" })`
2. Topology: `v_orders` now depends on `v_order_filters`. Re-sort.
3. Runtime: any change to `v_order_filters` re-evaluates `v_orders` (which calls B07 → B05).

### Auto-generated variables

When a widget declares an output (Object Table → `activeObject`, `selectedObjects`), F04 auto-creates the variables on widget add:
- `v_<widgetId>_active_object` of type `object` (typed by widget's input object set's allowed types)
- `v_<widgetId>_selected_objects` of type `objectSet`
- Naming follows the doc's "Object table 1 active object" convention: `<Widget Display Name> active object`. User may rename in Variables panel.

### Variable panel UI (left rail)

- Tree of variables grouped by definition type
- Inline preview of current value (edit mode only)
- Status badge per variable: ●loading / ✓ready / ⚠error
- Click variable → right rail shows definition editor + dependents list (reverse edges)
- Search/filter

### Reactive recomputation contract

Per architecture spec §4.4 (events do not wait for downstream re-eval):
- A `setVariableValue` event resolves immediately for the next event in the sequence.
- Downstream nodes mark themselves dirty and queue evaluation; widgets bound to those nodes show loading state until re-eval completes.

### Telemetry

```
tellus_workshop_var_eval_seconds{var_type, definition_type, result}     histogram (client-emitted via OTel)
tellus_workshop_var_dirty_count                                          gauge
tellus_workshop_var_subscriber_fanout                                    histogram
```

### Edge cases

- Variable rename: must update all references in `inputs[]`, `outputs[]`, `constraints[]`, `events[]`, `routing.promotedExternalIds`, `moduleInterface.variables[].externalId` (only if external-id-derived). Single transactional mutation in Redux.
- Variable delete: refuse if referenced. Show "Used by: <widget1>, <widget2>, ..." dialog.
- Function-backed variable cache: keyed by `(functionRid, version, sha256(JSON.stringify(inputs)))`. Stored in memory only — **not** IndexedDB for v1 (privacy + simplicity); revisit if needed.

### Acceptance

- Phase 5 Step 3: "New object set variable" modal creates `Order Object Set` bound to base set of `Order` object type.
- Phase 5 Step 4: "Filter using a variable" constraint on Order Object Set, pointing at the FilterList output variable, makes the table reactively re-fetch on filter change.
- Phase 5 Step 7: Adding the Object Table widget auto-creates `Object table 1 active object` variable. Object Set Title widget binds to it.
- Phase 6 Step 2: Parameter Defaults Order param maps to `Object table 1 active object` — recorded as `parameterDefaults.p_order = { kind: "variable", variableId: "v_table_1_active_object" }`.

---

## F05 — Object Table Widget

**Depends on:** F03, F04, B05, B06.
**Maps to:** Phase 5 Step 3.

### Widget spec

```ts
type ObjectTableWidget = {
  id: string;
  type: "objectTable";
  config: {
    columns: Array<{
      propertyApiName?: string;          // ontology property
      functionApiName?: string;          // function-backed column (FoO)
      displayName: string;               // editable; defaults from ontology
      width?: number | "auto";
      frozen?: "left" | "right" | null;
      conditionalFormat?: { ... };
      hidden?: boolean;
      sortable?: boolean;
    }>;
    pageSize: number;                     // default 500
    multiSelect: boolean;                 // default true
    rowHeight: "compact" | "regular" | "comfortable";
    valueWrap: boolean;
    emptyStateMessage?: string;
    activeRowSelection: boolean;          // default true → enables activeObject output
    exportEnabled: boolean;               // default true
    exportLimitProperty: 200000;          // hard cap
    exportLimitFunctionBacked: 10000;     // hard cap
  };
  inputs:  { objectSet: string };         // variable id
  outputs: { activeObject: string; selectedObjects: string };
  events: {
    onActiveObjectSelection?: EventList;
    onSelectionChange?: EventList;
  };
};
```

### "Add all properties" behavior

Right-rail Column Configuration → "Add all properties" button:
1. Read object type metadata from B06 (cached).
2. For every property of every allowed type in the input object set, append a column with `propertyApiName`, `displayName = propertyMetadata.displayName`, `width = "auto"`.
3. Skip arrays-of-structs and binary blobs by default (configurable advanced flag).

### Column rename

Inline edit on column header in edit mode. Updates `displayName`. Underlying `propertyApiName` unchanged. Phase 5 Step 3 renames "Title" → "Item Name".

### Active row selection

- Click row → set `activeObject` output to the object's primary key + property bag.
- Re-clicking same row deselects (active = null).
- Programmatic deselection via `clearActiveObject` event.
- Persists across page changes if same object set; cleared on object-set definition change.

### Function-backed columns

- Bind a FoO with input `(object: T)` returning `string | number | boolean | CustomType`.
- Caps: ≤ 10K objects exported with FoO columns present (matches Foundry's published cap).
- Per-cell async loading state — cell shows spinner.

### Rendering

- Virtualized rows (window of ~50). Blueprint Table v6 OR custom virtualization (TanStack Table). Recommendation: TanStack Table v8 + Blueprint cell renderers, because Blueprint Table v6 lacks the function-backed-column ergonomics needed.
- Sticky header. Column resize via drag.
- Sort: click column header. Multi-sort via shift-click. Sort state lives in widget config (persisted) when user explicitly pins; otherwise session-only.

### Edge cases

- Active-object variable type mismatch (e.g. allowed types changed after activeObject was selected) → clear activeObject and emit `onSelectionChange` with null.
- Pagination: scroll to bottom triggers next-page B05 call. If `pageSize * page > 200000`, stop and show "Showing first 200,000 — refine filters."

### Acceptance

- Phase 5 Step 3: Table populates with all properties of `Order`, "Title" renamed to "Item Name", auto-generated `activeObject` variable exists.

---

## F06 — Filter List Widget

**Depends on:** F03, F04, B06, B07.
**Maps to:** Phase 5 Step 4 (all 11 filter types).

### Widget spec

```ts
type FilterListWidget = {
  id: string;
  type: "filterList";
  config: {
    filters: Array<{
      propertyApiName: string;
      uiKind: "multiSelectDropdown" | "histogram" | "histogramRange"
            | "timeline" | "textInput" | "checkbox" | "radioGroup"
            | "slider" | "datePicker" | "dateTimePicker";
      label?: string;
      defaultValue?: unknown;
      collapsible?: boolean;
      initiallyCollapsed?: boolean;
    }>;
    showApplyButton: boolean;             // default false (live apply)
    showClearAll: boolean;                // default true
  };
  inputs:  { objectSet: string };         // source object set var
  outputs: { filter: string };            // objectSetFilter var
};
```

### Per-property UI default rules

Right-rail Filters Configuration → "+ Add filter":
1. Property picker shows all properties of input object set's allowed types.
2. UI default by property type:
   - String → multiSelectDropdown
   - Numeric → histogram
   - Boolean → checkbox
   - Date → timeline
   - Timestamp → timeline (datetime resolution)
3. User may override via per-filter dropdown to any compatible UI kind (table-driven compatibility map).

### "Multi-select dropdown" behavior

- Distinct values fetched lazily via B08 (top-N approxDistinct) when user opens dropdown.
- Search-as-you-type with server-side fuzzy match.
- Cap: top 1000 distinct values shown; "Show more…" expands.

### "Histogram" behavior

- Numeric distribution over the source object set, computed via B08 fixedWidthBuckets.
- Brush selection on the histogram updates the filter range.
- Recompute histogram when the source object set changes (excluding this filter's own contribution — to avoid the histogram collapsing on its own brush).

### "Timeline" behavior

- Date range picker with calendar + relative-range presets (Today, This week, Last 30 days, etc.).
- Resolution = day for Date, minute for Timestamp.

### Output variable

- Single `objectSetFilter` variable per FilterList widget.
- Renamed in Phase 5 Step 4 from auto-generated default to `Order Filters`.
- Schema: `{ kind: "objectSetFilter", version: 1, filters: [...] }`.

### Live apply / debouncing

- Default live (no Apply button); debounce 250 ms after last interaction.
- Each apply → mutate output variable → reactive cascade through F04 → table re-fetch via B05.

### Acceptance

- Phase 5 Step 4: 11 filters added, each with the documented UI kind. Output variable renamed to "Order Filters". The Order Object Set variable's "Filter using a variable" constraint references it.

---

## F07 — Chart Widgets (Pie + XY)

**Depends on:** F03, F04, B08.
**Maps to:** Phase 5 Step 6.

### Pie Chart spec

```ts
type PieChartWidget = {
  id: string;
  type: "chartPie";
  config: {
    groupBy: { propertyApiName: string };
    metric:  { kind: "count" } | { kind: "sum" | "avg" | "min" | "max"; field: string };
    showLegend: boolean;
    legendPosition: "outside" | "insideChart" | "right" | "bottom";
    showLabels: boolean;
    sliceLabelKind: "category" | "percent" | "value";
    colorPalette: "categorical10" | "sequential" | "custom";
    onSliceClickEmitsFilter: boolean;     // when true, emits objectSetFilter output
  };
  inputs:  { objectSet: string };
  outputs: { selectionFilter?: string };
};
```

### XY Chart spec

```ts
type XYChartWidget = {
  id: string;
  type: "chartXY";
  config: {
    seriesKind: "bar" | "line" | "scatter" | "area";
    xAxis: { propertyApiName: string;
             bucketing?: "exact" | "fixedWidth" | "dateRange";
             bucketWidth?: number;
             dateResolution?: "day"|"week"|"month"|"quarter"|"year" };
    yAxis: { metric: { kind: "count" } | { kind: "sum"|"avg"|"min"|"max"; field: string } };
    series: { segmentBy?: { propertyApiName: string } };  // stacking dimension
    barOrientation?: "vertical" | "horizontal";           // vertical default for our use-case
    stackingMode?: "stacked" | "grouped" | "normalized";
    showLegend: boolean;
    onElementClickEmitsFilter: boolean;
  };
  inputs:  { objectSet: string };
  outputs: { selectionFilter?: string };
};
```

### Rendering

- **react-vega + Vega-Lite**. Compile widget config → Vega-Lite spec → render.
- For XY with `bucketing: "fixedWidth"` and large numeric range (e.g. Days Until Due), generate a binned spec. **Default `barOrientation` to vertical** — Phase 5 Step 6 explicitly notes the user fixed visual squashing by switching to vertical.
- Theme matches Blueprint v6 token palette.

### Right-rail config

- Pie: Group By property picker, Metric picker, Show Legend toggle, Legend Position dropdown (Outside/Inside chart/Right/Bottom).
- XY: Series Kind picker, X-Axis property picker + bucketing config, Y-Axis metric picker, "Bar Series Segment By" property picker, Bar Orientation toggle, Stacking Mode picker.

### Selection → filter output

Optional. When enabled, clicking a slice/bar emits an `objectSetFilter` output that downstream variables can consume. Used for cross-filtering between charts.

### Edge cases

- `groupBy` over a property with > 1000 distinct values → top-N truncation with "Other" bucket.
- `segmentBy` and `groupBy` together: B08 returns multi-dimensional buckets; renderer pivots to wide format for Vega-Lite.
- Chart input bound to a slow function-backed variable: chart shows skeleton until variable status = ready.

### Acceptance

- Phase 5 Step 6 Pie: Group By Status, legend = Inside chart.
- Phase 5 Step 6 XY: X-Axis Days Until Due, Segment By Status, Bar Orientation Vertical.

---

## F08 — Object Set Title Widget + Active-Object Sink

**Depends on:** F03, F04, F05.
**Maps to:** Phase 5 Step 7.

### Widget spec

```ts
type ObjectSetTitleWidget = {
  id: string;
  type: "objectSetTitle";
  config: {
    titleKind: "displayName"          // default — uses object's title property
             | "propertyTemplate"      // "{{property1}} — {{property2}}"
             | "custom";
    titleTemplate?: string;            // when titleKind = propertyTemplate
    customExpression?: string;         // when titleKind = custom
    showIcon: boolean;
    showCount: boolean;                // when bound to objectSet, shows count
    fallbackText: string;              // default "No object selected"
  };
  inputs: { object?: string;           // active-object var (single-object mode)
            objectSet?: string };       // for set-count mode
  display: { size: { mode: "flex"; value: 1 } };
};
```

### Behavior

- Single-object mode (Phase 5 Step 7): `object` input bound to `Object table 1 active object`. Renders the object's title property + icon. When active object is null, renders `fallbackText`.
- Set mode: `objectSet` input. Renders "<count> Orders" or similar.
- Reactive: re-renders on every change to bound variable; no extra fetch (the active-object var already carries the property bag).

### Layout sizing

- "Flex" sizing (per Phase 5 Step 7) means takes available width with weight 1.

### Acceptance

- Phase 5 Step 7: Object Set Title widget bound to active-object variable updates immediately when user clicks a table row.

---

## F09 — Button Group Widget + Action Binding UI

**Depends on:** F04, F08, B06 (action type listing), B09 (action types must exist).
**Maps to:** Phase 6 Step 2.

### Widget spec

```ts
type ButtonGroupWidget = {
  id: string;
  type: "buttonGroup";
  config: {
    buttons: Array<{
      id: string;
      text: string;
      icon?: string;
      intent: "none" | "primary" | "success" | "warning" | "danger";
      size: "small" | "regular" | "large";
      disabled?: { kind: "static" | "variable"; value: boolean | string };
      onClick: EventList;        // see "Action event" below
    }>;
    layout: "horizontal" | "vertical";
    spacing: "tight" | "regular" | "loose";
    fillContainer: boolean;
  };
};
```

### Action event (the Phase 6 Step 2 path)

```ts
type ActionEvent = {
  kind: "action";
  actionTypeApiName: string;          // e.g. "olivierAssignOrder"
  parameterDefaults: Record<string,    // keyed by action parameter id
    | { kind: "static"; value: unknown }
    | { kind: "variable"; variableId: string }
    | { kind: "userInput" }            // explicit user input — surfaced in modal
  >;
  onSuccess?: EventList;               // post-success events
  onFailure?: EventList;
  refreshAfterApply: boolean;          // default true — surface as "Refresh data after submit"
};
```

### Right-rail Action picker UI

1. "On click" dropdown → "Action" → action type picker (scrollable list from B06, search bar, "Recently created? Refresh" affordance).
2. After selection, **Parameter Defaults** panel renders one row per action parameter:
   - Parameter name + type from action metadata
   - Source dropdown: User Input / Variable / Static Value
   - If Variable, a typed variable picker (filtered to compatible variable types)
3. Validation: every required parameter must be bound (or set to User Input). If unbound, show inline warning "Parameter Order needs a default value or user input."
4. Static-bound parameters at the action-type level (per Phase 6 Step 1's Status="assigned") are **pre-filled and hidden** in the parameter-defaults UI — they cannot be overridden at the binding site.

### Action modal (rendered at click time, in F10)

When the button is clicked at runtime:
1. Build initial parameter values from `parameterDefaults`.
2. If all parameters are filled (no user input needed), call `:apply` directly — no modal.
3. Otherwise, mount a modal:
   - One form field per `userInput`-bound parameter, in the order declared by the action type.
   - Validation per parameter (per action-type validation rules from OMS).
   - Submit button — disabled until validation passes (calls `:validate` debounced 300 ms).
   - Cancel button — dismisses modal, no apply.

### Acceptance

- Phase 6 Step 2: Button text "Assign", On click → Action → `[Name] Assign Order`, Parameter Defaults Order → `Object table 1 active object` variable.
- Phase 6 Step 3: Click "Assign" → modal with single Assignee dropdown (Status hidden because static), Submit calls `:apply` per F10.

---

## F10 — View-Mode Renderer + Action Modal + Reactive Re-fetch Trigger

**Depends on:** F01, B03, B10.
**Maps to:** Phase 5 Step 7 ("Save and publish"), Phase 6 Step 3 (View → filter → select row → click Assign → submit modal → reactive refresh).

### View mode renderer

- Same component tree as edit mode but:
  - No selection borders, no right rail, no left rail
  - All widgets in interactive mode (filters live-apply, buttons clickable)
  - URL `/view/latest/{rid}` or `/view/dev/{rid}` — fetches via B03 resolve endpoints
  - URL query string maps to module-interface variables
- Embeddable via iframe with `?embedded=true` (suppresses chrome).

### Live subscription

On view-mode mount:
1. Open WebSocket per B10 contract.
2. Subscribe to every visible object-set variable's underlying object type.
3. On `objectsChanged` for a subscribed type, mark variable dirty → F04 reactive cascade re-runs B05.

### Action submission lifecycle

```
[user clicks button]
  → if all params bound, skip modal
  → else open ActionModal
[user fills inputs, clicks Submit]
  → POST :validate
  → if invalid, show field errors
  → if valid:
      generate Idempotency-Key (uuid v4)
      POST :apply with { parameters, options: { returnEdits: "ALL", mode: "VALIDATE_AND_EXECUTE" } }
      modal shows pending spinner
[server returns 200]
  → unmount modal
  → if refreshAfterApply (default true):
      mark all variables that depend on the action's modified object types as dirty
      reactive cascade re-fetches
[server returns 4xx/5xx]
  → modal stays open with error banner
  → if 409 ActionStaleObject, banner says "Data changed — Reload" with a Reload button
  → if 409 IdempotencyKeyReused, treat as success (server already applied)
```

### Optimistic UI (optional, off by default)

When `optimisticUI: true` on the action event:
1. Apply the predicted edit to the local variable cache immediately.
2. On success, reconcile with server-returned edits.
3. On failure, roll back and show error toast.

For Phase 6 Step 3 the demo flow uses non-optimistic — Submit waits for server, table refreshes after, status visibly transitions.

### Reactive re-fetch on action commit

After the apply succeeds:
1. Compute the set of variables to invalidate: all `objectSet` variables whose allowed types intersect the action's `objectTypeApiName`.
2. Mark them dirty in F04. Cascade re-evaluates them and all dependents.
3. Active-object variable: if its underlying object was modified, refetch its property bag (single-object load).
4. Charts re-aggregate; KPI cards re-compute; visible tables re-render.

### Telemetry

```
tellus_workshop_view_mount_seconds                       histogram
tellus_workshop_action_modal_open_total{action}          counter
tellus_workshop_action_submit_seconds{action, result}    histogram
tellus_workshop_action_post_apply_refresh_vars           histogram
tellus_workshop_live_subscription_lag_seconds            histogram
```

### Edge cases

- User submits action while view mode is paused (auto-refresh paused via event): apply still runs; refresh waits until resumed.
- Network drop mid-submit: modal stays open; on reconnect, F10 retries `:apply` with the same `Idempotency-Key` — server returns the cached response if already applied, else applies fresh.
- Submit on action where active-object variable is null between modal open and submit click: `:validate` returns 422 with `parameters.p_order = "missing"`. Modal disables Submit and shows inline error.

### Acceptance

- Phase 5 Step 7 "Save and publish" + URL navigation to `/view/latest/{rid}` mounts the read-only viewer with all widgets functional.
- Phase 6 Step 3 full workflow: filter → row select → Assign → modal → Submit → modal closes → table row shows new Assignee, Status flips to "assigned" → Pie + Bar XY re-render. End-to-end ≤ 2 s P95 from Submit click to visible refresh.

---

## C. End-to-End Workflow Verification

Every interaction in the attached document is covered by ≥ 1 task:

| Workflow step | Tasks |
|---|---|
| **Phase 5 Step 1** Launch Workshop from OM, name modal, save | B04, B01, F01 |
| **Phase 5 Step 2** Header config (title, icon, color Cerulean) | F02 |
| **Phase 5 Step 3** Object Table widget, object set var creation, Add all properties, column rename, Flex sizing | F05, F04, F03, B05, B06 |
| **Phase 5 Step 4** Filter List widget, 11 filters with per-type UI, output var rename, Filter using a variable constraint | F06, F04, B07 |
| **Phase 5 Step 5** Section background, collapsible, expand/collapse icons, title | F03 |
| **Phase 5 Step 6** Split section above + columns split + Pie (Group By Status, legend Inside chart) + XY (X Days Until Due, Segment By Status, Vertical) + section title "Charts" | F03, F07, B08 |
| **Phase 5 Step 7** Object Set Title widget bound to auto-generated active-object variable, Save and publish | F08, F04, F10, B03, B01 |
| **Phase 6 Step 1** Action type wizard: Modify object(s), parameters Assignee + Status, mappings, submission criteria, Save to Ontology | B09 |
| **Phase 6 Step 2** Button Group, On click Action, Parameter Defaults Order → active-object variable | F09, F04, B06 |
| **Phase 6 Step 3** Save and publish, View, filter, select row, click Assign, modal mounts, Submit, modal closes, reactive refresh of table + visualizations | F10, B10, F04, F05, F07 |

Every interaction has a deterministic mapping; nothing falls through.

---

## D. Suggested Build Order (5 sprints, ~10 weeks)

| Sprint | Tasks | Goal |
|---|---|---|
| 1 | B01, B02, B03, B06, F01, F02 | Editor mounts and saves; can render a header. |
| 2 | B05, B07, B08, F03, F04, F05 | Object Table loads filtered data. |
| 3 | F06, F07, F08 | Filters, charts, active-object title — read-only experience complete. |
| 4 | B09, B10, F09, F10 | Action types, button binding, modal, reactive refresh — write-back complete. |
| 5 | B04 + hardening, branch-aware paths, audit emit, SLO test, chaos | Ship-ready. |

---

## E. Five Highest-Risk Tasks

1. **F04 (Variable Runtime).** Subtle correctness bugs (event sequencing, lazy-vs-eager, cycle detection edge cases) will cascade everywhere. Build the smallest possible kernel first; write property-based tests before adding features.
2. **B07 (Filter Compiler) + F06 (Filter List).** UI kind ↔ predicate translation matrix is large; missing one combination breaks a widget silently. Generate the matrix from a single source of truth.
3. **B10 (Action Apply + Live Bus).** Stale-object semantics + idempotency + WebSocket reconnect — three independently tricky concerns intersecting. Implement and test each in isolation before composing.
4. **F10 (View Mode + Action Modal).** Reactive refresh after apply must invalidate exactly the right variables — over-invalidation causes UX jank, under-invalidation causes stale data. Trace dependencies via the compiled var graph from B02, not heuristics.
5. **B03 ETag/branch interaction.** Branch-aware version resolution + ETag mismatch on PUT under concurrent edit is the hardest concurrency surface. Lock the row, recompute ETag inside the same transaction — no shortcuts.

End of spec.