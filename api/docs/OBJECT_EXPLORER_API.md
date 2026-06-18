# Object Explorer API

This document covers every HTTP endpoint touched by the Object-Explorer
production-readiness drive (T-01..T-10, 2026-04-30). Where a route was
modified, behaviour deltas are called out. Where a route was added,
its full contract appears below. Where a route was deleted, the
operational removal path is documented for FE coordination.

**E2E verified:** 30/30 assertions against the full docker stack
(Postgres, OpenSearch, Redis, Keycloak, MinIO) on 2026-04-30.
Test suite: `tests/e2e/object-explorer/suite.sh`.

---

## Conventions

### Authentication
Every route except `/health` requires a valid Keycloak Bearer JWT in the
`Authorization` header. Missing or malformed token → `401 UNAUTHORIZED`.
Invalid signature/expired → `401 TOKEN_INVALID`.

### Branch propagation
Reads honor the `X-Branch-Id` header. Default = `_main`. The header
is read by `readBranchHeader()` and threaded into the security filter,
overlay slot, and SQL fingerprint.

### Canonical error envelope (T-07)
Every error response from a registered route follows this shape:

```json
{
  "errorCode": "<UPPER_SNAKE_CASE>",
  "errorName": "<PascalCaseError>",
  "message": "<human-readable>",
  "statusCode": <int>,
  "requestId": "<uuid-v4>",
  "parameters": { },
  "error": {
    "code": "<UPPER_SNAKE_CASE>",
    "message": "<same>",
    "details": { },
    "timestamp": "<iso8601>"
  }
}
```

The legacy `error.code` alias is preserved for back-compat with
existing alerts; new consumers should read `errorCode`.

