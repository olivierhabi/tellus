# Tellus `object-explorer` Production-Readiness Tasks (T-01 .. T-10)

**Source:** `Tellus object-explorer — Production-Readiness Gap Analysis vs Palantir Foundry`.
**Goal:** close every blocker (B-1..B-6) and every high-priority gap (H-7..H-16) such that Tellus's `object-explorer` is **production-credible under FedRAMP-style audit obligations** and is **wire-compatible with Palantir Foundry's documented contracts** for the read-side surface.

**Scope statement.** These ten tasks bring the existing `object-explorer` surface to parity for what it implements today: read-side filtering, aggregation, link traversal, single-object views, saved explorations, exports, and writeback merge. Reaching **100% feature parity** with Foundry requires three further task suites that are explicitly out of scope here and listed in §11 (KNN/Vector, MDO, full `ObjectSetDefinition` union; Action service contract; Functions/AIP integration). Do not attempt them inside these ten.

**Voice.** Every constraint in this document is enforceable. Acceptance criteria are testable. Error codes, timeouts, retry budgets, and concurrency caps are stated as constants, not adjectives. If a section reads as advice, the agent has misread it.

**Status legend in DAG (§12):** `→` = strict precondition; `‖` = parallelizable.

---

## T-01 — Canonical `applyContextToQuery` helper; eliminate ad-hoc security wrappers

### Closes
B-3 (comparisons branch leak). Foundation for T-02, T-03, T-05, T-09, T-10.

### Scope
Extract a single query-level security+branch filter helper. Replace every `wrapWithSecurity` / inline `bool.must` lambda in `src/routes/*.ts` with calls to it. Wrap `injectSecurityFilter` (`src/services/opensearch/client.ts:223-260`) as a thin delegate. Goal: there is exactly one place in the codebase that knows what "apply the request context to a query" means.

### Touches
- **New:** `src/services/opensearch/applyContext.ts`
- **Modify:** `src/services/opensearch/client.ts:223-260`
- **Modify:** `src/routes/comparisons.ts:79-95`
- **Modify:** `src/routes/charts.ts:96-196`
- **Modify:** all callers of `injectSecurityFilter` (no signature change required)

### Implementation contract
1. `applyContextToQuery(query, securityFilter, branchId) -> Record<string, unknown>` MUST:
   - Return `query` unchanged if both `securityFilter` and `branchId` are nullish.
   - AND-wrap with `securityFilter` clause when present.
   - AND-wrap with `{ bool: { should: [{ term: { __branch: branchId } }, { bool: { must_not: [{ exists: { field: "__branch" } }] } }], minimum_should_match: 1 } }` when `branchId` is a non-empty string. Legacy documents indexed pre-F-P3-13 lack `__branch`; the `must_not.exists` disjunct preserves their visibility.
   - Treat empty string `branchId` as null. No silent main-fallback inside this helper.
   - Be pure: no side effects, no I/O, no logging.

2. `applyContextToBody(body, securityFilter, branchId)` returns `{ ...body, query: applyContextToQuery(body.query ?? { match_all: {} }, ...) }`.

3. `injectSecurityFilter` becomes a one-line delegate to `applyContextToBody`. Mark with `/** @deprecated use applyContextToBody */`. Do not remove — preserve API surface for non-route callers.

4. Replace lambdas:
   - `routes/comparisons.ts:79-95`: delete `wrapWithSecurity`. Add `const branchId = readBranchHeader(req);` at handler entry. Each `_msearch` sub-body's `query` runs through `applyContextToQuery(setQuery, securityFilter, branchId)`.
   - `routes/charts.ts:96-196`: same pattern. The aggregations block does not wrap — only the `query` field of each sub-body wraps.

### Metrics (Prometheus)
Add at every modified call site:
```
tellus_read_branch_filtered_total{route, scoped} counter
```
- `route` ∈ `{"objects.search", "objects.searchFullText", "objects.searchAround", "objects.get", "objects.linked", "objectViews.single", "objectViews.batch", "charts.batch", "comparisons.aggregate", "summary.bundle"}` — bounded enum, MUST NOT include user-supplied strings.
- `scoped` ∈ `{"true", "false"}` where `"true"` iff `branchId !== null`.

### Error codes
None added; existing per-route codes preserved.

### Tests (mandatory)
- `applyContext.spec.ts`: 8 cases — Cartesian of (query=match_all|complex, sec=null|present, branch=null|present). Property test with `fast-check` over arbitrary nested `bool` shapes asserting wrapper idempotence after one application.
- Integration: `POST /api/v1/ontology/:id/comparisons/aggregate` with `x-branch-id: <B>` and a fixture document on branch `<A>` returns aggregations with zero contribution from `<A>`. Test fails before T-01 lands.

### Definition of done
- [ ] `git grep -nE 'wrapWithSecurity|wrapForSecurity|bool:\s*\{\s*must:\s*\[.*security' -- src/routes/` returns 0 matches.
- [ ] CI gate (added in T-10) passes against this PR's diff.
- [ ] Counter cardinality verified in staging: ≤ 20 unique label combinations after 1h of traffic.
- [ ] Zero behavior change on `routes/objects.ts` integration tests (regression baseline).

### Effort
**S** — 1 senior day. No migration, single-revert rollback.

---

## T-02 — Delete `/charts/{listogram,histogram,dateHistogram,auto}`; route frontend through `/charts/batch`

### Closes
B-1 (charts marking + branch bypass). Removes M-12 (dual implementation) and the 5000-row PG sample statistical defect.

### Scope
The four legacy chart endpoints (`src/routes/charts.ts:36-78`) and the helper they share (`loadObjectRows`, `:25-34`) are deleted. The frontend's call sites are migrated to `/charts/batch` (`:96-196`). The PG-direct read path `SELECT properties_json FROM object_instances LIMIT 5000` is removed from this surface entirely.

**Non-negotiable:** there is no "fix the legacy endpoints in place" path. The PG-direct read cannot be made secure without re-implementing `injectSecurityFilter` against PG, which duplicates the OpenSearch path. Delete is the cheaper and safer fix.

### Touches
- **Delete:** `src/routes/charts.ts:36-78` (handlers) and `:25-34` (`loadObjectRows`).
- **Delete:** `src/services/polarsAggregator.ts` if no remaining callers (verify via `git grep`).
- **Modify:** Frontend chart-call sites (out-of-tree; coordinate with FE team — see §"Coordination" below).
- **Modify:** `tests/**/charts*.test.ts` references to the four endpoints.

### Coordination
- Pre-PR: FE owner confirms `/charts/batch` covers all four chart shapes the legacy endpoints serve.
- Pre-PR: search the FE repo for `/api/v1/charts/(listogram|histogram|dateHistogram|auto)` and migrate.
- Backend PR removes the routes only after FE PR merges. Use a **two-phase deploy**:
  - Phase A: FE migrated, backend retains legacy routes (no-op).
  - Phase B (≥ 7 days later, after FE deployment fully rolled out): backend deletes routes.

### Acceptance criteria
- `git grep -nE 'router\.(get|post)\(["\\047]/(listogram|histogram|dateHistogram|auto)' -- src/routes/charts.ts` returns 0.
- Backend FE compatibility test: HTTP 404 on `POST /api/v1/charts/auto` with valid body.
- No call site in the FE repo references the legacy paths.

### Tests
- Add `tests/integration/charts-batch-parity.test.ts`: assert `/charts/batch` returns identical-shape response (modulo statistical accuracy) for a fixture that previously hit `/charts/auto`.

### Definition of done
- [ ] Phase A merged and deployed; FE confirmed migrated.
- [ ] Phase B merged and deployed; legacy routes return 404.
- [ ] `polarsAggregator.ts` removed if unreferenced; if referenced, ticket follow-up.

### Effort
**S** — 0.5 day backend, 1 day FE coordination. Real elapsed time bounded by FE deploy cadence.

