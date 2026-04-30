# Tellus Ontology Platform — Production-Readiness Report

**Auditor:** Staff/Principal Engineer, 20-year Palantir Foundry Ontology background.
**Audit date:** 2026-04-23.
**Target tenant:** Rwanda Revenue Authority (RRA).
**Target deployment stack:** Fastify + Kubernetes (confirmed by repo owner).
**Target SLOs (per `docs/remediation/phase-a-closure.md:162`, confirmed current):** 200 reads/s, 50 actions/s, p99 reads < 250 ms, p99 actions < 800 ms, 99.9% availability.
**Regulatory anchor:** Rwandan Law No. 058/2021 (Data Protection), cited at `docs/remediation/phase-a-closure.md:166`.
**Scope:** full API surface — ontology core, link resolver, action pipeline, branching, search, audit, HTTP middleware, migrations, secrets, multi-tenancy.

---

## 0. Verdict

**NO-GO for production.**

Not a coverage-gap verdict. A **design-gap** verdict. 6-phase audit produced **77 findings**, of which **16 are P0** (data loss, corruption, security bypass, Markings leak, or silent incorrect results). Each P0 alone is, by the briefing's Section 11, a non-negotiable production blocker.

Tests pass 1067/3/0 deterministically across three runs, but **12 are ghost-passes** (assertion-free early returns). Phase A's claimed 64.64% critical-path branch coverage is **not reproducible from committed tooling** — independently measured it is **43.34%**.

**Conditional-Go is not currently available.** The conditions are re-implementations of four subsystems (branching, audit durability, link cardinality, tenant isolation) plus elimination of every hardcoded credential fallback.

**Estimated engineering effort to reach Conditional-Go: 14–18 engineer-weeks with a team of 3 senior engineers**, before any Fastify migration work begins.

---

## 1. What "Production-Ready" Means Here

All of the following must hold:

1. **No P0 findings outstanding.**
2. **All stated SLOs measurable in production** — per-route RED histograms, pool saturation gauges, cache-hit-rate counters, event-loop-lag metric. If "are we at SLO?" is not answerable from a dashboard at 03:00, you are not production-ready.
3. **80% branch coverage reproducible from CI** on critical-path modules (action apply, branch merge, link violation, read security filter, indexing, audit emission).
4. **Three consecutive deterministic suite runs with zero ghost-passes**.
5. **Kubernetes-compatible**: rate limiting, circuit breakers, cache invalidation, JWKS state coordinated across replicas. PgBouncer between app and PG.
6. **Secrets in a vault**, injected via K8s External Secrets / CSI driver. No `|| 'tellus123'` or `|| 'minioadmin'` anywhere in source.
7. **Regulatory audit trail**: every read/write emitted, durable **before** ack, tamper-evident (hash-chain or WORM).
8. **Branch isolation verified by test**: reader on branch B cannot see uncommitted writes from branch A. Currently: can. Schema cannot even express the isolation.
9. **Palantir Ontology contract fidelity**: PK uniqueness at write time, cardinality enforced at write time, two-phase Action commit, three-way merge with real base-value diff, pre-query Markings filter on every read path.
10. **Fastify migration path locked in** as strangler-fig, not big-bang.

None of (1)-(9) satisfied today.

---

## 2. The 16 P0 Findings — Hard Evidence

### 2.1 Branching — 3 P0s, Structurally Non-Functional

Palantir's branching contract, sourced from **US patent US10585862B2**, col. 9 lines 15-58: three-way merge computes a base version at the fork point, then resolves each changed property by comparing `target`, `source`, `base`.

**F-P3-12 (P0) — `link_edit` table has no branch column.** Verified live:
```
$ docker exec tellus-postgres-1 psql -U tellus -d tellus_db -c "\d link_edit"
→ 17 columns. None is branch_id, ontology_id_fk, or ontology_id.
```
Every link edit written on any branch is visible to every reader on every branch. Not a latency issue — **branch A's link writes leak into branch B's reads with zero delay.**

**F-P3-13 (P0) — Read path does not filter by branch.**
```
$ grep "branch_id\|branchId" src/services/queryExecutor.ts → 0 hits
$ grep "branchId" src/routes/objects.ts → 0 hits
```
`object_instances` PK = `(ontology_id, object_type_api_name, primary_key)` — no branch. Branches are metadata labels on edits (nullable `ontology_edit.branch_id`), not isolated namespaces. The one column that exists is **never populated by the write path**: the INSERT at `editApplicator.ts:245-266` does not include `branch_id`. Only `actionExecutor.ts:462` writes `branch_id` — and only into the action audit log.

**F-P3-14 (P0) — Three-way merge is degraded two-way.**

- `branchMergeService.ts:262` — `baseValue: undefined` **hardcoded**. The algorithm compares only target and source. Patent requires base. **Deletion-then-reinsert conflicts are missed silently.**
- `branchMergeService.ts:82, 129, 153, 175` — `edit_id > $forkPointEditId` uses **UUID string comparison**. UUIDv4 is random. Fork-point selection is non-deterministic.
- `branchMergeService.ts:83, 90, 130, 137, 154, 165, 176, 187` — `ORDER BY created_at` with millisecond granularity. Concurrent batch writes within a ms produce non-deterministic replay.
- `branchMergeService.ts:251` — conflict detection via `JSON.stringify(a) === JSON.stringify(b)`. JSONB key order is implementation-defined. False-positive conflicts on reorder; false-negative on `1` vs `"1"`.
- `branchMergeService.ts:374-389` — replay INSERTs with `execution_id: merge-${branchId}-${Date.now()}`. **Retried merge double-applies every edit.** No idempotency on `POST /branches/:id/merge`.
- `branchMergeService.ts:488-491` — `try { UPDATE … } catch { /* column may not exist */ }` silently swallows UPDATE failures. `fork_point_edit_id` never persists → subsequent merges run with `forkPointEditId=null` → **treat the entire parent-branch history as "edits since fork point"** (lines 88-89, 135-136, 185-186).
- `branchMergeService.ts:379` — `executed_by: 'system'` hardcoded. Merging principal lost from audit trail.

**Zero tests** cover `branchMergeService`. `grep -rn "branchMergeService\|mergeThreeWay\|performThreeWayMerge" tests/` → only one comment hit in `globalSetup.ts`.

**Required to fix:**
1. `link_edit.branch_id UUID NOT NULL`. `ontology_edit.branch_id` → NOT NULL + FK. Backfill to synthetic "main" branch.
2. `object_instances` PK includes `branch_id`, or a per-branch physical view.
3. `queryExecutor.executeQuery` + every calling route accepts `branchId` and injects `term: { branch_id }` into security filter. Same for OpenSearch.
4. OpenSearch index naming includes branch (or a required branch term filter).
5. `branchMergeService.performMerge` rewritten against patent: monotonic `commit_seq BIGSERIAL` for fork point; real `baseValue` read; deep structural equality for conflicts; idempotent replay via deterministic `merge_op_id` hash; merging principal recorded; `Idempotency-Key` advisory lock on the route.
6. Full test suite: three-way merges, deletion conflicts, concurrent merges, retry idempotency, Markings preservation through merge. ≥80% branch coverage on `branchMergeService`.

**Effort:** 4–6 engineer-weeks.

**Alternative (if branching is post-launch per Q4):** feature-flag 503 on `/branches/*` (1 day). Findings remain against the feature.

---

### 2.2 Link Cardinality Enforcement — 1 P0

**F-P3-04 (P0) — Enforcement is silently dead code due to a column-name mismatch.**

Verified live against PG:
```
$ docker exec tellus-postgres-1 psql -U tellus -d tellus_db -c \
    "SELECT source_primary_key FROM link_edit WHERE link_type_api_name='x' \
     AND target_primary_key='y' AND operation='add' ORDER BY created_at DESC LIMIT 1"
→ ERROR: column "created_at" does not exist
```

- `linkViolationEnforcer.ts:140` (`enforceOneToManyAdd`): `ORDER BY created_at DESC`
- `linkViolationEnforcer.ts:187` (`findExistingOneToOneTarget`): `ORDER BY created_at DESC`

Actual column: `executed_at`. Both queries are wrapped in `try { … } catch { /* table may not exist */ }` (lines 134-165, 181-196). Catch swallows "column does not exist" and returns `{ allowed: true }` (line 166) or `null` (line 247). **Enforcement is skipped on every call.**