**Known pre-existing gap (D-2026-04-30-011):** the global 404 fallback
(unregistered paths) emits a non-canonical `{"error":{"code":"ROUTE_NOT_FOUND",...}}`
shape. Per-route 404s (route exists, resource doesn't) emit the
canonical envelope.

### Observability
Every read endpoint emits:
- `tellus_route_total{route, method, status_class}` — RED counter
- `tellus_route_duration_seconds{route, method, status_class}` — RED histogram
- `tellus_read_branch_filtered_total{route, branch_class}` — domain counter

`status_class ∈ {2xx,3xx,4xx,5xx}`; `branch_class ∈ {main, branch}`.
Cardinality is bounded — no raw branch IDs or HTTP status codes.

---

## Endpoint reference

### T-02 — Removed legacy chart endpoints

| Method | Path | Status | Notes |
|---|---|---|---|
| `GET` | `/api/v1/charts/listogram/:apiName` | **REMOVED → 404** | Bypassed CBAC/branch via PG-direct read. Logic absorbed into `/charts/batch`. |
| `GET` | `/api/v1/charts/histogram/:apiName` | **REMOVED → 404** | Same as above. |
| `GET` | `/api/v1/charts/dateHistogram/:apiName` | **REMOVED → 404** | Same as above. |
| `GET` | `/api/v1/charts/auto/:apiName` | **REMOVED → 404** | Same as above. |
| `POST` | `/api/v1/charts/batch` | **SURVIVES** | The single supported chart aggregation endpoint. |

**FE migration gate (G-T02-1):** before production rollout, deployer
verifies (a) FE bundle has been deployed for ≥7 d with no `/charts/(listogram|histogram|dateHistogram|auto)`
call sites, (b) WAF/access logs show 0 production traffic on those four
paths in the past 7 d.

### T-03 — `/sql` admin gate

| Method | Path | Auth | Body | Response |
|---|---|---|---|---|
| `POST` | `/api/v1/sql` | Bearer | `{"sql":"<select-only>","ontologyId":"<uuid>"}` | `200 {data,rows}` / `400` validation / `403` if not admin / `500` on internal failure |
| `POST` | `/api/v1/sql/invalidate` | Bearer + `ontology-admin` role | `{"ontologyId":"<uuid>","prefix":"<optional>"}` | `204` |

#### Behavioural contract
- **Admin gate (C-300):** every call to `/sql/*` requires the caller to
  hold `ontology-admin` role. Non-admin → `403`. Anonymous → `401`.
- **Sandbox lockdown (C-302):** the executing DuckDB is configured with
  `enable_external_access=false`, `enable_progress_bar=false`,
  `enable_object_cache=false`, `lock_configuration=true`. `INSTALL`
  and `LOAD` are removed.
- **Verb allowlist (C-301):** leading verb must be `SELECT|WITH|EXPLAIN|DESCRIBE|SHOW`.
  `DROP|DELETE|UPDATE|INSERT|ALTER|GRANT|...|PRAGMA` → `400`.
- **Statement timeout (C-303):** `SQL_STATEMENT_TIMEOUT_MS` (default 10 s)
  via `setTimeout` + `db.interrupt()`.
- **Inflight-join mutex (C-304):** two concurrent identical queries
  (same SQL, same security fingerprint, same branch) share one DuckDB
  execution.
- **Cache fingerprinting (C-305/C-306):** cache key includes the
  `securityFilter` output and the resolved branch ID. Identical SQL
  with different markings = different cache slot.
- **RLS at data layer (C-310):** `buildDb` calls `applyContextToBody`,
  injecting `securityFilter` and the branch slot into the OS query
  before DuckDB ingestion.
- **Invalidate (C-307/C-308):** body must include `ontologyId`. Optional
  `prefix` removes only matching cache keys.

#### Operational gate
**G-T03-1:** if non-admin role abuse becomes a vector, add a Redis-backed
token bucket keyed `(ontologyId, principalSub)` at 1/min. Tracked metric:
`tellus_sql_admin_gate_rejects_total`.

### T-05 — Export pipeline (NEW)

| Method | Path | Auth | Body | Response |
|---|---|---|---|---|
| `POST` | `/api/v1/ontology/:ontologyId/exports` | Bearer | see below | `202` job claim, `400` validation, `409` quota exceeded |
| `GET` | `/api/v1/ontology/:ontologyId/exports` | Bearer | — | `200` array of caller's jobs only (IDOR guard) |
| `GET` | `/api/v1/ontology/:ontologyId/exports/:jobId` | Bearer | — | `200` job state, `404 EXPORT_JOB_NOT_FOUND` (IDOR shape) |
| `GET` | `/api/v1/ontology/:ontologyId/exports/:jobId/download` | Bearer | — | `302` to signed URL, `404`, or `410 EXPORT_DOWNLOAD_EXPIRED` |

#### Create-job body
```json
{
  "objectTypeApiName": "TaxReturn",
  "format": "csv" | "jsonl" | "parquet",
  "query": { "filter": {...}, "sort": [...], "columns": [...] }
}
```

#### Behavioural contract
- **IDOR scoping (C-070):** every read scopes by `requested_by = currentUser`.
  Cross-user reads return `404 EXPORT_JOB_NOT_FOUND` (same envelope as
  truly-missing jobs — strictest plausible IDOR shape, see decision
  D-2026-04-30-005).
- **Per-user list (C-071):** `GET /exports` lists only the caller's
  jobs, capped at 100 most-recent.
- **Row cap (C-072):** stream job exits to `FAILED` with
  `EXPORT_LIMIT_EXCEEDED` when row count exceeds `MAX_EXPORT_ROWS`
  (env-configurable, min 1000).
- **Idempotent on COMPLETED (C-073):** re-running the worker activity
  on an already-COMPLETED job is a no-op.
- **FOR UPDATE claim (C-074):** two concurrent activities cannot both
  claim the same job; the second sees `RUNNING` and exits.
- **Snapshot security (C-075):** the security context is captured at
  job-creation time and persisted to `export_job.security_context_snapshot`.
  The worker reads from the snapshot, never from ambient session.
- **Format validation (C-082):** `format` must be `csv|jsonl|parquet`.
  Other values → `400 EXPORT_FORMAT_INVALID`.
- **Signed URL TTL (C-080):** `download_url_expires_at = now() + EXPORT_DOWNLOAD_TTL_MS`.
  Reads after expiry → `410 EXPORT_DOWNLOAD_EXPIRED` and increment
  `tellus_export_download_expired_total{format}`.

#### Database schema (migration 046)
```sql
CREATE TABLE export_job (
  job_id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ontology_id               UUID NOT NULL,
  requested_by              TEXT NOT NULL,
  object_type_api_name      TEXT,
  format                    TEXT NOT NULL,
  query_json                JSONB NOT NULL DEFAULT '{}',
  status                    TEXT NOT NULL DEFAULT 'PENDING',
  row_count                 BIGINT,
  file_path                 TEXT,
  download_url              TEXT,
  download_url_expires_at   TIMESTAMPTZ,
  expires_at                TIMESTAMPTZ,
  error_message             TEXT,
  security_context_snapshot JSONB NOT NULL DEFAULT '{}',
  branch_id_snapshot        TEXT,
  started_at                TIMESTAMPTZ,
  completed_at              TIMESTAMPTZ,
  failed_at                 TIMESTAMPTZ,
  failure_reason            TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_export_job_requested_by ON export_job(requested_by, created_at DESC);
CREATE INDEX idx_export_job_status ON export_job(status);
CREATE INDEX idx_export_job_status_created ON export_job(status, created_at)
  WHERE status IN ('PENDING','RUNNING');
```

#### Operational gates
- **G-T05-1** Temporal task queue `exports-default` provisioned.
- **G-T05-2** S3 bucket `tellus-exports` with 7-day lifecycle on `exports/*`.
- **G-T05-3** Presigned-URL signing key in Vault, mounted to worker.
- **G-T05-4** 24 h soak: 1 M-row export at p95 < 5 min, p99 < 10 min, error rate < 0.1 %.

### T-06 — `/summary` marking gate

| Method | Path | Auth | Response |
|---|---|---|---|
| `GET` | `/api/v1/ontology/:ontologyId/summary/:apiName` | Bearer | `200 {api_name, display_name, description, icon, icon_color, status, property_count}`, `404` if missing/marked-out |

#### Behavioural contract
- **Per-objectType marking filter (C-93):** the SQL `<@` predicate
  enforces that `object_type.marking_required` is a subset of the
  caller's markings. If not, the row is invisible (404, not 403).
- **Auth fallback removed (C-90):** the legacy `user?.id || "system"`
  fallback is gone. Missing principal → `401`, never silent attribution
  to `"system"`.
- **No catalog leak (C-94):** `404` body omits `object_type` details.

#### Database schema (migration 044)
```sql
ALTER TABLE object_type
  ADD COLUMN marking_required TEXT[] NOT NULL DEFAULT '{}';
CREATE INDEX idx_object_type_marking_gin ON object_type USING GIN (marking_required);
ALTER TABLE object_type_group
  ADD COLUMN marking_required TEXT[] NOT NULL DEFAULT '{}';
CREATE INDEX idx_object_type_group_marking_gin ON object_type_group USING GIN (marking_required);
```

### T-08 — Saved Explorations: visibility + marking-aware tagging

| Method | Path | Auth | Body / Notes |
|---|---|---|---|
| `GET` | `/api/v1/ontology/:ontologyId/explorations` | Bearer | List visible explorations. Filtered by `(visibility ∈ {public, owned-by-caller, shared-with-caller}) AND (required_markings ⊆ caller markings)`. |
| `GET` | `/api/v1/ontology/:ontologyId/explorations/:id` | Bearer | `200` or `404` (IDOR shape — same envelope when absent vs when marking-gated out). |
| `POST` | `/api/v1/ontology/:ontologyId/explorations` | Bearer | Body `{name, description, config, visibility}`. Server walks `config` to compute `required_markings` and persists. Privilege-escalation guard: if computed markings ⊄ caller markings → `403 EXPLORATION_PRIVILEGE_ESCALATION`. |
| `PUT` | `/api/v1/ontology/:ontologyId/explorations/:id` | Bearer | Same body shape. Re-resolves `required_markings` from updated config. Same escalation guard. |
| `DELETE` | `/api/v1/ontology/:ontologyId/explorations/:id` | Bearer | `204` on success. Visibility filter applies (returns `404` if not visible). |

#### Behavioural contract
- **Visibility filter on list (C-110):** SQL combines visibility predicate
  with `required_markings <@ caller_markings::text[]`. Indexed by
  `idx_saved_exploration_markings_gin`.
- **IDOR shape on miss (C-111):** single-GET, PUT, DELETE on a row that
  fails the marking gate return `404`, not `403` — same envelope as
  truly-missing rows. Strictest plausible interpretation per decision
  protocol.
- **Walker (C-112..C-115):** `configMarkingResolver` walks `filter`,
  `aggregations`, `sort`, and `columns`, collecting markings from each
  referenced object_type and property. Worst-case marker = union.
- **PUT re-resolution (C-116):** every update recomputes from the
  latest config; stale markings cannot persist.

#### Database schema (migration 045)
```sql
ALTER TABLE saved_exploration
  ADD COLUMN required_markings TEXT[] NOT NULL DEFAULT '{}';
CREATE INDEX idx_saved_exploration_markings_gin
  ON saved_exploration USING GIN (required_markings);
-- Property-level markings — converts pre-existing scalar TEXT in-place to TEXT[].
ALTER TABLE property
  ALTER COLUMN marking_required TYPE TEXT[]
  USING CASE WHEN marking_required IS NULL THEN NULL ELSE ARRAY[marking_required] END;
CREATE INDEX idx_property_marking_gin ON property USING GIN (marking_required);
```

#### Operational gate
**G-T08-1:** existing rows with NULL `required_markings` need a
backfill job that walks each row through `configMarkingResolver`.
Idempotent.

### T-09 — Search-around / FT / page-cap correctness

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/v1/objects/:objectType/search` | `pageSize` capped at `MAX_PAGE_SIZE=10000` (T-09 outer cap). Per-route validators may impose stricter caps (e.g. queryValidator's 1000). Either rejection emits `400` with canonical envelope and `errorCode ∈ {PAGE_SIZE_OUT_OF_RANGE, QUERY_VALIDATION_ERROR}`. |
| `POST` | `/api/v1/objects/:objectType/searchFullText` | When the query string contains spec characters (`+|-!(){}[]^"~*?:\/`), it routes to OpenSearch `query_string` with `allow_leading_wildcard:false` and `lenient:true`. Increments `tellus_full_text_spec_syntax_total`. |
| `POST` | `/api/v1/objects/:objectType/searchAround` | Multi-hop link traversal. Concurrency capped at `MULTI_HOP_CONCURRENCY=50`. Visited-PK accumulator caps at `MULTI_HOP_MAX_INTERMEDIATE=100000`. Cycles terminate (visited-set check). Records `tellus_search_around_visited_pks`, `tellus_search_around_hops`, `tellus_search_around_total`. |

#### Pagination contract
- **Page size (C-150):** `pageSize > MAX_PAGE_SIZE` → `400 PAGE_SIZE_OUT_OF_RANGE`.
- **From + size (C-151):** `from + size > MAX_FROM_PLUS_SIZE=20000` → `400 PAGE_SIZE_OUT_OF_RANGE`.
- **Multi-hop (C-154/C-155/C-156):** cycles terminate, fan-out bounded,
  visited cap prevents OOM.

### T-10 — Observability

| Method | Path | Notes |
|---|---|---|
| `GET` | `/metrics` | Prometheus exposition. Includes `tellus_route_total`, `tellus_route_duration_seconds`, `tellus_read_branch_filtered_total`, every domain counter from T-01..T-09. |

#### AST contract guard (C-403/C-404)
`tests/contract/routeContractGuard.test.ts` walks `src/routes/*.ts` via
the bundled TypeScript compiler API and rejects any new
`router.<verb>(...)` that does not invoke `instrumentRoute(...)` or that
emits `res.status(...).json(...)` outside `responseFormatter.ts`.
Future PRs that drift the route shape or the error envelope **fail CI**
mechanically.

#### Operational gates
- **G-T10-1** Prometheus dashboards: `sum(rate(tellus_route_total[5m])) by (route,status_class)`, `histogram_quantile(0.95, sum by (route,le)(rate(tellus_route_duration_seconds_bucket[5m])))`.
- **G-T10-2** Alerts on (a) 5xx-rate > 0.01 for 10 m, (b) p95-latency > 1.5x baseline for 30 m, (c) `tellus_overlay_branch_mismatch_total` rate ≠ 0.
- **G-T10-3** Log aggregator indexes `requestId`, `principalSub`, `branch_class`.
- **G-T10-4** Main green for ≥ 7 d post-rollout.

---

## Live e2e verification — 2026-04-30

```
=== Object Explorer E2E ===
API:        http://localhost:3000
Keycloak:   http://localhost:8086 realm=tellus
Ontology:   7225c197-18e2-4f85-8ce8-034d0ceb5d67
ObjectType: TaxReturn

Passed: 30
Failed: 0
ALL OBJECT-EXPLORER E2E ASSERTIONS PASSED
```

Suite: `tests/e2e/object-explorer/suite.sh`. Verifies T-02/T-03/T-05/T-06/T-07/T-08/T-09 wire-level
behaviour against full docker stack (Postgres, OpenSearch, Redis, Keycloak,
MinIO, real Keycloak JWT).

Run via:
```sh
docker compose -f docker-compose-files/postgres.docker-compose.yml \
               -f docker-compose-files/opensearch.docker-compose.yml \
               -f docker-compose-files/redis.docker-compose.yml \
               -f docker-compose-files/keycloak.docker-compose.yml \
               -f docker-compose-files/minio.docker-compose.yml up -d
npx tsx src/migrate.ts
RATE_LIMIT_MAX=10000 npx tsx src/server.ts &
bash tests/e2e/object-explorer/suite.sh
```