### Depends on
T-01 (so `/charts/batch` correctly applies branch context before legacy endpoints are deleted).

---

## T-03 — SQL endpoint hardening: security-scoped DuckDB image, sandbox lockdown, statement timeout, admin-gated cache invalidation

### Closes
B-2 (RLS bypass + DuckDB egress + timeout drift), B-6 (`/sql/invalidate` DoS), H-13 (Furnace cache thundering herd).

### Scope
Three independent fatal defects in the SQL surface fixed in one PR because they all live in `src/services/furnaceSqlService.ts` and `src/routes/sql.ts`. Order of operations matters: the security-scoped cache key depends on the in-flight-promise mutex, which depends on the new cache shape.

### Touches
- **Modify:** `src/services/furnaceSqlService.ts:38-244` (substantially rewritten).
- **Modify:** `src/routes/sql.ts:14-46`.
- **New:** `src/services/furnaceSqlConstants.ts` (timeouts, allowlists).

### Implementation contract

#### 3.1 Cache key includes security fingerprint and branch
```ts
type CacheKey = string; // `${ontologyId}:${branchId ?? "_main"}:${securityFingerprint}`
const securityFingerprint = (ctx) =>
  crypto.createHash("sha256").update(JSON.stringify(buildSecurityFilter(ctx))).digest("hex").slice(0, 16);
```
Cache shape becomes `Map<CacheKey, { db: Database; loadedAt: number }>`. TTL = 30s (existing constant; reaffirmed).

#### 3.2 In-flight-promise mutex (closes H-13)
```ts
const PENDING: Map<CacheKey, Promise<Database>> = new Map();
async function getDb(key: CacheKey, ctx, branchId): Promise<Database> {
  const cached = CACHE.get(key);
  if (cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) return cached.db;
  const inflight = PENDING.get(key);
  if (inflight) return inflight;
  const promise = buildDb(ctx, branchId).finally(() => PENDING.delete(key));
  PENDING.set(key, promise);
  return promise;
}
```

#### 3.3 Build DB from OpenSearch with `applyContextToBody` (closes RLS bypass in B-2)
Replace the PG-direct dump in `buildDb`:
```ts
async function buildDb(ctx, branchId): Promise<Database> {
  const db = new Database(":memory:");
  configureSandbox(db); // see 3.4
  for (const ot of await listObjectTypes(ctx.ontologyId)) {
    const body = applyContextToBody({ size: 5000, query: { match_all: {} }, _source: true }, buildSecurityFilter(ctx), branchId);
    const { body: result } = await osClient.search({ index: indexFor(ot.api_name), body });
    const rows = (result.hits?.hits ?? []).map(h => ({ pk: h._source?.[ot.primary_key], data: h._source }));
    db.exec(`CREATE TABLE ${quoteIdent(ot.api_name)} (pk TEXT PRIMARY KEY, data JSON);`);
    const stmt = db.prepare(`INSERT INTO ${quoteIdent(ot.api_name)} VALUES (?, ?);`);
    for (const r of rows) stmt.run(r.pk, JSON.stringify(r.data));
  }
  return db;
}
```
The 5000-row sample is preserved as an explicit, documented limitation. Increase only with operator opt-in via `FURNACE_SAMPLE_LIMIT` env (range: 1000..50000).

#### 3.4 Sandbox lockdown (closes file/network egress in B-2)
```ts
function configureSandbox(db: Database): void {
  db.exec(`
    SET enable_external_access = false;
    SET disable_external_extensions = true;
    SET allow_unsigned_extensions = false;
    SET enable_http_metadata_cache = false;
    SET threads = 2;
    SET memory_limit = '512MB';
  `);
}
```
**Drop `pragma` from `ALLOWED_LEADING`** in `furnaceSqlService.ts:135`. New allowlist: `["select", "with", "describe", "show", "explain"]`.

The `INSTALL 'json'; LOAD 'json';` at `:55` is removed — the `read_json` and `read_csv_auto` functions become unavailable, which is the goal.

#### 3.5 Statement timeout (closes H-8)
```ts
const SQL_STATEMENT_TIMEOUT_MS = 10_000; // matches docstring promise

async function runUserSql(db: Database, sql: string): Promise<unknown[]> {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { db.interrupt(); } catch {}
      reject(appError("SQL_STATEMENT_TIMEOUT", `SQL exceeded ${SQL_STATEMENT_TIMEOUT_MS}ms.`));
    }, SQL_STATEMENT_TIMEOUT_MS);
    db.all(sql, (err, rows) => {
      clearTimeout(timer);
      if (err) reject(appError("SQL_EXECUTION_ERROR", err.message));
      else resolve(rows ?? []);
    });
  });
}
```

#### 3.6 `/sql/invalidate` admin gate (closes B-6)
```ts
router.post("/invalidate", requireRole("ontology-admin"), perOntologyRateLimit("1/min"), async (req, res, next) => {
  const { ontologyId } = req.body ?? {};
  if (typeof ontologyId !== "string" || ontologyId.length === 0) {
    return next(appError("VALIDATION_ERROR", "ontologyId is required."));
  }
  invalidateFurnaceCache(ontologyId);
  res.status(204).end();
});
```
`requireRole(role)` MUST check `req.security.cbac.includes(`role:${role}`)` and 403 with `INSUFFICIENT_ROLE` on miss.

### Error codes added
| Code | HTTP | Meaning |
|---|---|---|
| `SQL_STATEMENT_TIMEOUT` | 504 | Statement exceeded `SQL_STATEMENT_TIMEOUT_MS` |
| `SQL_EXECUTION_ERROR` | 400 | DuckDB-reported execution error |
| `INSUFFICIENT_ROLE` | 403 | Caller lacks required CBAC role |
| `SQL_DISALLOWED_KEYWORD` | 400 | Leading keyword not in allowlist |

### Metrics
```
tellus_sql_query_duration_seconds{outcome} histogram (buckets: 0.05,0.1,0.25,0.5,1,2,5,10)
tellus_sql_cache_hits_total{result} counter (result: "hit"|"miss"|"inflight_join")
tellus_sql_invalidate_total{by_role} counter
```
`outcome` ∈ `{"ok", "timeout", "execution_error", "rejected"}`.

### Performance contract
- Cache miss build: p95 ≤ 2s for ontology with ≤ 50 object types.
- Cached query: p95 ≤ 200ms for sub-1s SQL.
- Memory: ≤ 512MB per DuckDB instance (enforced by `memory_limit`).

### Tests
- **RLS:** two test users (`secret_alice` markings=`['SECRET']`, `none_bob` markings=`[]`) issue same SQL. `none_bob`'s response excludes rows that `secret_alice` sees.
- **Sandbox:** `SELECT * FROM read_csv_auto('/etc/passwd')` MUST return `SQL_EXECUTION_ERROR` (function unavailable). `PRAGMA enable_external_access=true; SELECT 1` MUST return `SQL_DISALLOWED_KEYWORD`.
- **Timeout:** `WITH RECURSIVE r AS (SELECT 1 UNION SELECT r.x+1 FROM r) SELECT count(*) FROM r LIMIT 1` MUST return `SQL_STATEMENT_TIMEOUT` after ≤ 10.5s.
- **Mutex:** 10 concurrent callers on same `(ontologyId, secFP, branch)` after TTL expiry result in 1 PG/OS load (not 10). Verified by counter `tellus_sql_cache_hits_total{result="inflight_join"}` ≥ 9.
- **Admin gate:** `POST /sql/invalidate` from non-admin returns 403; from admin without `ontologyId` returns 400; from admin with `ontologyId` returns 204.

### Definition of done
- [ ] All 5 test classes pass.
- [ ] Sandbox config verified by `db.all("SELECT * FROM duckdb_settings() WHERE name = 'enable_external_access'")` returning `false`.
- [ ] Removing T-03 from main results in two test failures (RLS + sandbox).