Consequence on `POST /api/v1/linkTypes/:apiName/links` (`routes/links.ts:1059` → `enforceOneToOneAdd`):
- ONE_TO_ONE under `violation_policy=reject` (Phase A's F-06 default): duplicate targets accepted without complaint.
- ONE_TO_MANY: exclusive-target check never enforced. Any target PK can be claimed by any number of sources.

**Zero tests.** `grep -rn "linkViolationEnforcer\|enforceLinkCardinality\|ONE_TO_ONE.*violation" tests/` → 0 hits.

Root cause: column renamed during migration `017_link_type_extensions.sql`; enforcer never updated. Phase A's F-06 touched `violation_policy` semantics but never verified the SQL runs.

**Required:**
1. Rename `created_at` → `executed_at` at lines 140, 187.
2. Remove catch-everything. Fail write with `LINK_ENFORCEMENT_UNAVAILABLE` on real errors.
3. Tests: all 12 `(cardinality, violation_policy)` matrices.
4. Deploy-time smoke: `SELECT COUNT(*) FROM link_edit WHERE executed_at IS NOT NULL LIMIT 1`. Any SQL error fails deploy before traffic.
5. Prometheus counter `tellus_link_violation_blocked_total{policy, cardinality}`.

**Effort:** 2 engineer-days.

---

### 2.3 Audit Subsystem — 2 P0s, Regulatory Non-Compliant

**F-P3-11 (P0) — Two contradictory audit policies in the same codebase.**

- `src/services/auditEventService.ts:15-19`: *"F-07: Audit writes are now **durable before ack**. … This is non-negotiable under Rwandan tax law (Data Protection Law No. 058/2021) …"*
- `src/models/actionAuditLog.ts:14`: *"IMPORTANT: logActionExecution() must **NEVER throw**"*
- `src/actions/actionExecutor.ts:448-463` calls the latter. **Action pipeline runs on best-effort audit.** Lost audit row still returns 200 OK with the Action's result.

Credential events (password change, WebAuthn) durable. Data-plane actions not.

**F-P2-07 (P0) — No audit durability / hash-chain / read-audit tests.**

- `grep -rn "auditEventService\|emitAuditEvent" tests/` → 0 hits.
- `grep -rn "audit.*durability\|hash.?chain\|WORM" tests/` → 0 hits.
- No `prev_hash` or `row_hash` on `action_audit_log`. No WORM sink. No signed log.
- Read-audit missing entirely. Per `docs/remediation/phase-a-closure.md:166`, read-audit is classified **P0 under Law 058/2021** but deferred to Phase B.

**Required:**
1. **Unify policy.** Choose durable-before-ack on the Action path. Remove "must NEVER throw" contract from `actionAuditLog.ts`. `logActionExecution` throws; route translates to 503 AFTER rolling back the PG txn. (Transactional outbox F-P3-08 subsumes this.)
2. **Tamper-evidence.** `prev_hash TEXT` + `row_hash TEXT` on `action_audit_log`. `row_hash = SHA256(prev_hash || canonical_json(row))`. Singleton `audit_hash_head`. External verifier publishes daily head hash to S3 Object-Lock or KMS-signed log. **Specific mechanism requires Rwandan DPA guidance (Q2 in section 9).**
3. **Read-audit.** Every `GET`, `search`, `searchAround` emits an audit event. Synchronous on Action/Branch routes; outbox-delivered on pure reads. Expect 200–400× action throughput in audit volume.
4. **Tests.** Audit emission per data-plane route. Hash-chain verification test. Failure-mode: inject PG failure on audit insert, assert Action rolls back and client sees 503.

**Effort:** 3–4 engineer-weeks for (1)+(2), additional 2 weeks for (3) read-audit with outbox.

---

### 2.4 CBAC — 1 P0

**F-P3-18 (P0) — CBAC not enforced on Actions, Search, Audit, or Branches routes.**

Authentication (globalAuth at `server.ts:330`) is mounted with a boot-time assertion (`server.ts:333-337` — the F-01 regression guard). **Authentication is enforced.**

Authorization is not. Grep for `req.security` or `securityContext` per route:
```
routes/geo.ts         : 2       routes/objectViews.ts : 11
routes/comparisons.ts : 1       routes/objects.ts     : 9
routes/links.ts       : 8       routes/governance.ts  : 1
routes/actions.ts     : 0  ← P0 routes/search.ts      : 0  ← P0
routes/audit.ts       : 0  ← P0 routes/branches.ts    : 0  ← P0
```

On `POST /api/v1/actionTypes/:apiName/apply` (`routes/actions.ts`), **any authenticated user can execute any Action on any object.** The payload is not checked against the user's role-binding or the action type's `allowed_principals`/`deny_list`. `editApplicator.applyEdits` does not accept a `securityFilter` argument.

**Required:**
1. Every data-plane route reads `req.security` → policy decision before invoking the domain service. On `POST /actions/:type/apply`: `user ∈ allowed_principals(actionType) AND user_markings ⊇ required_markings(action)`.
2. Action audit records the authorization decision (allow/deny + evaluator output).
3. Default-deny router-level guard at boot (fails FATAL like globalAuth if a data-plane route does not read `req.security`).
4. Tests: per route, vectors of unauthorized (403), authorized (2xx), insufficient markings (403 `MARKINGS_DENIED`). Branch coverage ≥95% on policy decision.
5. Prometheus counter `tellus_cbac_denials_total{route, reason}`.

**Effort:** 3 engineer-weeks.

---

### 2.5 Multi-Tenancy — 2 P0s

**F-P5-03 (P0) — Cross-tenant cache and index collisions confirmed in three places.**

1. **PropertyResolver cache** — `propertyResolver.ts:355`:
    ```
    setCache(`${objectTypeApiName}:${meta.apiName}`, meta);
    ```
    No `ontologyId`. Two ontologies that both define `Employee.salary` share one PropertyMeta entry.

2. **Breadcrumb cache** — `breadcrumbService.ts:23`:
    ```
    const cacheKey = `${type}:${id}:${includeChildren}`;
    ```
    No `ontologyId`. Cross-tenant breadcrumb leak.

3. **OpenSearch index name** — `indexMappingGenerator.ts:137-141`:
    ```
    export function getIndexName(objectTypeApiName: string): string {
      return "ontology-" + objectTypeApiName.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    }
    ```
    **Two ontologies that both define `Employee` write documents to the same OpenSearch index.** Storage-layer tenant leak.

**F-P4-27 (P1, P0-adjacent) — Tenant column nullability.** `ontology_edit.ontology_id` nullable and not FK-constrained. `link_edit` has no `ontology_id` column. Cross-ontology edits can be fabricated at ingest.

**Open question Q1 (section 9):** Single- or multi-tenant? If multi-tenant, all the above are P0.

**Required (multi-tenant):**
1. `ontologyId` prefix on every cache key. 3 files, ~6 call sites.
2. OpenSearch index rename → `ontology-${ontologyId}-${objectType}` + reindex via aliases.
3. `ontology_edit.ontology_id NOT NULL REFERENCES ontology(...)`; add same column+FK to `link_edit`; backfill.
4. Test: two ontologies with an `Employee` + same PKs + different property values → reads from A never return B data at any layer.

**Effort:** ~5 engineer-weeks multi-tenant; 1–2 days informational single-tenant.

---

### 2.6 Secrets — 3 P0s

The briefing's grading ladder: in-code (worst) → in-env (dev-only) → in-vault with rotation (prod). Current state is **in-env with source-tree fallbacks to well-known defaults** — below "in-env."

**F-P4-23 (P0) — Hardcoded PG password fallback.**
```
// src/config/foundryDb.ts:6-10
password: process.env.PGPASSWORD || 'tellus123',
```
Env var missing/misspelled → app connects with `tellus123`. Complete tuple `(tellus, tellus123, tellus_db)` in source.

**F-P4-24 (P0) — Hardcoded S3 credentials in 4 places.**
```
// src/config/foundryEnv.ts:29-30
S3_ACCESS_KEY_ID:     process.env.S3_ACCESS_KEY_ID     || 'minioadmin',
S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY || 'minioadmin',
```
Also at `lakekeeperBootstrap.ts:68-69`, `icebergMetadataEmitter.ts:76-77`, `duckdb/pool.ts:194`. **`minioadmin:minioadmin` is the well-known default MinIO root credential.** Env var unset → connects to production S3/MinIO with defaults.

**F-P4-25 (P0) — No vault integration.** No AWS Secrets Manager, no External Secrets CSI, no Vault sidecar. Rotation requires a redeploy — not a rotation. No audit on secret reads.

**F-P4-26 (P1) — Keycloak realm fallback** to `'tellus'` at `globalAuth.ts:77`, `keycloakAuth.ts:32`, `tellusAuth.ts:55`, `patSecurityGate.ts:51`.

**Required:**
1. Remove every `|| 'hardcoded'` fallback for security-sensitive env vars. Replace with `requireEnv("PGPASSWORD")` that throws at boot.
2. K8s External Secrets + AWS Secrets Manager or HashiCorp Vault. Secrets as CSI-mounted files, read at boot.
3. Document 90-day rotation for PG, S3, Keycloak client, JWT signing keys, Temporal creds. Support SIGHUP re-read.
4. Audit every secret read (without value) with correlation ID.
5. `gitleaks` or `trufflehog` pre-commit + CI job.
6. Commit `SECRETS.md` listing every env var, source vault path, rotation schedule, incident runbook.

**Effort:** 1 engineer-week fail-closed + vault wiring; 3 days scan + docs + rotation.

---

### 2.7 Backpressure — 1 P0 (K8s-Specific)

**F-P4-12 (P0) — In-memory rate limiter.**

`src/middleware/rateLimiter.ts:16-17` (explicit comment):
> *"In production, this would be backed by Redis for multi-instance deployments. The in-memory implementation is sufficient for single-instance deployments."*

Target is Kubernetes, which is multi-instance by construction. Under N replicas:
- Per-user limit multiplies by N.
- Global limit multiplies by N and drifts by arrival pattern.
- `RateLimiter.windows` Map at line 57 has no shared state.

Default `GLOBAL_ACTION_RATE_LIMIT_MAX=2000/min = 33/s` is already **below the 50 actions/s SLO** on a single replica.

**Required:**
1. Re-implement `check/tryCheck/record` against Redis sliding window (`ZADD`/`ZREMRANGEBYSCORE`/`ZCARD` or `redis-cell`).
2. Circuit-breaker around Redis (F-P4-11). Redis unavailable → fail-open with metric, not fail-closed.
3. Raise `GLOBAL_ACTION_RATE_LIMIT_MAX` default to ≥5000/min (83/s) for 67% headroom over SLO.
4. Prometheus `tellus_rate_limit_current{scope}`, `tellus_rate_limit_exceeded_total{scope}`.

**Effort:** 1 engineer-week.

---

### 2.8 Scalability — 1 P0 (SLO-Violating by Design)

**F-P5-02 (P0) — `resolveMultiHop` is unbounded sequential OpenSearch.**

`linkResolverService.ts:810-828`:
```
for (let i = 0; i < steps.length; i++) {            // up to 5 hops (line 799)
  for (const pk of currentPKs) {                    // up to 100,000 per hop (line 806)
    const result = await resolveLinks(linkType, pk, ...);  // 1-3 OS per pk
  }
}
```
Upper bound: 5 × 100,000 × 3 = **1,500,000 sequential OpenSearch queries per request**. At 10 ms/query = **>4 hours per request**. Even at modest pruning (5 × 1,000 × 3 = 15,000 queries = 150 s), blows the 250 ms p99 SLO by **600×**.

**F-P5-01 (P1) — `searchAround` slow path N+1.** `linkResolverService.ts:761`:
```
for (const pk of sourcePKs.slice(0, 1000)) { await resolveLinks(...); }
```
**3,000 sequential OS queries per request = 30 s.** Triggered whenever FK-field derivation yields null (ONE_TO_ONE, reverse ONE_TO_MANY without `target_property_id`, etc.).

**Required:**
1. **Multi-hop rewritten as a graph query, not a loop of point queries.** Use existing ClickHouse link materialized view (`src/services/searchAround/clickhouseTraversal.ts:118` already has pre-filtered markings in JOIN-based multi-hop). Route all multi-hop through ClickHouse. Effort: 2 weeks.
2. **SearchAround slow path: single `terms` query** using OS aggregations for per-source targets in one round-trip. Effort: 1 week.
3. **Request-level timeout** via 5 s `AbortController` → graceful 504 with `retry_hint=narrower_filter`.
4. **Validation-time limits**: reject `steps.length > 3` and `startingPKs.length > 100` with 400 `QUERY_TOO_LARGE`.

**Effort:** 3 engineer-weeks.

---

## 3. P0 Summary Table

| # | ID | Area | Summary | Fix |
|---|----|------|---------|-----|
| 1 | F-P2-05 | Branching | `branchMergeService` — 0 tests + 8 static defects vs US10585862B2 | 4–6 w |
| 2 | F-P2-06 | Links | `linkViolationEnforcer` — 0 tests | covered |
| 3 | F-P2-07 | Audit | No durability/hash-chain/read-audit tests | 2 w |
| 4 | F-P3-04 | Links | Cardinality dead (column mismatch + swallow) | 2 d |
| 5 | F-P3-11 | Audit | Contradictory policies; Action best-effort; no hash-chain | 3 w |
| 6 | F-P3-12 | Branching | `link_edit` has no branch column | 2 w |
| 7 | F-P3-13 | Branching | Read path ignores branch | 4 w |
| 8 | F-P3-14 | Branching | 3-way merge degraded 2-way (`baseValue: undefined`) | 4 w |
| 9 | F-P3-18 | Security | CBAC absent on Actions/Search/Audit/Branches | 3 w |
| 10 | F-P4-12 | Backpressure | In-memory rate limiter; K8s-incompatible | 1 w |
| 11 | F-P4-23 | Secrets | Hardcoded `tellus123` PG fallback | 1 d |
| 12 | F-P4-24 | Secrets | Hardcoded `minioadmin/minioadmin` S3 fallback (4 sites) | 1 d |
| 13 | F-P4-25 | Secrets | No vault; rotation impossible | 1 w |
| 14 | F-P5-02 | Scale | `resolveMultiHop` N+1 (1.5 M upper bound) | 3 w |
| 15 | F-P5-03 | Tenancy | Cross-tenant cache + OS index collisions | 1–5 w (Q1) |
| 16 | F-P2-01 | Tests | 12 ghost-passes; 22 files same latent pattern | 3 d |

Every line is launch-blocking in isolation.

---

## 4. P1 Findings — 35 Items

SLO- or contract-violating under realistic load; required for Conditional-Go.

| ID | Area | Finding | Effort |
|----|------|---------|-----|
| T-05 | Contracts | SLOs only in a memo, not a spec | 1 d |
| T-06 | Docs | 9 subsystems undocumented in ARCHITECTURE.md | 2 d |
| T-08 | Migrations | Ledger churn + renames without checksum | 1 w |
| F-P2-02 | Tests | Coverage tooling crashes workers | 1 w |
| F-P2-03 | Tests | Phase A coverage not reproducible | covered |
| F-P2-04 | Tests | Reproducible branch coverage 43.34% (not 64.64%) | 3 w |
| F-P2-09 | Actions | No 2PC on Action pipeline | 3 d |
| F-P3-01 | Objects | Duplicate-create race when B1 disabled | 2 d |
| F-P3-03 | Objects | No schema-evolution enforcement | 2 w |
| F-P3-05 | Links | Orphan link_edit rows after object delete | 1 w |
| F-P3-08 | Actions | Kafka CDC outside PG txn → CH/Flink divergence | 2 w |
| F-P3-09 | Actions | Idempotency on 1 route only | 1 w |
| F-P3-10 | Actions | `$expectedVersion` optional → LWW | 2 d |
| F-P3-15 | Indexing | No lag SLO; patchy monitoring | 1 w |
| F-P3-19 | Security | M2M CSV join bypasses markings | 3 d |
| F-P4-04 | Timeouts | OS 30 s × 3 = 90 s upper bound | 2 d |
| F-P4-05 | Timeouts | Redis no connect/command timeout | 1 d |
| F-P4-08 | Timeouts | 6/17 `fetch()` sites no AbortSignal | 3 d |
| F-P4-11 | Resilience | Only OS has circuit breaker | 2 w |
| F-P4-13 | Concurrency | DuckDB + polars block event loop | 2 w |
| F-P4-15 | Obs | No per-route RED metrics | 1 w |
| F-P4-16 | Obs | PG pool USE not emitted as Prometheus | 2 d |
| F-P4-19 | Migrations | 28/34 files no rollback | 3 w |
| F-P4-20 | Migrations | `branch_id` col added but write path never populates | covered |
| F-P4-26 | Secrets | `KEYCLOAK_REALM || 'tellus'` in 4 sites | 1 d |
| F-P4-27 | Tenancy | `ontology_id` nullable/absent | 2 w |
| F-P5-01 | Scale | searchAround slow-path N+1 (3 k OS queries) | 1 w |
| F-P5-04 | Obs | No cache hit-rate metric | 2 d |
| F-P5-06 | Scale | ~50 PG conns/replica vs max 100 | 1 w |
| F-P5-07 | Scale | Single Redis connection per replica | 2 d |
| F-P5-08 | Scale | Per-replica circuit-breaker state | 1 w |
| F-P5-09 | Scale | No cross-replica cache invalidation | 1 w |
| F-P5-11 | Obs | No production runtime measurement | covered |
| F-P6-01 | Migration | `asyncHandler` across ~30 routes breaks Fastify port | 1 w |
| F-P6-02 | Migration | 588-line errorHandler Express-coupled | 1 w |

---

## 5. P2 / P3 Findings

24 P2 + 2 P3 — hygiene and operational-risk. High-impact ones:

- **T-01, T-02, T-06:** ARCHITECTURE.md 5 weeks stale; README empty; 9 subsystems undocumented.
- **T-03:** single-contributor history. Regulator audit will flag bus-factor-of-1.
- **T-07:** `"type":"commonjs"` coexisting with ESM-first OTel + Temporal.
- **F-P4-01:** legacy error-envelope shim with no client-migration deadline.
- **F-P4-18:** `console.*` logs instead of structured Pino + PII scrub.
- **F-P4-21:** migration ledger does not record file hash; `e69ec66` renamed applied migrations.
- **F-P4-22:** `CREATE INDEX` without `CONCURRENTLY` → table lock on deploy.
- **F-P3-17:** dead post-filter `markingFilter.ts` adjacent to live pre-filter (foot-gun).

---

## 6. Tests, Coverage, and the "1067 Passed" Headline

3 consecutive `pnpm test` runs, Node v24.12.0, macOS, 2026-04-23:

```
Run 1: 1067 passed / 3 skipped / 0 failed, 218 s
Run 2: 1067 passed / 3 skipped / 0 failed, 183 s
Run 3: 1067 passed / 3 skipped / 0 failed, 182 s
```

Reproduces Phase A's headline at `docs/remediation/phase-a-closure.md:36-38`.

**BUT:**

1. **12 of 1067 passes are ghost-passes.** `tests/wednesday/integration/wednesday-integration.test.ts:29-42` uses `if (!HAS_DATA) return;` inside `it()` blocks. When `HAS_DATA` is false (server probe failed), every `it()` returns before `expect` runs, Vitest reports ✓ at 0 ms. Verified identical across all 3 runs.
2. **Same pattern latent in 21 other integration files.** A single future infra hiccup turns hundreds more tests into ghost-passes.
3. **The 3 skipped are correctly classified `it.skip`** in `tests/foundry/unit/foundry-unit.test.ts` for BE-002/008/026. Phase A's memo mis-classifies these as wednesday/pb-b3/pb-b4 (themselves ghost-passes, not skips).
4. **Coverage is not reproducible.** `pnpm run test:coverage:critical` crashes a Vitest worker under `COVERAGE_COLLECT_SERVER=1`, loses 24 tests, and never reaches the c8 step because `set -euo pipefail` in `scripts/coverage-server.sh` aborts on the crash. 2 profile fragments generated; c8 cannot map them back to `src/**/*.ts` because `tsx` transforms source at runtime.
5. **Reproducible critical-path branch coverage: 43.34%**, not 64.64%. 20 of 24 critical-path modules at 0% because they never load in the Vitest worker.

**Required:**
1. Eradicate `if (!HAS_DATA) return;` in all 22 integration files. Replace with: server-unreachable in `beforeAll` → **fail the test file**, not silent skip.
2. Fix `scripts/coverage-server.sh` so coverage runs 3× without worker crashes and produces reproducible numbers.
3. CI gate on `coverage-summary.json` ≥80% critical-path branch coverage.
4. 0-ms-pass filter in CI as a crude but effective ghost-pass detector.

**Effort:** 1 engineer-week.

---

## 7. Scalability — Hot Paths Will Fail Under Load

**Binding bottleneck at SLO load (200 reads/s + 50 actions/s):** `linkResolverService.searchAround` slow path (F-P5-01) + `resolveMultiHop` (F-P5-02). Failure mode: p99 latency climbs from ~55 ms to 30–150 s per request, freezes Node event loop, cascades to all concurrent requests.

**Secondary bottleneck (if multi-hop/slow-path avoided):** Redis stall (F-P4-05, F-P5-07). 5 s stall × 50 actions/s saturates 20-slot PG pool in 0.4 s → 503 cascade until Redis recovers. Without circuit breakers → availability ceiling ≈ 99.85%, below 99.9% SLO.

**Horizontal-scale ceiling: 2 replicas.** Past that, PG `max_connections=100` exhausted by sum(main pool 20 + Knex foundry 10 + Knex worker 20) = ~50/replica × 3 = 150 > 100.

**In-process state blocking horizontal scale:**
- Rate limiter (F-P4-12 P0).
- Circuit breaker (F-P5-08).
- LRU + Map caches (F-P5-03, F-P5-09).

**Event-loop blockers:**
- DuckDB native binding (F-P4-13) synchronous.
- nodejs-polars native binding (F-P4-13) synchronous.
- `bcrypt` on default libuv pool of 4.
- `JSON.stringify` ×3 per edit at `editApplicator.ts:257, 259, 262`.

**Required:**
1. Rewrite multi-hop + searchAround slow path (section 2.8).
2. Redis-back rate limiter (section 2.7).
3. Circuit breakers on PG, Redis, Keycloak, Kafka, S3 (F-P4-11).
4. PgBouncer between app and PG (F-P5-06).
5. Offload DuckDB + polars to dedicated workers (F-P4-13).
6. RED + USE metrics (F-P4-15, F-P4-16, F-P5-04).
7. Kafka-based cache-invalidation pub/sub (F-P5-09).

**Effort:** ~6–8 engineer-weeks aggregate, parallelisable.

---

## 8. Migration to Fastify + Kubernetes

Fastify port is **mechanically large but semantically straightforward**. >100 files import Express types; 30+ route files; 1 588-line error handler. Domain core (`editApplicator`, `queryExecutor`, `linkResolverService`, `branchMergeService`, `interfaceValidator`, `auditEventService`) imports **no Express types** — ports unchanged.

**Migration-blocking P0s (fix on Express first):**
- F-P4-12 in-memory rate limiter (K8s prerequisite).
- F-P4-23/24/25 secrets (K8s prerequisite).
- F-P5-03 cross-tenant cache/index.
- Every other P0 is orthogonal to framework choice.

**Recommended strategy: strangler fig with shared domain core + Fastify adapter.**

Rejected:
- **Big-bang cutover** — doubles blast radius over 77 findings.
- **Shadow-traffic parallel run** — requires transactional outbox first (F-P3-08, 2 weeks) to avoid Kafka CDC duplication.
- **Per-route Express↔Fastify mixing** — 150–200 mechanical edits across two frameworks on the same event loop.

**Sequencing:**

| Weeks | Work |
|-------|------|
| 0–4 | Fix P0s in-place on Express: branching, cardinality, secrets, rate limiter, CBAC, tenant isolation |
| 4–6 | Error-handler pure-function refactor; `asyncHandler` codemod; `(req as any)` inventory + FastifyRequest types |
| 6–10 | Strangler fig: Fastify at `/api/v2/*`; port `/health`, `/ready`, `/metrics` first, then auth + error handler, then read routes |
| 10–14 | Port mutate routes (Actions, Links); remove Express Deployment via Ingress split |
| 14+  | K8s rollout: Redis rate limiter, PgBouncer, vault-sourced secrets, RED+USE metrics |

---

## 9. Open Questions (Required for Go/No-Go Revision)

**Q1.** Is RRA the only tenant, or is Tellus multi-tenant? Determines whether F-P5-03 / F-P4-27 / F-P4-28 / F-P4-29 are P0 or informational.

**Q2.** What exact audit tamper-evidence contract does Rwandan Law 058/2021 require? Hash-chain, signed-log, WORM, blockchain anchor? Remediation range: 1 week (hash-chain) to 6 weeks (external WORM + audit gateway).

**Q3.** Confirm SLOs at `docs/remediation/phase-a-closure.md:162` are current (200 r/s, 50 a/s, p99 250/800 ms, 99.9%).

**Q4.** Is branching a launch requirement for RRA, or post-launch? If post-launch: 3 P0s (F-P3-12/13/14) + 1 P1 (F-P4-27) de-escalate; route-level 503 in 1 day.

**Q5.** Pipeline Builder + Funnel layer in scope for launch? If so, +2–3 weeks audit alone, before remediation.

**Q6.** Target PG topology in K8s: single-primary + replicas? CloudSQL / RDS / Aurora? PgBouncer placement?

**Q7.** Is OSDK a deliverable for RRA integrations? If so, F-P4-01 legacy envelope shim blocks codegen.

**Q8.** Who owns the final verdict if this audit conflicts with Phase A closure memo? Default: human reviewer.

---

## 10. Step-by-Step Remediation Plan

**Block A — Kill invisible bugs (Week 1).**
1. F-P3-04: fix column name + remove swallow-catch + add cardinality tests. (2 d)
2. F-P4-23/24/26: remove every credential fallback; `requireEnv()` throws at boot. (1 d)
3. F-P2-01: eradicate `if (!HAS_DATA) return;` from 22 files; beforeAll-fail on server unreachable. (3 d)

**Block B — Regulatory (Weeks 2–4).**
4. F-P3-11: unify audit policy durable-before-ack; hash-chain columns + verifier. (3 w)
5. F-P2-07: audit-emission tests per route; PG-failure rollback test. (2 w parallel)

**Block C — Security (Weeks 3–6, parallel).**
6. F-P3-18: CBAC on Actions/Search/Audit/Branches; default-deny boot guard; deny audit + metric. (3 w)
7. F-P3-19: M2M CSV join applies markings. (3 d)

**Block D — Kubernetes-compatibility (Weeks 5–9, parallel).**
8. F-P4-12: Redis-backed rate limiter. (1 w)
9. F-P4-25: External Secrets + vault; rotation docs. (1 w)
10. F-P5-03: `ontologyId` on cache keys; OS index rename + reindex if multi-tenant. (1–5 w per Q1)
11. F-P4-27: `ontology_id NOT NULL + FK` on `ontology_edit`; add to `link_edit`; backfill. (2 w)
12. F-P5-06: PgBouncer in K8s topology. (1 w)
13. F-P5-09: Kafka cache-invalidation pub/sub. (1 w)

**Block E — Branching (Weeks 2–10, depends on Q4).**
- 14a. Launch-required: F-P3-12 (2 w) + F-P3-13 (4 w) + F-P3-14 (4 w) + F-P2-05 tests (2 w) = ~8–10 weeks elapsed with 1 eng; ~5 with 2.
- 14b. Post-launch: feature-flag 503 on `/branches/*` (1 d); findings recorded as P2-future-work.

**Block F — Scale & SLO (Weeks 4–11, parallel).**
15. F-P5-02: multi-hop via ClickHouse traversal + request-size validation + timeout. (3 w)
16. F-P5-01: searchAround single-`terms` rewrite. (1 w)
17. F-P3-08: transactional outbox for Kafka CDC. (2 w)
18. F-P4-11: circuit breakers on PG/Redis/KC/Kafka/S3. (2 w)
19. F-P4-04/05/07/08: timeouts everywhere. (1 w aggregate)
20. F-P4-13: offload DuckDB + polars to workers. (2 w)

**Block G — Observability (Weeks 5–10, parallel).**
21. F-P4-15/16, F-P5-04/11: RED + USE + cache hit-rate + event-loop-lag metrics. (2 w)
22. F-P4-18: Pino structured logs + PII scrub. (1 w)
23. F-P4-03: inbound `X-Request-ID` adoption. (1 d)
24. F-P4-17: OTel context across Temporal + Kafka. (1 w)

**Block H — Tests & Coverage (Weeks 6–11, parallel).**
25. F-P2-04: lift critical-path branch coverage to 80% + CI gate on coverage-summary.json. (3 w)
26. F-P2-02/03: fix `scripts/coverage-server.sh`. (1 w)
27. F-P4-19: down-migrations paired with every `.sql`; ledger checksum discipline (F-P4-21). (3 w)

**Block I — Fastify migration (Weeks 10–16).**
28. F-P6-01/02/03: errorHandler pure-function refactor; `asyncHandler` codemod; FastifyRequest types. (2 w)
29. Strangler fig port (3–4 w).
30. Decommission Express (Ingress traffic split).

**Block J — Docs & process (ongoing).**
31. T-01/02/06: restore README; update ARCHITECTURE.md with 9 subsystems; document SLOs formally. (3 d)
32. T-04: commit-message discipline; end "Fixing CI N" era.
33. T-03: onboard peer reviewer.
34. New: `SECRETS.md`, `RUNBOOK.md`, `INCIDENT_RESPONSE.md`, `SLO.md`.

---

## 11. Critical-Path Timeline (3 senior engineers in parallel)

| Weeks | Lane 1 | Lane 2 | Lane 3 |
|-------|--------|--------|--------|
| 1 | Block A | Block A | Block A |
| 2–4 | Block B audit | Block C security | Block E or F per Q4 |
| 5–8 | B + start D | D + G observability | F scale |
| 9–11 | H tests + coverage | G | finish E or F |
| 12–14 | I Fastify | I | J docs + final regression |
| 15–16 | Final regression + Conditional-Go review + K8s staged rollout | | |

- **Best case (single-tenant, branching deferred):** 10 weeks.
- **Realistic (multi-tenant, full branching):** 16–18 weeks.
- **Pessimistic (regulator triggers audit rework on tamper-evidence / read-audit):** 20+ weeks.

Any timeline claim shorter than 10 weeks is incompatible with evidence.

---

## 12. UNVERIFIED ASSUMPTIONS

Per Hard Rule #1, not asserted; require human confirmation:

1. Palantir's audit tamper-evidence mechanism (hash-chain vs signed-log vs WORM vs anchor).
2. Title/display-name formula engine location in Tellus code.
3. `ruleCompiler.ts` execution order determinism.
4. Temporal backfill idempotency under activity retries.
5. Search tie-breaker stability at `__pk`.
6. Interface schema-evolution behaviour.
7. Derived-object markings propagation.
8. ClickHouse link materialised view sharding/hot-partition design.
9. Keycloak realm bootstrap, JWKS TTL, FIDO2 AAGUID restrictions.
10. Custom content-type parsers in current Express layer.

Each could surface additional P0/P1 on full inspection. Not in the 77-finding count.

---

## 13. Process Changes Required

Not strictly code, but production-readiness:

1. **No single-contributor commits to `main`.** A regulated audit trail cannot be signed off by one person's identity shown under three variants in `git shortlog`. Peer review = launch requirement.
2. **No "Fixing CI N" commits.** Every commit message describes the semantic change. `git blame` must be usable.
3. **Ghost-pass tests never count as evidence.** Brief's Hard Rule #8 is binding. A memo claiming "1067/3/0 across three runs" is not evidence if 12 are assertion-free returns.
4. **Coverage must come from reproducible tooling.** 64.64% in Phase A's memo is not reproducible in the present environment. Future audits will find the same gap.
5. **Remediation memos are not verdicts.** `docs/remediation/phase-a-closure.md` declares items F-01..F-05 + F-19 "closed." Several reproduce closed; others (F-04 idempotency) are closed only at one route. Evidence-over-opinion requires independent verification, not self-report.

---

## 14. Closing Statement

This repository is a careful, ambitious effort to build a Palantir-Ontology-class platform on open-source primitives. Domain modelling in `editApplicator.ts`, `interfaceValidator.ts`, and the Temporal-backed Funnel reflects real engineering investment. The test suite's pure-function coverage (type system, Flink SQL compiler, Iceberg schema evolution, polars aggregation, Wilson intervals, `search_after` cursors) is thorough on the periphery.

**The core, however, is not production-ready for a tax authority.** It ships with:
- deletion-then-reinsert invisible to the merge algorithm,
- cardinality enforcement that has never actually run (column rename),
- audit policy that contradicts itself in two adjacent files,
- hardcoded default credentials in four places,
- CBAC absent on the most audit-relevant route,
- cross-tenant OpenSearch index collisions,
- rate limiter that the code itself declares not production-ready for the target deployment.

Going live now means going live knowing these failure modes exist. The fixes are tractable — 10–18 weeks of focused engineering — but only if the team acknowledges them and funds them, rather than re-litigating whether they are real. Every one of the 77 findings is cited to a file, line, and — for the P0s — a live database query result or direct grep output.

**Recommendation: NO-GO until the P0 block closes. Begin Block A tomorrow. Answer the 8 open questions in section 9 by week 3. Target Conditional-Go in 10–14 weeks. Target full GO in 14–18 weeks.**

---

*End of report — prepared 2026-04-23 for codex review.*

---

# APPENDIX — What "GO PRODUCTION" Actually Requires Beyond the 77 Findings

This appendix exists because closing the 77 P0/P1/P2/P3 findings above is **necessary but not sufficient** for a tax-authority launch. A reviewer who reads sections 0–14 and concludes "fix 16 P0s + 35 P1s → ship" will ship a system that is still not production-ready. This appendix enumerates the additional verification and operational requirements. When every item in this appendix is green, **then** the repository is ready for GO PRODUCTION.

**Rule of thumb:** if you skipped any item in Appendices A–I, you did not ship production.

---

## Appendix A — Implementation Quality Gates

Fixing a bug incorrectly is worse than leaving it open — it masks the real failure. Every P0 fix MUST clear these gates before merging to `main`:

### A.1 Peer review requirements

- **Every P0 fix requires 2 reviewers:** the implementing engineer + a second senior engineer NOT on the implementation lane. Single-contributor merges to `main` are forbidden starting from Block A.
- **Branch-merge rewrite (F-P3-14) requires a reviewer with VCS-internals experience** — someone who has worked on Git, Mercurial, Subversion, or Palantir Foundry branch merge code at a professional level. If the team does not have such a person, hire an external consultant for the review cycle (2-week engagement, ~$40K).
- **Audit tamper-evidence (F-P3-11) requires a reviewer with regulated-audit experience** — PCI-DSS, HIPAA, SOC-2, or similar. Hash-chain correctness is subtle; `canonical_json` serialization deterministically is subtle; WORM durability semantics are subtle.
- **CBAC implementation (F-P3-18) requires a reviewer with Zanzibar-style policy engine or OPA experience.** Row-level auth is a solved problem but easy to get wrong in novel combinations.

### A.2 Mandatory PR checklist per P0 fix

A PR cannot merge unless:
1. ☐ All existing tests still pass (3 consecutive deterministic runs).
2. ☐ **At least 1 new test per code branch added** by the fix. Coverage on the changed file ≥ 90% branch coverage.
3. ☐ A **negative test** — a test that would have caught the pre-fix bug — is included and explicitly demonstrates it by running against the pre-fix commit (use `git stash`).
4. ☐ Prometheus metric emitted for the fix's operation domain (e.g., `tellus_branch_merge_conflicts_total{resolution}` for F-P3-14).
5. ☐ CHANGELOG entry with the finding ID in the commit message.
6. ☐ Migration (if any) has a paired `.down.sql` AND the down-migration is tested against a fresh DB restore.
7. ☐ If touching the write path, a **concurrency stress test** (1000× concurrent requests) is run locally and the PR notes the observed p99 latency.

### A.3 Done-Done definition per P0

A P0 is not "closed" until:
- PR merged with A.2 checklist complete.
- Fix deployed to staging.
- Staging load test at 1× SLO green for 10 minutes.
- Independent verifier (Appendix B below) re-runs the original audit evidence and confirms it no longer reproduces.

**Additional effort across all 16 P0s: ~2–3 engineer-weeks aggregate** (most is parallel with the fix itself).

---

## Appendix B — Closing the 10 UNVERIFIED ASSUMPTIONS

Each of §12's assumptions must be resolved. Required investigation per assumption:

| # | Assumption | Investigation required | Potential new finding |
|---|---|---|---|
| B.1 | Audit tamper-evidence contract | Obtain written DPA guidance on required mechanism (hash-chain / WORM / anchor); document in `AUDIT_CONTRACT.md` | If DPA mandates external anchor: new P0 for external audit-log gateway (~6 additional weeks) |
| B.2 | Title/display-name formula determinism | Locate the formula engine, confirm it is pure, add determinism test | If engine reads external state: new P0 for RYW correctness |
| B.3 | `ruleCompiler.ts` execution order | Static read + test with 5 rules in all 5! = 120 orderings | If non-deterministic: new P0 for Action correctness |
| B.4 | Temporal backfill idempotency | Inject retry in backfill workflow; assert no duplicate edits | If non-idempotent: new P0 for data duplication |
| B.5 | Search tie-breaker stability at `__pk` | Test pagination with ties; verify no skips/duplicates | If unstable: new P0 for page stability |
| B.6 | Interface schema evolution | Add a property to an Interface; verify ObjectViews don't break | If breaks: new P1 |
| B.7 | Derived-object markings propagation | Create derived object from source with strict markings; verify marking set is preserved or merged per contract | If gap: new P0 for Markings leak |
| B.8 | ClickHouse link MV sharding | Static review of `linkMaterializedView.ts`; test with skewed data at 10× scale | If hot-partition: new P1 for throughput ceiling |
| B.9 | Keycloak FIDO2 AAGUID restrictions | Review realm config + `simplewebauthn` verification options | If no AAGUID allowlist: new P1 for MFA policy bypass |
| B.10 | Custom content-type parsers | Grep `app.use(express.*)` and custom parsers; document all | If custom parsers exist: Fastify port adds ~1 week per parser |

**Effort: 2–6 engineer-weeks aggregate** + whatever new findings surface (budget +2–4 new P0/P1s for ~4–6 additional weeks of remediation).

**Gate:** `INVESTIGATION_REPORT.md` committed, listing each assumption, the evidence gathered, and the disposition (closed / new-finding-opened).

---

## Appendix C — Pipeline Builder + Funnel Layer Audit

The current report audited the **Ontology core** (object types, actions, links, branches, audit, CBAC, search, routes, middleware). It did **not** deep-audit:

- `src/services/funnel/` — Temporal workflows, Iceberg sidecars, Lakekeeper catalog integration, DuckDB materialization, streaming changelog.
- `src/services/pipelines/` — Pipeline Builder workflows.
- `src/services/searchAround/` — Link materialized view pipeline (partially audited for pre-filter markings only).
- `src/routes/funnel.ts`, `src/routes/*pipeline*.ts` — HTTP surface for these layers.

### C.1 Required audit steps for Funnel/Pipeline Builder

1. **Phase 1 equivalent:** git archaeology, docs read, stack inventory specific to these layers.
2. **Phase 2 equivalent:** run funnel/pipeline test suites in isolation, measure coverage on `src/services/funnel/**/*.ts` and `src/services/pipelines/**/*.ts` with ≥80% branch gate.
3. **Phase 3 equivalent:** semantic correctness of streaming contracts:
   - Exactly-once vs at-least-once delivery on each Kafka topic.
   - Flink checkpointing correctness under backfill.
   - Iceberg snapshot-isolation level.
   - Lakekeeper authorization on catalog operations.
   - DuckDB-Polars-Iceberg data-type compatibility matrix.
4. **Phase 4 equivalent:** timeouts, retries, idempotency, circuit breakers on Temporal activities + Kafka + Iceberg writes.
5. **Phase 5 equivalent:** capacity estimate for backfill of 10M object types × 1B edits.

### C.2 Expected findings

Budget **4–8 new P0/P1/P2 findings** in this layer. Typical defects in Temporal-backed systems:
- Activity not idempotent under retry (becomes new P0 if it writes).
- Workflow history explosion (becomes P1 after ~10⁵ activity calls in one workflow).
- Iceberg schema evolution bugs (becomes P0 if writer and reader disagree on schema).
- ClickHouse MV non-replayability after backfill (P1).

**Effort: 2–3 engineer-weeks audit + 4–8 engineer-weeks remediation = 6–11 engineer-weeks total.**

**Gate:** `FUNNEL_AUDIT.md` committed with findings list + remediation status.

---

## Appendix D — Load, Soak, and Performance Testing

Phase 5's capacity estimates are **static predictions**, not measurements. These must be validated against a production-equivalent cluster.

### D.1 Test environment required

- Separate K8s cluster (or namespace) matching production topology: same CPU/RAM per replica, same replica count, same PG/Redis/OS/ClickHouse/Kafka/Temporal versions and sizing.
- Seeded with a realistic dataset: RRA production taxpayer count × average object complexity. **The repo has no seed script at this scale.** Building one is 3–5 engineer-days.
- Synthetic user simulation via k6, Gatling, or Artillery. Request mix matching production: ~80% reads (object lookup + search), ~15% actions, ~5% multi-hop. **No such tool is in the repo.**

### D.2 Test matrix

| Test | Duration | SLO target | Pass criterion |
|---|---|---|---|
| Baseline | 15 min @ 1× SLO | p99 r<250ms, p99 a<800ms | Both met |
| Target | 1 hour @ 1× SLO | Same | Both met + no memory/connection leak |
| Breaking | 30 min @ 2× SLO | Graceful degradation | 429/503 emitted correctly, no 502/504 from cascade, no OOM |
| Stress | 15 min @ 5× SLO | Shed load | Pool not exhausted, circuit breakers open as designed, readiness probe reports unhealthy |
| Overload | 15 min @ 10× SLO | Survive | Pod does not restart on OOM; recovers in < 5 min after load removed |
| **Soak** | **72 hours @ 1× SLO** | **No drift** | Heap stable, pool counts stable, latency histograms stable, no silent error-rate increase |
| Mixed-tenant (if Q1=multi) | 1 h @ 1× SLO with 10 tenants | No cross-talk | Prometheus labels per-tenant show isolation |
| Cold-start | 5 min after restart | p99 warmup | p99 within 250/800 ms within 2 min of replica ready |

### D.3 Performance regression gate

Once baseline results are collected, a **CI performance regression gate** runs against every PR to `main`:
- k6 smoke test (5 minutes @ 0.1× SLO) on a staging replica.
- p99 must not regress by more than 10% vs. the last green `main` baseline.
- Violating PRs blocked from merge.

**Effort: 1 engineer-week for infra + seed + first test run; 1 engineer-week for regression CI gate; 1 engineer-week of iteration to fix what the tests reveal. Total: ~3 engineer-weeks.**

**Gate:** `PERFORMANCE_REPORT.md` committed with each test's outcome and the CI regression gate green on `main` for 7 consecutive days.

---

## Appendix E — Chaos Engineering / GameDay Exercises

The system has 7 external dependencies (PG, OpenSearch, Redis, Keycloak, Kafka, Temporal, S3/MinIO). Each must survive a controlled failure before production.

### E.1 Required GameDay scenarios

Run each against the staging cluster with full observability:

| ID | Scenario | Expected behaviour | Failure mode |
|---|---|---|---|
| CHAOS-1 | PG primary failover (controlled) | <30 s write unavailability; reads from replica if supported; no lost writes | Any lost Action = P0 |
| CHAOS-2 | OpenSearch node loss (1 of 3) | Search degrades to `yellow`; no read errors; write-path continues | Any 500 on search = P1 |
| CHAOS-3 | Redis total loss (container kill) | Overlay writes fail fast (timeout F-P4-05); rate limiter fails open with metric; circuit breaker opens; alerts fire | Cascade to 503 on all routes = P0 |
| CHAOS-4 | Keycloak unreachable for 60 s | JWT cache serves until TTL expires; then 401 on expiring tokens; no 500s | 500 on auth = P1 |
| CHAOS-5 | Kafka broker loss | CDC outbox buffers (F-P3-08 transactional outbox); no blocking on Action path | Action path blocks = P0 |
| CHAOS-6 | Temporal worker loss | Workflows stall cleanly; new workflows queue; metric alert fires | Silent data loss on in-flight workflow = P0 |
| CHAOS-7 | Network partition app ↔ PG (iptables block) | Circuit breaker opens in <10 s; 503 with Retry-After; recovery < 30 s after unpartition | Pool exhaustion without breaker = P0 |
| CHAOS-8 | DNS flap (5 s outage × 3 in 60 s) | DNS cache absorbs; no request failures | Cascading resolution failures = P1 |
| CHAOS-9 | S3 / MinIO slow (p99 → 5 s) | S3 SDK timeouts fire (F-P4-07); Iceberg writes retried | Blocking on Action path = P0 |
| CHAOS-10 | Pod OOM kill under 1× load | K8s restart < 60 s; drain in-flight requests; no data loss | Any in-flight Action lost = P0 |

### E.2 GameDay protocol

- Run each scenario twice: once with the team aware, once unannounced.
- Measure MTTD (mean time to detect — alerting latency), MTTR (mean time to recovery).
- Document blast radius per scenario.
- Remediate any scenario that produces a P0/P1 new finding.

**Effort: 1 engineer-week setup chaos-mesh or equivalent; 1 engineer-week to execute 10 scenarios; 1–2 engineer-weeks to fix what they reveal. Total: ~3–4 engineer-weeks.**

**Gate:** `GAMEDAY_LOG.md` with all 10 scenarios executed twice, MTTD < 2 min, MTTR < 5 min on each, no P0 open.

---

## Appendix F — Disaster Recovery and Backup Verification

A tax authority's audit trail must survive a datacentre loss. The current repo does not document DR.

### F.1 RTO / RPO to define and meet

| System | RTO (recovery time) | RPO (data loss tolerance) | Verification |
|---|---|---|---|
| PG primary | 15 minutes | 0 seconds (synchronous replication) | Monthly failover drill |
| PG read replica | N/A (restart) | - | - |
| OpenSearch | 60 minutes | 5 minutes | Weekly snapshot restore drill |
| ClickHouse | 60 minutes | 5 minutes | Monthly restore drill |
| Iceberg (MinIO/S3) | 60 minutes | 0 (object-store versioning) | Monthly object-lock verification |
| Redis | 30 seconds (acceptable-loss — overlay cache) | any (rebuilt from PG) | Weekly pod-kill drill |
| Kafka | 15 minutes | 0 (replication factor 3) | Monthly broker loss drill |
| Keycloak | 30 minutes | 0 (PG-backed) | Monthly failover drill |

### F.2 Required documentation

- `DR.md` — topology, failover procedures, RTO/RPO per system, on-call runbook for each failure mode.
- `BACKUP.md` — cadence (e.g., continuous for PG via WAL, daily snapshots for OS/CH, per-commit for Iceberg), retention (7-year minimum under Rwandan Law 058/2021 for audit data), encryption-at-rest for all.
- `RESTORE_DRILL.md` — monthly restore drill protocol; logs of last 6 restore drills stored externally.
- `KEY_ROTATION.md` — quarterly KMS key rotation; documented key custodians.

### F.3 Restore drill protocol

Once a month, on staging:
1. Select a data store at random.
2. Delete the data store entirely.
3. Restore from backup following `RESTORE_DRILL.md`.
4. Verify data integrity via checksum on a known subset.
5. Measure elapsed time vs. RTO target.

Drill failure = P0 regression, blocks next deploy.

**Effort: 1 engineer-week DR documentation; 1 engineer-week first drill execution + fix. Total: ~2 engineer-weeks.**

**Gate:** `DR.md` + `BACKUP.md` + 3 consecutive successful monthly restore drills before GO.

---

## Appendix G — External Penetration Test

An internal audit (this report) is a **necessary floor** but not the ceiling. A tax-authority deployment must pass external validation.

### G.1 Scope for external pen-test

The pen-tester must cover at minimum:
- **OWASP Top 10 (2021 or current)** coverage on every route.
- **OWASP API Top 10** — especially BOLA (Broken Object-Level Authorization) which overlaps with F-P3-18 CBAC.
- **Authentication** — Keycloak/JWT flows, PAT lifecycle, WebAuthn enrollment, MFA bypass attempts, session fixation.
- **Authorization** — CBAC at every route (fixes F-P3-18 must be verified by an outsider), Markings bypass attempts, horizontal + vertical privilege escalation.
- **Input validation** — SQL injection on every parametrized query; NoSQL injection on OpenSearch queries; SSRF via `fetch()` sites; XXE in any XML parser (grep first); prototype pollution in JSON parsers.
- **Rate limit bypass** — per-replica rate limiter (F-P4-12) must not be bypassable by round-robin across replicas once fixed.
- **Audit evasion** — attempts to take actions that do not produce audit rows.
- **Timing side channels** — on the Markings filter, authorization decisions, password checks (bcrypt is constant-time; verify).
- **Supply-chain** — SBOM, CVE scan of `node_modules`, license compliance.
- **Container hardening** — non-root UID, read-only root FS, drop ALL capabilities except needed, seccomp profile, no hostPath mounts.
- **K8s hardening** — NetworkPolicy per Pod, PodSecurityStandards=restricted, no cluster-admin ServiceAccounts.
- **Secret handling** — verify F-P4-23/24/25 fixes hold under container filesystem inspection, process environment dump, `/proc/1/environ`, core-dump capture.

### G.2 Engagement shape

- External firm or in-house red team with **no prior exposure to the codebase** (prevents bias from this report).
- 2-week active engagement.
- 1-week report delivery.
- 1–3 weeks of remediation (budget depends on findings).
- Re-test on fixes within 2 weeks of fixes landing.

### G.3 Go-criterion

- **No Critical or High** findings open at re-test time.
- All Medium findings have agreed remediation plan with dates.
- Lows tracked as P2/P3 in the audit ledger.

**Effort: 3–5 engineer-weeks total (2 external + 1–3 remediation), partially parallel with other blocks.**

**Gate:** pen-test report + re-test sign-off committed under `security/pentest/YYYY-MM.md` (with sensitive details redacted from git if needed).

---

## Appendix H — Operational Readiness

Engineering a production system and operating one are different problems. These are all launch-blocking and none is in the 77 findings.

### H.1 On-call

- **Minimum 4-engineer on-call rotation** for 24×7 coverage. 3 engineers means burnout within 3 months; 2 is unsafe.
- **PagerDuty / Opsgenie** configured with:
  - Primary + secondary per shift.
  - Escalation policy: primary 5 min → secondary 10 min → engineering manager 15 min.
  - Follow-the-sun if multi-timezone team available.
- **Runbook per alert** — every Prometheus alert links to a `runbook/<alert-name>.md` entry with diagnostic commands and escalation path.
- **Incident simulation drills** — monthly tabletop exercise reviewing a past incident or a hypothetical.
- **Incident review process** — blameless post-mortem within 72 hours of every Sev-1; action items tracked.

### H.2 SLO monitoring and error budget

- `SLO.md` committed with target SLOs (from Phase 1 Q4) + error budget accounting.
- Grafana dashboard with burn-rate alerts (2% in 1 hour, 5% in 6 hours, 10% in 24 hours).
- Error-budget policy: if budget exhausted, feature freeze until recovery. Who enforces this? Document it.

### H.3 Change management

- **Production deploys require:**
  - Green CI (all gates).
  - Green load smoke on staging.
  - Deploy window (not Friday afternoon in regulated system).
  - Rollback plan in the PR description.
  - Post-deploy verification checklist.
- **Migration deploys require:**
  - Dry-run on restored-from-backup copy of production.
  - Migration execution plan with timing estimate.
  - Explicit rollback procedure (down-migration validated on same data).
  - Approval by PG DBA or equivalent (hire if not present).

### H.4 Synthetic monitoring

- External probe (Pingdom, Datadog Synthetics, or in-house) hits 5 canary endpoints every 60 s from outside the K8s cluster:
  - `/health` (must return 200)
  - `/api/v1/ready` (must return 200 + dependency status)
  - Read sample: `GET .../objects/TestType/test-pk` (must return 200 + known payload)
  - Write sample (low-frequency, read-only assertion-back): a test-harness Action returning without committing (or a scratch ontology)
  - Search sample: `POST .../search` with a deterministic query
- Alerts on any synthetic probe failing 3 consecutive times.

### H.5 Data lifecycle

- Audit data retention per Rwandan Law 058/2021 (confirm period with legal — minimum likely 7 years).
- Archival to cold storage after N months (cold tier S3 + Iceberg schema evolution tested).
- Right-to-be-forgotten process (if applicable under DPA) — tested pseudonymization or erasure on a test subject.
- Legal-hold toggle on individual objects — must not be circumventable by normal delete.

### H.6 Training

- All operators trained on the runbooks before on-call.
- New-hire checklist includes a shadow shift with a senior on-call.
- Incident simulation certifies readiness quarterly.

**Effort: 2–3 engineer-weeks aggregate + ongoing. Partially in parallel with engineering blocks.**

**Gate:** `ONCALL.md`, `SLO.md`, `CHANGE_MANAGEMENT.md`, `SYNTHETICS.md`, `DATA_LIFECYCLE.md` all committed; 4 trained on-call engineers named; first simulation drill complete.

---

## Appendix I — Staged Rollout & Rollback Procedures

Even with everything above green, **the first production traffic must be canaried**. Big-bang first-deploy into a regulated system is malpractice.

### I.1 Staged rollout

| Stage | Traffic | Duration | Abort criteria |
|---|---|---|---|
| 0 | 0% prod, 100% synthetic via Appendix H.4 | 1 week | Any sev-1 alert |
| 1 | 1% of 1 tenant (smallest by volume) | 2 weeks | p99 > 125% of SLO; any P0 incident; any unexplained error-rate increase > 0.1% |
| 2 | 10% of 1 tenant | 2 weeks | Same |
| 3 | 50% of 1 tenant | 1 week | Same |
| 4 | 100% of 1 tenant | 2 weeks | Same |
| 5 | 10% of next tenant (if multi-tenant) | 1 week | Same |
| 6 | 100% of next tenant | 2 weeks | Same |
| 7 | All tenants, 100% | Steady state | Same |

**Total ramp: 11+ weeks of elapsed time** after all engineering is done. This is not engineering cost but elapsed-calendar cost.

### I.2 Rollback procedures (tested, not just documented)

For each non-trivially-reversible change, a **rehearsed** rollback must exist:

| Change | Rollback mechanism | Tested? |
|---|---|---|
| F-P3-12 `link_edit.branch_id` column add | Down migration removes column + index; re-backfill optional | Must test on restored-prod copy |
| F-P3-13 read-path branch filter | Feature-flag the `branchId` term-injection; flag-off reverts behaviour | Must test flag toggle end-to-end |
| F-P3-14 merge rewrite | Branch-merge endpoint is idempotent by design; rollback = redeploy prior image + set flag | Must test double-apply detection |
| F-P5-03 OS index rename | Alias-based migration: old index retained read-only; writes dual-path; switch on → old index preserved for rollback | Must test alias switch under load |
| F-P4-23/24/25 secrets | Vault rotation independent of code; code rollback is trivial | Must test rotation drill |
| F-P4-12 Redis rate limiter | Feature-flag: in-memory ↔ Redis; flag-off = old behaviour | Must test flag toggle under load |
| F-P3-11 audit hash-chain | New columns nullable; writing hash is additive; rollback = stop writing, chain-holes accepted | Must test chain-hole repair procedure |
| Fastify migration per route | `/api/v1/*` remains on Express; `/api/v2/*` Fastify; Ingress weight controlled | Standard strangler rollback |

**Rollback rehearsal:** 1 full day per quarter. If rollback is not rehearsed, rollback does not exist.

**Effort: 2 engineer-weeks to document + rehearse rollbacks; 11+ weeks elapsed calendar ramp.**

**Gate:** `ROLLBACK.md` with each change's rollback mechanism + last-rehearsed date; canary Stage 4 complete for 2 weeks before any Stage 5 move.

---

## Appendix J — Regulatory & Legal Sign-Off

Engineering readiness is one leg; legal readiness is another.

- **Rwandan DPA approval** of audit mechanism chosen in response to Q2 §9. This is an external gate with a multi-week cycle; start the conversation at week 3 of remediation, not week 14.
- **Data Protection Impact Assessment (DPIA)** under Law 058/2021 Art. 20–22: required for processing of tax-sensitive data at this scale.
- **Controller / Processor agreements** between Tellus operator and RRA.
- **Cross-border data flow agreements** if any dependency (S3, OpenSearch, ClickHouse) sits outside Rwanda.
- **Vulnerability-disclosure policy** (`SECURITY.md` at repo root) with named contact + PGP key.
- **Data processing agreement with Keycloak hosting** (if hosted externally).
- **Insurance** — professional indemnity sufficient for the scale of data processed. External legal counsel.

**Effort: engineering effort is minimal (doc production ~1 engineer-week). Elapsed time is the gate: DPA review cycles typically 4–8 weeks.**

**Gate:** `LEGAL_SIGNOFF.md` with DPA acknowledgement, DPIA filed, counsel sign-off.

---

## Appendix K — Revised Roadmap to GO PRODUCTION

Replacing §11's timeline. Assumes 3 senior engineers + 1 SRE/operations + access to external pen-test firm + legal counsel.

| Weeks | Lane A (Core fixes) | Lane B (Security & Audit) | Lane C (Scale & Ops) | External |
|---|---|---|---|---|
| 1 | Block A (invisible bugs) | Block A + start Appendix A gates | Setup staging cluster + seed data | — |
| 2–4 | Block E branching (if Q4) | Block B audit + Appendix B.1 Q2 resolution | Block D K8s + Appendix D load-test infra | Start DPA conversation |
| 5–7 | Continue E | Block C CBAC + Appendix B investigations | Block F scale rewrites + Appendix D first load tests | Pen-test firm selected & scoped |
| 8–10 | Finish E | Block G observability + Appendix B.8 ClickHouse | Block F timeouts/breakers + Appendix E chaos setup | Pen-test begins |
| 11–13 | Block H tests + coverage | Finish Appendix B investigations + re-audit any new findings | Appendix E chaos execution + fixes | Pen-test report + remediation |
| 14–15 | Block I Fastify start | — | Appendix F DR drills + Appendix D soak test (72h) | — |
| 16–18 | Block I Fastify complete | Appendix H on-call + synthetics + training | Appendix C Funnel audit (parallel) | Pen-test re-test |
| 19–22 | — | — | Appendix C Funnel remediation | DPA review in progress |
| 23+ | Stage 0 canary → Stage 7 (11+ weeks) | | | Legal sign-off |

**Realistic total: 22–26 engineering weeks + 11+ weeks staged rollout = ~8–9 months elapsed to full GO PRODUCTION on all tenants.**

**Minimum if branching deferred (Q4=post-launch) and single-tenant and no new P0 from Appendix B or C:** ~16 engineering weeks + 8 weeks rollout = ~6 months elapsed.

**Pessimistic if branching required + DPA mandates external WORM anchor + Funnel audit surfaces 4 P0s + pen-test surfaces Critical:** ~35 engineering weeks + 11 weeks rollout = ~12 months elapsed.

Anyone claiming shorter than 6 months elapsed is not being honest.

---

## Appendix L — The Binary GO PRODUCTION Checklist

Print this. Tape it to the wall. Each box must be checked, in order, with evidence linked, before traffic is served.

### L.1 Engineering gates (code)

- ☐ All 16 P0 findings in §3 table closed with PR references.
- ☐ All 35 P1 findings in §4 closed or explicitly accepted as P2-future-work by named decision-maker.
- ☐ 3 consecutive full-suite runs: 0 failed, 0 ghost-passes (0-ms integration passes), counts identical.
- ☐ Critical-path branch coverage ≥ 80% reproducible from `scripts/coverage-server.sh` on clean clone.
- ☐ CI coverage gate green on last 10 PRs to `main`.
- ☐ Every P0 PR clears Appendix A.2 checklist with 2 reviewers.
- ☐ `CHANGELOG.md` current.

### L.2 Investigation gates (unknowns closed)

- ☐ All 10 UNVERIFIED ASSUMPTIONS (Appendix B) investigated; `INVESTIGATION_REPORT.md` committed.
- ☐ Any new findings from Appendix B remediated or accepted.
- ☐ Pipeline Builder + Funnel audit complete (`FUNNEL_AUDIT.md` committed); findings remediated.

### L.3 Performance gates (measured, not predicted)

- ☐ Load test at 1× SLO green (1 hour).
- ☐ Load test at 2× SLO: graceful degradation confirmed.
- ☐ Load test at 10× SLO: no OOM, no cascade, recovery < 5 min.
- ☐ 72-hour soak test green: heap stable, pools stable, no latency drift.
- ☐ CI performance regression gate green for 7 consecutive days on `main`.
- ☐ `PERFORMANCE_REPORT.md` committed.

### L.4 Resilience gates (chaos verified)

- ☐ All 10 GameDay scenarios (Appendix E) executed twice each.
- ☐ MTTD < 2 min, MTTR < 5 min on each scenario.
- ☐ No P0 open from chaos run.
- ☐ `GAMEDAY_LOG.md` committed.

### L.5 DR gates

- ☐ `DR.md`, `BACKUP.md`, `RESTORE_DRILL.md` committed.
- ☐ 3 consecutive successful monthly restore drills on staging.
- ☐ RTO/RPO targets documented and demonstrably met.

### L.6 Security gates

- ☐ External pen-test completed.
- ☐ All Critical + High findings closed.
- ☐ Re-test sign-off from pen-test firm.
- ☐ `SECURITY.md` committed at repo root with vulnerability disclosure policy.
- ☐ Container + K8s hardening verified (non-root, read-only FS, restricted PSA, NetworkPolicy).
- ☐ SBOM generated and CVE scan clean on `node_modules`.

### L.7 Operational gates

- ☐ 4 trained on-call engineers named in `ONCALL.md`.
- ☐ PagerDuty/Opsgenie configured with primary/secondary/escalation.
- ☐ Runbook per Prometheus alert linked from alert definition.
- ☐ Synthetic probes running from outside K8s cluster on 5 canary endpoints.
- ☐ Grafana SLO burn-rate alerts configured.
- ☐ `CHANGE_MANAGEMENT.md` approved and followed on last 3 production deploys to staging.
- ☐ First incident simulation drill complete; post-mortem filed.

### L.8 Legal gates

- ☐ DPA review complete; approval letter on file.
- ☐ DPIA filed under Law 058/2021.
- ☐ Controller/Processor agreements signed.
- ☐ Insurance in place.
- ☐ Legal counsel sign-off on `LEGAL_SIGNOFF.md`.

### L.9 Rollout gates

- ☐ All rollbacks in Appendix I.2 rehearsed within last 90 days; dates in `ROLLBACK.md`.
- ☐ Stage 0 (synthetic traffic only) complete with no sev-1.
- ☐ Stages 1–4 (canary ramp on first tenant) complete with no abort trigger hit.
- ☐ For multi-tenant: Stages 5–7 complete with isolation verified.

### L.10 Process gates

- ☐ ≥2 contributors to `main` on the last 10 merges (no more bus-factor-1).
- ☐ `README.md` restored and current.
- ☐ `ARCHITECTURE.md` current (reflects Keycloak, Temporal, Kafka, Iceberg/Lakekeeper, Quickwit, ClickHouse, MinIO/S3, Redis, OpenTelemetry).
- ☐ `SECRETS.md`, `RUNBOOK.md`, `INCIDENT_RESPONSE.md`, `SLO.md`, `DR.md`, `BACKUP.md`, `RESTORE_DRILL.md`, `KEY_ROTATION.md`, `CHANGE_MANAGEMENT.md`, `SYNTHETICS.md`, `DATA_LIFECYCLE.md`, `GAMEDAY_LOG.md`, `PERFORMANCE_REPORT.md`, `INVESTIGATION_REPORT.md`, `FUNNEL_AUDIT.md`, `LEGAL_SIGNOFF.md`, `ROLLBACK.md`, `ONCALL.md` all present, dated within last 90 days.

### L.11 Final gate

- ☐ **Independent re-audit** by a second senior engineer (not the original auditor, not the implementer) reproduces the fixes, verifies L.1–L.10, signs off in writing. File: `FINAL_AUDIT_SIGNOFF.md` with signatory, date, evidence references.

**When L.1 through L.11 are ALL checked, and only then, the repository is GO PRODUCTION.**

---

## Final Note

If at the end of 22–26 engineering weeks + 11 weeks rollout + 4-8 weeks legal, any single box in Appendix L is unchecked — **you are not ready**. Shipping anyway means choosing to ship with known unknowns, which is the definition of negligence in a regulated deployment.

This appendix exists so no reviewer — codex, the repo owner, a future on-call engineer, or a regulator — can claim they were not told.

**End of Appendix. End of report.**

---

# APPENDIX M — Continuous-Green Clause (Added Post-Review)

This appendix closes a gap in Appendix L: the original checklist is written as a **pre-launch snapshot**. A snapshot is insufficient for a regulated deployment. Gates that go green at week 22 must **stay green** through canary completion at week 34 and beyond. Otherwise you are launching a system that differs from the one that was audited.

## M.1 Continuous-Green Invariants

From the moment Appendix L.11 is signed off, and continuing through Stage 7 of Appendix I.1 and for **30 consecutive days** after Stage 7 reaches 100% traffic, the following gates **must not regress**:

| Gate | Evidence (must remain true every day) | Regression response |
|---|---|---|
| M.1.1 | CI branch-coverage gate ≥ 80% critical path on every merge to `main` | Failing PR blocked; gate repair required within 1 business day |
| M.1.2 | CI performance regression gate: p99 not regressed > 10% vs. baseline | PR blocked; perf team investigates within 1 business day |
| M.1.3 | 3 consecutive determinstic test runs (1067+ passes, 0 ghost-pass, 0 skip-other-than-known) on nightly CI | Break = P1 incident; revert triggering commit within 4 hours |
| M.1.4 | Zero open P0 findings from any audit, pen-test, chaos, or incident post-mortem | New P0 = immediate Stage rollback to previous stage |
| M.1.5 | Synthetic probes (Appendix H.4) green from external origin | 3× consecutive failures = auto-rollback to previous Stage |
| M.1.6 | Secret vault health: no `|| 'fallback'` literals introduced in `grep -rn` scan | `gitleaks`/`trufflehog` CI job must remain green |
| M.1.7 | Dependency CVE scan: no unpatched Critical or High CVE older than 14 days | CVE triage SLA: 72 hours to patch or document accepted risk |
| M.1.8 | On-call rotation: ≥ 4 trained engineers remain rostered | <4 = freeze new deploys until backfilled |
| M.1.9 | Rollback rehearsal: most-recent rehearsal for every change in Appendix I.2 ≤ 90 days old | Expired rehearsal = that rollback considered not-tested = Stage freeze until re-rehearsed |
| M.1.10 | Error budget: not exhausted per SLO policy | Budget exhausted = feature freeze per Appendix H.2 |

## M.2 Steady-State Entry Criterion

Production is **not** declared "steady state" until:

- Stage 7 (100% traffic, all tenants) has been live for **30 consecutive days**, AND
- All 10 M.1 invariants were green every day of those 30 days, AND
- No Sev-1 or Sev-2 incident occurred in those 30 days attributable to the remediation work covered in this report.

Until steady state is declared, **any M.1 regression triggers Stage rollback**, not merely a fix-forward.

## M.3 Steady-State Maintenance

Post steady-state, the M.1 gates continue to apply as **ongoing production engineering discipline**, not as one-time sign-off items. This is not a checklist that completes; it is a standard the team operates under indefinitely.

Quarterly re-certification: a lightweight re-audit (1 engineer-week) verifies M.1 gates are still green and no drift has accumulated. Annual external pen-test refresh (Appendix G) is mandatory for any regulated deployment.

## M.4 Amendment to Appendix L.11 (Final Gate)

The final gate now reads:

> ☐ Independent re-audit by a second senior engineer verifies L.1–L.10 AND M.1 invariants green continuously from L.11 sign-off date through Stage 7 day-30. File: `FINAL_AUDIT_SIGNOFF.md` with signatory, date, evidence references, and continuous-green log.

---

**True End of Report.** The document is now complete for codex review.