### Effort
**M** — 2.5 senior days.

### Depends on
T-01 (uses `applyContextToBody`).

---

## T-04 — Branch-aware writeback overlay (Redis schema migration)

### Closes
B-4 (overlay branch leak). Required for the entire branch-isolation guarantee to hold; without it, every other branch fix in this suite is bypassed.

### Scope
The overlay's `OverlayRecord` gains a required `branchId` field; the Redis keyspace becomes `overlay:${branchId}:${objectType}:${primaryKey}`. Every read site rejects records whose `branchId` does not match the request's `branchId`. Five-phase flag-gated rollout.

### Touches
- **Modify:** `src/services/overlay/overlayStore.ts` (`OverlayRecord` type, `overlayKey` function).
- **Modify:** `src/services/overlay/writebackOverlay.ts:181-228, 280-300` and the `put`/`get`/`delete` write side (paths to be confirmed during implementation).
- **Modify:** `src/routes/objects.ts:60-89, 519-540, 534`.
- **New:** `src/services/overlay/migrateOverlayKeys.ts` (rollout state machine).
- **New flag:** `OVERLAY_DUAL_WRITE` (boolean, default `true` during phases 1–3), `OVERLAY_READ_LEGACY` (boolean, default `true` during phases 1–4).

### Implementation contract

#### 4.1 Type changes
```ts
// overlayStore.ts
export interface OverlayRecord {
  branchId: string;       // NEW: required, "_main" sentinel for null branch
  objectType: string;
  primaryKey: string;
  payload: Record<string, unknown>;
  version: number;
  writtenAt: number;      // epoch ms
  expiresAt: number;
}

export function overlayKey(branchId: string | null, objectType: string, pk: string): string {
  return `overlay:${branchId ?? "_main"}:${objectType}:${pk}`;
}

export function legacyOverlayKey(objectType: string, pk: string): string {
  return `overlay:${objectType}:${pk}`;
}
```

#### 4.2 Read-side helper
```ts
async function readOverlay(branchId: string | null, ot: string, pk: string): Promise<OverlayRecord | null> {
  const newKey = overlayKey(branchId, ot, pk);
  const newVal = await store.get(newKey);
  if (newVal) return parseOverlayRecord(newVal);
  if (process.env.OVERLAY_READ_LEGACY !== "false") {
    const legacyVal = await store.get(legacyOverlayKey(ot, pk));
    if (legacyVal) {
      const rec = parseOverlayRecord(legacyVal);
      // legacy records have undefined branchId; serve them only on _main reads
      if (branchId === null) return rec;
    }
  }
  return null;
}
```

#### 4.3 Write-side helper
```ts
async function writeOverlay(rec: OverlayRecord): Promise<void> {
  const newKey = overlayKey(rec.branchId, rec.objectType, rec.primaryKey);
  // CAS on version (closes L-25)
  const existing = await store.get(newKey);
  if (existing) {
    const prev = parseOverlayRecord(existing);
    if (rec.version <= prev.version) {
      throw appError("OVERLAY_VERSION_CONFLICT", `Incoming v${rec.version} ≤ stored v${prev.version}.`);
    }
  }
  await store.setex(newKey, ttlSeconds(rec.expiresAt), serializeOverlayRecord(rec));
  if (process.env.OVERLAY_DUAL_WRITE !== "false" && rec.branchId === "_main") {
    await store.setex(legacyOverlayKey(rec.objectType, rec.primaryKey), ttlSeconds(rec.expiresAt), serializeOverlayRecord(rec));
  }
}
```

### Rollout state machine
| Phase | Duration | `OVERLAY_DUAL_WRITE` | `OVERLAY_READ_LEGACY` | Notes |
|---|---|---|---|---|
| 0 (pre-deploy) | — | n/a | n/a | T-04 PR merges to main with both flags `true` |
| 1 (read+write new and legacy) | ≥ 1× max overlay TTL | `true` | `true` | Bake; verify counter `tellus_overlay_legacy_hits_total` |
| 2 (write new only, read both) | ≥ 1× max overlay TTL after phase 1 | `false` | `true` | Legacy reads become drain-only |
| 3 (read new only) | indefinite | `false` | `false` | Legacy keys expire naturally via TTL |
| 4 (cleanup) | one-time job | n/a | n/a | Optional `SCAN MATCH overlay:[!_]*:*:*` reaper |

**Constraint:** phases 1→2 and 2→3 transitions are flag-flips (no redeploy). The deploy ordering matters: phase 1 must complete on every replica before phase 2 begins.

### Error codes added
| Code | HTTP | Meaning |
|---|---|---|
| `OVERLAY_VERSION_CONFLICT` | 409 | Incoming overlay version ≤ stored |
| `OVERLAY_BRANCH_MISMATCH` | 500 (internal) | Read returned a record with wrong `branchId` (should never fire post-phase-3; alert if it does) |

### Metrics
```
tellus_overlay_reads_total{branch_match, source} counter
  branch_match: "match"|"mismatch_rejected"
  source: "new_key"|"legacy_key"
tellus_overlay_writes_total{outcome} counter
  outcome: "ok"|"version_conflict"
tellus_overlay_legacy_hits_total counter  // monitors phase progression
```

### Tests
- Branch isolation: write on branch B with PK=`emp-1`, read on branch A with PK=`emp-1` returns null (or pre-edit value), not the branch-B payload.
- CAS: concurrent writes v3 and v2 on same PK — v3 wins, v2 returns `OVERLAY_VERSION_CONFLICT`.
- Legacy compatibility (phase 1): record written under legacy key is readable on `_main` branch reads.
- Legacy expiry (phase 3): legacy key reads return null.

### Definition of done
- [ ] Phase 1 deployed; `tellus_overlay_legacy_hits_total` non-zero in staging.
- [ ] Phase 2 deployed; `tellus_overlay_legacy_hits_total` decreasing; new writes only on new key (verified by `redis-cli SCAN MATCH 'overlay:*:*:*' COUNT 100`).
- [ ] Phase 3 deployed; cross-branch read test fails (correctly) for legacy-key edits.
- [ ] No `OVERLAY_BRANCH_MISMATCH` alerts in 7-day soak.

### Effort
**M** — 3.5 senior days, plus 1+ TTL window per phase. Real elapsed time: 1–2 weeks.

### Depends on
T-01 (so the read paths that consume the overlay propagate `branchId` correctly).

---

## T-05 — Export pipeline: IDOR fix + Temporal worker + signed download URLs

### Closes
B-5 (IDOR + Potemkin state machine).

### Scope
Two-phase fix. Phase A: close IDOR and remove the per-poll fakery in one ≤2-hour PR — frontend will see `RUNNING` indefinitely until phase B lands, which is correct. Phase B: implement the actual export worker as a Temporal activity that streams results to object storage and writes a signed URL to the job row.

### Touches
- **Phase A:** `src/routes/exports.ts:60-110`.
- **Phase B:** new `src/services/exports/exportWorker.ts`, `src/services/exports/exportWorkflows.ts`, schema migration for `export_job` table, optional `src/services/storageService.ts` extension.

### Phase A: IDOR + de-fake (S, ≤2h)

#### 5A.1 Add `requested_by` predicate to every query
```sql
SELECT * FROM export_job WHERE job_id = $1 AND requested_by = $2;
UPDATE export_job SET ... WHERE job_id = $1 AND requested_by = $2;
```

#### 5A.2 Remove the per-poll state advancement
Delete `routes/exports.ts:97-115` entirely. The handler returns the row as-is. Until the worker exists, jobs created in PENDING never advance — frontend correctly observes the stuck state.

#### 5A.3 Return 501 on download attempts
The route serving `/exports/:downloadToken.:format` (currently absent or 404-by-default) MUST be added with body `{"errorCode":"EXPORT_NOT_AVAILABLE","message":"Export pipeline is being migrated."}`. This converts the silent 404 into an actionable error.

#### 5A.4 Acceptance for phase A
- `GET /api/v1/ontology/:ontologyId/exports/:jobId` from user B for user A's job returns 404 (not 200, not 403 — the IDOR-prevention pattern from `routes/objects.ts:867-872`).
- A polling client sees `status: "PENDING"` indefinitely (until phase B).

### Phase B: Real worker (L, 5 senior days)

#### 5B.1 Schema migration (Flyway)
File: `db/migrations/V<N>__export_job_capture_security_context.sql`
```sql
ALTER TABLE export_job
  ADD COLUMN security_context_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN branch_id_snapshot TEXT NULL,
  ADD COLUMN started_at TIMESTAMPTZ NULL,
  ADD COLUMN completed_at TIMESTAMPTZ NULL,
  ADD COLUMN failed_at TIMESTAMPTZ NULL,
  ADD COLUMN failure_reason TEXT NULL,
  ADD COLUMN row_count BIGINT NULL,
  ADD COLUMN download_url_expires_at TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS idx_export_job_status_created
  ON export_job (status, created_at)
  WHERE status IN ('PENDING', 'RUNNING');

CREATE INDEX IF NOT EXISTS idx_export_job_requested_by
  ON export_job (requested_by, created_at DESC);
```
At job-creation time, `security_context_snapshot = JSON.stringify(buildSecurityFilter(req.security))` and `branch_id_snapshot = readBranchHeader(req)` are persisted. The worker uses these snapshots — the requester's session may have ended by the time the worker runs.

#### 5B.2 Temporal workflow + activity
- Workflow: `ExportJobWorkflow(jobId)` — orchestrates retries (3 attempts, exponential backoff 1s → 4s → 16s, max workflow runtime 1h).
- Activity: `executeExportActivity(jobId)` — non-idempotent inside the activity (uses Temporal's at-most-once-after-success semantics); idempotent at the workflow level via job state.

```ts
// exportWorker.ts (sketch)
async function executeExportActivity(jobId: string): Promise<void> {
  const job = await pgQueryOne(`SELECT * FROM export_job WHERE job_id = $1 FOR UPDATE`, [jobId]);
  if (job.status === "COMPLETED") return;
  await pgUpdate(`UPDATE export_job SET status='RUNNING', started_at=now() WHERE job_id=$1`, [jobId]);
  const sec = JSON.parse(job.security_context_snapshot);
  const branch = job.branch_id_snapshot;
  const writer = createFormatWriter(job.format); // csv|xlsx|jsonl
  const storageHandle = await storageService.openSignedUploadHandle(`exports/${jobId}.${job.format}`);
  let rowCount = 0;
  for await (const page of streamObjectSet(job.query_json, sec, branch, EXPORT_PAGE_SIZE)) {
    for (const row of page) { await writer.writeRow(storageHandle, row); rowCount++; }
    if (rowCount > MAX_EXPORT_ROWS) throw appError("EXPORT_LIMIT_EXCEEDED", `Exceeded ${MAX_EXPORT_ROWS} rows.`);
  }
  await writer.finalize(storageHandle);
  const signedUrl = await storageService.signedDownloadUrl(storageHandle, EXPORT_DOWNLOAD_TTL_MS);
  await pgUpdate(`
    UPDATE export_job SET status='COMPLETED', completed_at=now(), row_count=$2,
                          download_url=$3, download_url_expires_at=$4
    WHERE job_id=$1
  `, [jobId, rowCount, signedUrl, new Date(Date.now() + EXPORT_DOWNLOAD_TTL_MS)]);
}
```

#### 5B.3 Constants
| Constant | Value | Rationale |
|---|---|---|
| `EXPORT_PAGE_SIZE` | `1000` | Matches new pagination cap (T-09) |
| `MAX_EXPORT_ROWS` | `1_000_000` | Operator-overridable via env; aligns with Foundry Action edit cap order of magnitude |
| `EXPORT_DOWNLOAD_TTL_MS` | `24 * 60 * 60 * 1000` | 24h |
| `EXPORT_WORKFLOW_TIMEOUT_MS` | `60 * 60 * 1000` | 1h |
| `EXPORT_WORKFLOW_RETRIES` | `3` | Initial + 2 retries |

#### 5B.4 Error codes added
| Code | HTTP | Meaning |
|---|---|---|
| `EXPORT_LIMIT_EXCEEDED` | 400 | Job exceeded `MAX_EXPORT_ROWS`; mark FAILED |
| `EXPORT_NOT_AVAILABLE` | 501 | Phase A only; remove after phase B |
| `EXPORT_DOWNLOAD_EXPIRED` | 410 | Signed URL TTL elapsed |

#### 5B.5 Metrics
```
tellus_export_jobs_total{format, outcome} counter
  outcome: "completed"|"failed"|"timeout"
tellus_export_rows_streamed_total{format} counter
tellus_export_duration_seconds{format} histogram (buckets: 1,5,30,60,300,1800,3600)
```

### Tests
- IDOR (phase A): user B GET on user A's job_id → 404.
- Worker happy path: CSV export of 1000-row fixture completes; download_url returns expected MIME and row count.
- Worker security: export job created by user with `markings=['SECRET']`, run by worker, then session expires — exported file content reflects the original requester's marking set, not the empty set.
- Worker limit: fixture with `MAX_EXPORT_ROWS + 1` rows produces a `FAILED` job with `failure_reason = "EXPORT_LIMIT_EXCEEDED"`.
- Workflow retry: simulated transient failure on first attempt; second attempt completes.

### Definition of done
- [ ] Phase A merged ≤ day 1.
- [ ] Phase B merged ≤ day 5; `EXPORT_NOT_AVAILABLE` deleted from codebase.
- [ ] Production: 100% of jobs reach `COMPLETED` or `FAILED` within `EXPORT_WORKFLOW_TIMEOUT_MS`; no jobs stuck in `RUNNING` after 1h (alert on this).

### Effort
**L** — 5 senior days end-to-end (phase A 0.25d, phase B 4.75d).

### Depends on
T-01 (worker uses `applyContextToBody`).

---

## T-06 — Eliminate `|| "system"` auth fallback; enforce visibility on `/summary`

### Closes
H-8 (summary marking + auth fallback).

### Scope
Replace the four `(req as any).user?.id || "system"` fallbacks with a `currentUser(req)` helper that throws `UNAUTHORIZED`. Add marking + visibility filters to the four queries in `routes/summary.ts:43-66`.

### Touches
- **New:** `src/middleware/currentUser.ts` (helper).
- **Modify:** `src/routes/summary.ts:36-67`.
- **Modify:** `src/routes/explorations.ts:23-25`.
- **Modify:** `src/routes/exports.ts:60-62` (note: T-05 phase A may have already touched this file — coordinate).
- **Modify:** `src/routes/favorites.ts:25-27` (write side and read side).

### Implementation contract

#### 6.1 Helper
```ts
// src/middleware/currentUser.ts
import type { Request } from "express";
import { appError } from "../utils/errors";

export function currentUser(req: Request): string {
  const id = (req as Request & { user?: { id?: string } }).user?.id;
  if (typeof id !== "string" || id.length === 0) {
    throw appError("UNAUTHORIZED", "Missing authenticated user context.");
  }
  return id;
}
```

#### 6.2 Mass replace
Substitute the literal `(req as any).user?.id || "system"` and `(req as any).user?.id ?? "system"` patterns with `currentUser(req)`. The throw causes `appError` propagation to the global error handler; no per-route try/catch needed (verified against `globalAuth` chain at `server.ts:349`).

#### 6.3 Summary marking + visibility predicates
```sql
-- routes/summary.ts:43 (object types)
SELECT ot.api_name, ot.display_name, ot.icon_name, ot.icon_color, ot.status, ot.visibility
FROM object_type ot
WHERE ot.ontology_id = $1
  AND ot.visibility != 'hidden'
  AND (ot.marking_required IS NULL OR ot.marking_required <@ $2::text[]);
-- $2 = user's marking set (Postgres array containment)

-- routes/summary.ts:48 (groups) — analogous WHERE clause on object_type_group
```
For favorites and recents (which are user-scoped):
```sql
SELECT * FROM user_favorite WHERE user_id = $1 AND ontology_id = $2 ORDER BY created_at DESC LIMIT 20;
```
Note the `LIMIT 20` — `user_favorite` is unbounded otherwise.

#### 6.4 Schema requirement
`object_type.marking_required` (column type `TEXT[]`) and `object_type_group.marking_required` MUST exist. If absent, add a Flyway migration:
```sql
-- V<N>__add_marking_required_to_metadata.sql
ALTER TABLE object_type ADD COLUMN IF NOT EXISTS marking_required TEXT[];
ALTER TABLE object_type_group ADD COLUMN IF NOT EXISTS marking_required TEXT[];
CREATE INDEX IF NOT EXISTS idx_object_type_marking_gin ON object_type USING GIN (marking_required);
```
Default `NULL` ⇒ no marking required (visible to all). Existing rows are unchanged.

### Error codes added
| Code | HTTP | Meaning |
|---|---|---|
| `UNAUTHORIZED` | 401 | Missing/invalid `req.user` (already exists; add to per-route `KNOWN_CODES` registries) |

### Tests
- Phantom-user test: spoof a request with `req.user = undefined`; assert all four routes return 401, not 200.
- Marking filter: user with `markings=[]` GETs `/summary` for an ontology containing one type with `marking_required=['SECRET']`. Response excludes that type.
- Hidden visibility: type with `visibility='hidden'` is absent from response.
- Favorites/recents scoping: user A's favorites do not appear in user B's `/summary` response.

### Definition of done
- [ ] `git grep -nE "user\?\.id\s*\|\|\s*['\"]system['\"]" -- src/` returns 0.
- [ ] `git grep -nE "user\?\.id\s*\?\?\s*['\"]system['\"]" -- src/` returns 0.
- [ ] All four tests pass.

### Effort
**S** — 0.5 senior day.

### Depends on
None. Parallel with everything except files also touched by T-05 (exports.ts).

---

## T-07 — Unified error envelope + verbose-404 gate

### Closes
H-9 (catalog leak in 404), H-10 (envelope drift).

### Scope
One envelope shape across the entire `object-explorer` surface; one error-code vocabulary; production-mode verbose-message gate.

### Touches
- **Modify:** `src/utils/responseFormatter.ts` (`sendError` becomes the single source).
- **Modify:** `src/utils/errors.ts` (single `ErrorCode` const enum).
- **Modify:** every route file in `src/routes/` (replace direct `res.status(...).json({...})` with `sendError(res, err)`).
- **Modify:** `src/routes/objects.ts:122-132` (`ensureObjectTypeExists`).

### Implementation contract

#### 7.1 Canonical envelope
```ts
export interface ErrorEnvelope {
  errorCode: string;        // machine-readable, snake_screaming
  errorName: string;        // human-readable PascalCase
  message: string;          // user-safe message; never includes stack, paths, or unfiltered input
  statusCode: number;
  requestId: string;        // from req.requestId (server.ts:160-162)
  parameters?: Record<string, unknown>;  // structured, validated against an allowlist
  // Legacy compat shim — REMOVE in a follow-up minor:
  error: { code: string; message: string };
}
```

#### 7.2 Error vocabulary (the only allowed codes)
```ts
export const ErrorCodes = {
  // 4xx
  VALIDATION_ERROR: { http: 400, name: "ValidationError" },
  MALFORMED_JSON: { http: 400, name: "MalformedJson" },
  PAYLOAD_TOO_LARGE: { http: 413, name: "PayloadTooLarge" },
  INVALID_PAGE_TOKEN: { http: 400, name: "InvalidPageToken" },
  INVALID_PARAMETER: { http: 400, name: "InvalidParameter" },
  UNAUTHORIZED: { http: 401, name: "Unauthorized" },
  FORBIDDEN: { http: 403, name: "Forbidden" },
  INSUFFICIENT_ROLE: { http: 403, name: "InsufficientRole" },
  OBJECT_TYPE_NOT_FOUND: { http: 404, name: "ObjectTypeNotFound" },
  OBJECT_NOT_FOUND: { http: 404, name: "ObjectNotFound" },
  LINK_TYPE_NOT_FOUND: { http: 404, name: "LinkTypeNotFound" },
  PROPERTY_NOT_FOUND: { http: 404, name: "PropertyNotFound" },
  RATE_LIMITED: { http: 429, name: "RateLimited" },
  // 4xx domain-specific
  SQL_DISALLOWED_KEYWORD: { http: 400, name: "SqlDisallowedKeyword" },
  SQL_EXECUTION_ERROR: { http: 400, name: "SqlExecutionError" },
  EXPORT_LIMIT_EXCEEDED: { http: 400, name: "ExportLimitExceeded" },
  EXPORT_DOWNLOAD_EXPIRED: { http: 410, name: "ExportDownloadExpired" },
  OVERLAY_VERSION_CONFLICT: { http: 409, name: "OverlayVersionConflict" },
  SEARCH_AROUND_LIMIT_EXCEEDED: { http: 400, name: "SearchAroundLimitExceeded" },
  // 5xx
  OPENSEARCH_ERROR: { http: 502, name: "OpensearchError" },
  SQL_STATEMENT_TIMEOUT: { http: 504, name: "SqlStatementTimeout" },
  INTERNAL_ERROR: { http: 500, name: "InternalError" },
} as const;
export type ErrorCode = keyof typeof ErrorCodes;
```
**Removed (do not re-introduce):** `CHART_ERROR`, `SQL_ERROR`, `VALIDATION_FAILED`, `NOT_FOUND`, `LINK_CYCLE_DETECTED`. Migrations: `LINK_CYCLE_DETECTED` → `VALIDATION_ERROR` with `parameters.subtype = "link_cycle"`.

#### 7.3 `sendError` is the only writer
```ts
export function sendError(res: Response, err: AppError | Error): void {
  const code: ErrorCode = (err as AppError).code ?? "INTERNAL_ERROR";
  const def = ErrorCodes[code];
  const requestId = (res.req as any).requestId ?? "unknown";
  const env: ErrorEnvelope = {
    errorCode: code,
    errorName: def.name,
    message: sanitizeMessage(err.message),
    statusCode: def.http,
    requestId,
    ...(err instanceof AppError && err.parameters ? { parameters: err.parameters } : {}),
    error: { code, message: sanitizeMessage(err.message) },
  };
  res.status(def.http).json(env);
}
```
`sanitizeMessage` strips file paths, IPs, stack traces (any string matching `/at\s+\S+\s+\(.+:\d+:\d+\)/`), and SQL fragments.

#### 7.4 Verbose-404 gate (closes H-9)
```ts
// src/routes/objects.ts (replacing :122-132)
async function ensureObjectTypeExists(objectType: string): Promise<void> {
  const r = await query("SELECT 1 FROM object_type WHERE api_name = $1", [objectType]);
  if (r.rows.length === 0) {
    const debug = process.env.NODE_ENV !== "production" && process.env.TELLUS_DEBUG_404 === "true";
    const msg = debug ? `Object type '${objectType}' not found. (Hint: check api_name spelling.)` : "Object type not found.";
    throw appError("OBJECT_TYPE_NOT_FOUND", msg);
  }
}
```
Note: `NODE_ENV !== "production"` alone is not enough — staging often runs as `production`. The dual gate (`NODE_ENV !== "production" AND TELLUS_DEBUG_404 === "true"`) ensures verbose mode is opt-in even in dev.

#### 7.5 Replace per-route `res.status(...).json(...)` calls
Audit-citation map:
- `src/routes/sql.ts:30,33` — replace.
- `src/routes/charts.ts:42,52,62,77,194` — replace.
- `src/routes/objects.ts:147-153` — replace.
- `src/routes/objectViews.ts:55-58` — replace.
- `src/server.ts:217-244` — bring into alignment with new envelope (drop `success: false` legacy field).
- `src/middleware/globalAuth.ts:160-178` — bring into alignment.

### Tests
- Envelope parity: every error response body parses against `ErrorEnvelope` JSON Schema.
- 404 catalog leak: `GET /api/v1/objects/foo/bar` (where `foo` does not exist) in production-config returns body without any other type names.
- Forbidden code: a route attempting to throw `appError("CHART_ERROR", ...)` fails type-check (TypeScript `ErrorCode` type guard).

### Definition of done
- [ ] `git grep -nE "errorCode\s*:\s*['\"]CHART_ERROR['\"]|['\"]VALIDATION_FAILED['\"]" -- src/` returns 0.
- [ ] `git grep -nE "res\.status\([0-9]+\)\.json\(\s*\{\s*(error|success)" -- src/routes/` returns 0 (only `sendError` writes errors).
- [ ] JSON schema check passes against fixture responses from all 9 route files.

### Effort
**M** — 1.5 senior days (mostly mechanical replacement).

### Depends on
None.

---

## T-08 — Saved Explorations: visibility check on single-GET; marking-aware config tagging

### Closes
H-11 (saved exploration leak).

### Scope
Two defects in `routes/explorations.ts`. Single-exploration GET (`:71-83`) currently has no visibility check — any user can read any exploration by ID. List endpoint (`:55-66`) filters on visibility but the saved `config:jsonb` may reference SECRET-marked properties; users without those markings can read the filter shape even if they cannot run it.

### Touches
- **Modify:** `src/routes/explorations.ts:23-25, 55-66, 71-83`.
- **New:** `src/services/explorations/configMarkingResolver.ts`.
- **Modify:** schema (Flyway migration).

### Implementation contract

#### 8.1 Schema migration
```sql
-- V<N>__exploration_required_markings.sql
ALTER TABLE saved_exploration ADD COLUMN required_markings TEXT[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS idx_saved_exploration_markings_gin ON saved_exploration USING GIN (required_markings);
```

#### 8.2 Marking resolution at write time
```ts
// configMarkingResolver.ts
export async function resolveRequiredMarkings(config: ExplorationConfig): Promise<string[]> {
  const refs = collectObjectTypeRefs(config); // walks config.filters tree
  const markings = new Set<string>();
  for (const apiName of refs) {
    const ot = await pgQueryOne(
      `SELECT marking_required FROM object_type WHERE api_name = $1`,
      [apiName],
    );
    for (const m of ot?.marking_required ?? []) markings.add(m);
    // Also walk filtered properties:
    for (const propName of collectFilteredProps(config, apiName)) {
      const prop = await pgQueryOne(
        `SELECT marking_required FROM property WHERE object_type_id = (SELECT object_type_id FROM object_type WHERE api_name = $1) AND api_name = $2`,
        [apiName, propName],
      );
      for (const m of prop?.marking_required ?? []) markings.add(m);
    }
  }
  return [...markings].sort();
}
```

#### 8.3 Visibility filter on read
List query (`:55-66`):
```sql
SELECT * FROM saved_exploration
WHERE ontology_id = $1
  AND (visibility IN ('shared','public') OR owner_id = $2)
  AND required_markings <@ $3::text[]
ORDER BY updated_at DESC LIMIT 100;
-- $3 = user's marking set
```
Single-GET (`:71-83`):
```sql
SELECT * FROM saved_exploration
WHERE exploration_id = $1
  AND ontology_id = $2
  AND (visibility IN ('shared','public') OR owner_id = $3)
  AND required_markings <@ $4::text[];
```
Returns 404 (`OBJECT_NOT_FOUND` with `parameters.kind = "saved_exploration"`) if no row matches — IDOR-prevention pattern from T-07.

#### 8.4 Re-resolve on update
Any PATCH/PUT that modifies `config` MUST re-run `resolveRequiredMarkings` and update the column atomically.

### Error codes
| Code | HTTP | Meaning |
|---|---|---|
| `OBJECT_NOT_FOUND` | 404 | Existing code; reuse with `parameters.kind = "saved_exploration"` |

### Metrics
```
tellus_saved_exploration_marking_misses_total counter  // increment when a user's read is filtered by markings
```

### Tests
- IDOR: user without SECRET markings GETs an exploration whose `required_markings = ['SECRET']` by ID → 404.
- List filter: same user lists explorations; SECRET-marked ones absent.
- Re-resolve: PATCH updating `config` to remove SECRET reference recomputes `required_markings = []`.

### Definition of done
- [ ] Backfill job: existing rows have `required_markings` computed (Flyway data migration or one-time script).
- [ ] Tests pass.

### Effort
**M** — 1.5 senior days.

### Depends on
T-06 (uses `currentUser`).

---

## T-09 — Multi-hop Search Around correctness + full-text spec syntax + pagination cap

### Closes
H-12 (multi-hop N+1 + cycle), H-14 (full-text syntax), L-23 (page-size cap).

### Scope
Three independent, well-scoped surgical fixes on the read path. Bundled because each is small, all touch query semantics, and all share the same test surface.

### Touches
- **Modify:** `src/services/linkResolverService.ts:805-880` (`resolveMultiHop`).
- **Modify:** `src/services/queryExecutor.ts:288-360` (full-text builder).
- **Modify:** `src/services/queryValidator.ts:651` (`MAX_PAGE_SIZE`).

### 9.1 Multi-hop traversal (closes H-12)
```ts
// linkResolverService.ts:805-880 — replacement
const MULTI_HOP_CONCURRENCY = 50;
const MAX_INTERMEDIATE = 100_000;  // accumulated, not per-hop (resolves spec ambiguity §7.8)

export async function resolveMultiHop(steps: HopStep[], startingPKs: string[], ctx, branchId): Promise<HopResult> {
  const visitedPKs = new Set<string>(startingPKs);
  let currentPKs: string[] = [...startingPKs];
  for (let i = 0; i < steps.length; i++) {
    if (visitedPKs.size > MAX_INTERMEDIATE) {
      throw appError("SEARCH_AROUND_LIMIT_EXCEEDED", `Accumulated visited PKs (${visitedPKs.size}) exceeded ${MAX_INTERMEDIATE}.`);
    }
    const step = steps[i];
    const newPKs = new Set<string>();
    for (const chunk of chunked(currentPKs, MULTI_HOP_CONCURRENCY)) {
      const results = await Promise.all(
        chunk.map(pk => resolveLinks(step.linkType, pk, step.direction, ctx, branchId)),
      );
      for (const result of results) {
        for (const obj of result.linkedObjects) {
          const pk = String(obj.__pk ?? "");
          if (pk && !visitedPKs.has(pk)) {
            newPKs.add(pk);
            visitedPKs.add(pk);
          }
        }
      }
    }
    currentPKs = [...newPKs];
  }
  return { pks: currentPKs, totalVisited: visitedPKs.size };
}
```

### 9.2 Full-text spec syntax (closes H-14)
```ts
// queryExecutor.ts:288-360 — additive change
const SPEC_SYNTAX_RE = /[~*?"]|\b(AND|OR|NOT)\b|[()]/;
const ANALYZE_WILDCARD_ENABLED = process.env.TELLUS_FT_ANALYZE_WILDCARD === "true";

function buildFullTextQuery(searchText: string, fields: string[]): Record<string, unknown> {
  const should: Record<string, unknown>[] = [
    { multi_match: { query: searchText, fields, type: "cross_fields", operator: "AND" } },
    { multi_match: { query: searchText, fields, type: "best_fields", fuzziness: "AUTO" } },
  ];
  if (SPEC_SYNTAX_RE.test(searchText)) {
    should.push({
      query_string: {
        query: searchText,
        fields,
        default_operator: "AND",
        analyze_wildcard: ANALYZE_WILDCARD_ENABLED,
        allow_leading_wildcard: false,  // hard guarantee per Foundry §3 footnote
        lenient: true,                  // tolerate field-type mismatch on broad searches
      },
    });
  }
  return { bool: { should, minimum_should_match: 1 } };
}
```
**Note on `allow_leading_wildcard: false`:** OpenSearch's leading-wildcard match is O(n) on term dictionary; with millions of objects, this is the difference between a 50ms query and a 30s query. Spec §69 footnote permits operator opt-in.

### 9.3 Pagination cap (closes L-23)
```ts
// queryValidator.ts:651 — value change
export const MAX_PAGE_SIZE = 1000;     // was 10000 (Foundry default per §7)
export const MAX_PAGE_SIZE_OPT_IN = 2000;  // accessible via header
// In handler:
const pageSize = Math.min(
  body.pageSize ?? 100,
  req.headers["x-tellus-large-page"] === "true" ? MAX_PAGE_SIZE_OPT_IN : MAX_PAGE_SIZE,
);
```

### Error codes added
| Code | HTTP | Meaning |
|---|---|---|
| `SEARCH_AROUND_LIMIT_EXCEEDED` | 400 | Accumulated `visitedPKs` exceeded `MAX_INTERMEDIATE` |

### Metrics
```
tellus_search_around_visited_pks histogram (buckets: 100,1000,10000,100000)
tellus_search_around_hops histogram (buckets: 1,2,3,4,5)
tellus_full_text_spec_syntax_total{syntax_used} counter (syntax_used: "true"|"false")
tellus_pagination_size histogram (buckets: 10,100,500,1000,2000)
```

### Performance contract
- Single-hop search around p95 ≤ 500ms for ≤ 1000 starting PKs.
- 5-hop search around p95 ≤ 5s for ≤ 100 starting PKs.
- Full-text query p95 ≤ 800ms for typical fielded search.

### Tests
- Cycle: data-level cycle A→B→A traversed for 5 hops returns ≤ 2 unique PKs (not duplicates).
- Concurrency: 1000 starting PKs × 1 hop completes in O(1000/50) round-trips, not 1000.
- Full-text syntax: `"yellow cab" AND status:active` returns matches for documents where both phrase and term-eq are satisfied; bare `yellow cab` does not (different result set).
- Leading wildcard: `*foo` returns `INVALID_PARAMETER` (or Lucene parser error wrapped as `VALIDATION_ERROR`) when `ANALYZE_WILDCARD_ENABLED=false`.
- Page cap: request with `pageSize=10000` and no opt-in header returns 1000 rows.

### Definition of done
- [ ] All four test classes pass.
- [ ] Full-text fuzz test (1000 random spec-syntax strings) does not crash the executor.
- [ ] No regression on existing search-around integration tests.

### Effort
**M** — 1.5 senior days.

### Depends on
T-01 (uses branchId-aware resolveLinks).

---

## T-10 — Observability uniformity + AST-level contract test in CI

### Closes
H-15 (uneven metrics + missing trace IDs in logs), H-16 (no contract tests + missing AST guard).

### Scope
Two artifacts that together prevent regression of every blocker in this suite. The AST guard would have caught B-1, B-3, H-7, H-8 at PR review.

### Touches
- **New:** `src/utils/routeInstrumentation.ts` (`routeMetric`, `routeLog`).
- **New:** `tests/contract/routeContractGuard.test.ts` (ts-morph AST walker).
- **New:** `tests/integration/object-explorer/<route>.test.ts` per route (8 files).
- **Modify:** every handler in the 9 explorer route files to call `routeMetric` and `routeLog`.

### Implementation contract

#### 10.1 Instrumentation helper
```ts
// src/utils/routeInstrumentation.ts
import type { Request } from "express";
import { incCounter, observeHistogram } from "./metrics";

export type RouteName =
  | "objects.search" | "objects.searchFullText" | "objects.searchAround"
  | "objects.get" | "objects.linked" | "objects.editHistory"
  | "objectViews.single" | "objectViews.batch"
  | "charts.batch" | "comparisons.aggregate"
  | "summary.bundle" | "explorations.list" | "explorations.get" | "explorations.create" | "explorations.update"
  | "exports.create" | "exports.list" | "exports.get"
  | "favorites.list" | "favorites.toggle"
  | "sql.execute" | "sql.invalidate";

export function routeMetric(req: Request, route: RouteName, branchId: string | null): void {
  incCounter("tellus_read_branch_filtered_total", {
    route,
    scoped: branchId !== null ? "true" : "false",
  });
}

export function routeLog(req: Request, route: RouteName, status: number, durationMs: number, extras: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({
    level: "info",
    type: "route_call",
    route,
    status,
    durationMs,
    requestId: (req as any).requestId,
    traceId: (req as any).traceId,
    user: (req as any).user?.id,
    ...extras,
  }));
  observeHistogram("tellus_route_duration_seconds", durationMs / 1000, { route, status_class: `${Math.floor(status / 100)}xx` });
}
```

#### 10.2 Apply to every handler
Every modified route file gets:
```ts
const start = Date.now();
try {
  // ... existing handler ...
  routeMetric(req, "objects.search", branchId);
  routeLog(req, "objects.search", 200, Date.now() - start, { hits: result.totalHits });
  return res.json(result);
} catch (err) {
  routeLog(req, "objects.search", err.statusCode ?? 500, Date.now() - start, { errorCode: err.code });
  throw err;
}
```

#### 10.3 AST-level contract test
```ts
// tests/contract/routeContractGuard.test.ts
import { Project, SyntaxKind } from "ts-morph";
import { describe, it, expect } from "vitest";

const READ_HANDLER_NAME_RE = /search|aggregate|view|chart|sql|compar|linked|summary|list|get/i;
const READ_FILES = [
  "src/routes/objects.ts", "src/routes/objectViews.ts", "src/routes/charts.ts",
  "src/routes/sql.ts", "src/routes/summary.ts", "src/routes/comparisons.ts",
  "src/routes/explorations.ts", "src/routes/favorites.ts",
];

describe("Route contract guard", () => {
  const project = new Project({ tsConfigFilePath: "tsconfig.json" });
  for (const file of READ_FILES) {
    const sf = project.addSourceFileAtPath(file);
    sf.getDescendantsOfKind(SyntaxKind.CallExpression).forEach(call => {
      const text = call.getText();
      // Find handler arrow functions / functions whose name matches READ_HANDLER_NAME_RE
      // For each, assert it contains a call to buildSecurityFilter and to readBranchHeader (or is in EXEMPT_LIST)
    });

    it(`${file} - every read handler calls buildSecurityFilter and readBranchHeader`, () => {
      const handlers = collectReadHandlers(sf, READ_HANDLER_NAME_RE);
      for (const h of handlers) {
        const body = h.getBodyText() ?? "";
        if (EXEMPT_LIST.includes(`${file}::${h.name}`)) continue;
        expect(body, `${file}::${h.name} must call buildSecurityFilter`).toMatch(/buildSecurityFilter\s*\(/);
        expect(body, `${file}::${h.name} must call readBranchHeader`).toMatch(/readBranchHeader\s*\(/);
        expect(body, `${file}::${h.name} must call routeMetric`).toMatch(/routeMetric\s*\(/);
      }
    });
  }
});

const EXEMPT_LIST: string[] = [
  // explicit, code-reviewed exemptions only — every entry requires a justification comment
];
```

#### 10.4 Per-route handler tests
Every route gets at minimum:
- happy-path test
- 4xx-input test (malformed body)
- unauthorized test (`req.user = undefined`)
- empty-marking test (asserts marked rows excluded)
- cross-branch test (asserts branch isolation)

Use `supertest` against an Express app harness with mocked `osClient`, `pgClient`, and `overlayStore`.

### Metrics
```
tellus_route_duration_seconds{route, status_class} histogram
  (buckets: 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10)
tellus_read_branch_filtered_total{route, scoped} counter  // already added by T-01
```
Cardinality bound: `route` ≤ 22 unique values; `status_class` ∈ `{"2xx","3xx","4xx","5xx"}`; `scoped` ∈ `{"true","false"}`. Total cardinality per metric ≤ 88 + 44 = 132 series. Document in observability runbook.

### SLOs (define and instrument; alert on burn rate)
| Endpoint | p95 latency | Error rate (5xx) |
|---|---|---|
| `/objects/:type/search` | ≤ 500ms | ≤ 0.1% |
| `/objects/:type/:pk` | ≤ 200ms | ≤ 0.1% |
| `/objects/:type/searchAround` | ≤ 3s | ≤ 0.5% |
| `/charts/batch` | ≤ 2s | ≤ 0.5% |
| `/comparisons/aggregate` | ≤ 2s | ≤ 0.5% |
| `/sql` | ≤ 5s (cached); ≤ 12s (cold) | ≤ 1% |
| `/summary` | ≤ 300ms | ≤ 0.1% |

### Tests
- AST guard: a deliberate PR removing `buildSecurityFilter` from one handler MUST fail CI.
- Trace propagation: a request with `traceparent` header has a `traceId` field in every `routeLog` line and in any error envelope.
- Cardinality: synthetic load with 50 distinct user IDs produces no more than 132 series for `tellus_route_duration_seconds`.

### Definition of done
- [ ] `tests/contract/routeContractGuard.test.ts` runs in CI on every PR.
- [ ] 8 per-route integration tests passing.
- [ ] Grafana dashboard exists with the seven SLOs above.
- [ ] PagerDuty alerts wired on burn-rate (1h × 14.4 burn = page; 6h × 6 burn = ticket).

### Effort
**L** — 5 senior days (instrumentation 1d, AST guard 0.5d, 8 route test files 3d, Grafana + alerts 0.5d).

### Depends on
T-01 through T-09 (it tests them).

---

## 11. Out of scope: what these 10 tasks do NOT close (~20 follow-up tasks for 100% Foundry parity)

The ten tasks above bring `object-explorer` to **production-credible-under-audit** for the surface that exists today. They do **not** achieve 100% Palantir Foundry feature parity. Reaching 100% requires the following additional task suites, which are intentionally out of scope here and should be tracked separately in the v3 implementation suite:

### 11.1 Foundry semantic contract gaps (cf. C-IDs in the gap analysis)
| Task family | Closes | Effort estimate |
|---|---|---|
| **F-1** Full `ObjectSetDefinition` discriminated union (`union/intersect/subtract/reference/static/withProperties`) with logical-plan IR | C-01 | 2 weeks |
| **F-2** `loadObjectsMultipleObjectTypes`, `loadObjectsOrInterfaces`, `createTemporary` endpoints | C-02 | 1.5 weeks |
| **F-3** Query-string `?branch` and `?transactionId` parameters (alongside header) | C-03 | 2 days |
| **F-4** `AggregationGroupByV2.accuracy`, `excludedItems`, 10K bucket cap enforcement, `maxGroupCount` | C-08 | 3 days |
| **F-5** Search Around Spark fallback above 100K | C-18 | 2 weeks |
| **F-6** KNN `nearestNeighbors(k, vector)`, Vector base type, OpenSearch HNSW index template | C-10, C-32 (Vector) | 2 weeks |
| **F-7** `Resource RID` server-side rendering with permission check | C-20 | 4 days |
| **F-8** Mandatory Control Properties (row-gating MCP base type) | C-14 | 1.5 weeks |
| **F-9** Multi-Datasource Object Types (per-source policies, conflict resolution) | C-34 | 3 weeks |
| **F-10** Saved Lists (frozen-PK snapshot) distinct from Saved Explorations | C-36 | 1 week |

### 11.2 Cross-cutting platform contracts
| Task family | Closes | Effort estimate |
|---|---|---|
| **P-1** Per-query compute budget enforcement (4cs OSv2 / 16cs OSv1) | C-21 | 1 week |
| **P-2** Full audit.3 schema emitter for every read with categories/requestFields/resultFields | C-23 | 1.5 weeks |
| **P-3** AIMD client-side concurrency limiter + circuit breakers (Dialogue pattern) on PG, OpenSearch, Keycloak | C-24 | 1 week |
| **P-4** Conjure typed error namespaces (replace string `errorCode` with `namespace + code` tuples) | C-04 | 4 days |
| **P-5** OAuth2 scope enforcement (`api:ontologies-read/write`, `api:use-ontologies-read`) | C-27 | 3 days |
| **P-6** OpenTelemetry traces across `object-explorer → ontology-manager → object-types/link-types` | C-25 | 1 week |
| **P-7** OMS facade service replacing direct PG access at `routes/objects.ts:122-132`, `objectViews.ts:73-83`, `charts.ts:25-30`, `furnaceSqlService.ts:64` | C-31 | 1.5 weeks |

### 11.3 Adjacent subsystems (separate contracts, blocking 100% parity but not `object-explorer` alone)
| Task family | Effort estimate |
|---|---|
| **A-1** Action service: `applyBatch`, `clientRequestId` idempotency, StaleObject CAS, cross-backend Actions | 4 weeks |
| **A-2** Functions on Objects: TS v1/v2/Python runtimes, OSDK bindings | 6 weeks |
| **A-3** AIP integration: Object query / Action / Function tools, Ontology-context KNN retrieval | 3 weeks |
| **A-4** Foundry Branching: proposal / merge / approval workflow | 4 weeks |
| **A-5** Funnel-equivalent indexer: Spark batch + Flink streaming + 80% reindex threshold + most-recent-transaction-wins | 8 weeks |

**Total to 100% Foundry parity: ~25–30 additional senior-engineer-weeks beyond T-01..T-10.**

---

## 12. Dependency DAG

```
T-01 ──┬─→ T-02
       ├─→ T-03
       ├─→ T-05
       ├─→ T-09
       └─→ T-10
                T-04 ──→ T-10
                T-06 ──┬→ T-08
                       └→ T-10
                T-07 ──→ T-10
```

### Parallelization plan (2 senior engineers, 10 elapsed days)

**Engineer A track:** T-01 (1d) → T-02 (0.5d, blocks on FE coordination) → T-03 (2.5d) → T-09 (1.5d) → T-10 instrumentation half (1d). **Total: 6.5 working days.**

**Engineer B track:** T-04 (3.5d, gated by phase TTL bakes — calendar elapsed ≥ 7 days) ‖ T-06 (0.5d) ‖ T-07 (1.5d) ‖ T-08 (1.5d) ‖ T-05 phase A (0.25d) → T-05 phase B (4.75d) → T-10 test-suite half (4d). **Total: ~10 working days, calendar-bounded by T-04 phase bakes.**

### Gating constraints
- T-04 cannot start phase 2 until phase 1 has soaked for ≥ one max overlay TTL on every replica. Plan ≥ 7 calendar days for safety.
- T-05 phase B requires a Temporal worker fleet with capacity for `EXPORT_WORKFLOW_RETRIES × max_concurrent_exports` activity slots. Validate fleet sizing before merge.
- T-10's AST guard merges only after T-01..T-09 all merge — otherwise it would gate its own dependencies on failing assertions.

### Release cut criteria
A release tagged `object-explorer-1.0` is permitted only when:
1. T-01..T-10 all merged to `main`.
2. T-04 in phase 3 (legacy keys no longer read) on production.
3. T-05 phase B deployed; zero `EXPORT_NOT_AVAILABLE` errors in production for ≥ 48h.
4. T-10 AST guard green on `main` for ≥ 7 days.
5. SLOs in §10's table met for ≥ 7 days at production traffic levels.

Anything less, the release does not ship.