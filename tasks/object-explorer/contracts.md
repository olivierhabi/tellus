# Object Explorer — Contract Enumeration (C-01..C-NN)

Source: `tasks/object-explorer/object-explorer-tasks.md` (T-01..T-10).
Each contract below is referenced by ID in test names (`T-XX C-YY: <behavior>`)
and in the FINAL_REPORT coverage matrix.

A contract is **violation-testable** when there is at least one test that
**fails when the contract is violated** (not merely passes when it holds).

---

## T-01 — Canonical `applyContextToQuery` helper

| ID | Contract |
|---|---|
| C-01 | `applyContextToQuery(query, secFilter, branchId)` returns `query` unchanged when both `securityFilter` and `branchId` are nullish. |
| C-02 | When `securityFilter` is non-null, the returned query has the original `query` AND the `securityFilter` clause inside `bool.must`. |
| C-03 | When `branchId` is a non-empty string, the returned query has a branch-disjunct clause (`{ bool: { should: [{term:{__branch}}, {bool:{must_not:[{exists:{field:'__branch'}}]}}], minimum_should_match: 1 } }`) inside `bool.must`. |
| C-04 | An empty-string `branchId` is treated as `null` — no branch clause is added. |
| C-05 | The helper is pure: no side effects, no I/O, no logging. |
| C-06 | `applyContextToBody(body, secFilter, branchId)` returns `{ ...body, query: applyContextToQuery(body.query ?? { match_all: {} }, ...) }`. |
| C-07 | `injectSecurityFilter` is a one-line delegate to `applyContextToBody` with no observable behaviour change. |
| C-08 | The `tellus_read_branch_filtered_total{route, scoped}` counter is incremented exactly once per modified call site, with `scoped=true` iff `branchId !== null`. |
| C-09 | `route` label is bounded to a known enum (≤ 22 values) and never includes user-supplied strings. |
| C-10 | Wrapper idempotence (property): applying `applyContextToQuery` twice with the same arguments yields the same result-shape under one canonical normalization. |
| C-11 | `comparisons.ts` `/aggregate`: an `_msearch` sub-body's `query` field is wrapped; the `aggs` block is **not** wrapped. |
| C-12 | `charts.ts` `/charts/batch`: each per-spec sub-body's `query` field is wrapped; the `aggs` block is not wrapped. |
| C-13 | Cross-branch leak: a fixture document indexed with `__branch=A` does not contribute to aggregations for an `_msearch` issued with `x-branch-id: B`. |

## T-02 — Delete legacy `/charts/{listogram,histogram,dateHistogram,auto}` endpoints

| ID | Contract |
|---|---|
| C-20 | `POST /api/v1/charts/listogram` returns HTTP 404. |
| C-21 | `POST /api/v1/charts/histogram` returns HTTP 404. |
| C-22 | `POST /api/v1/charts/dateHistogram` returns HTTP 404. |
| C-23 | `POST /api/v1/charts/auto` returns HTTP 404. |
| C-24 | The PG-direct read function `loadObjectRows` is removed from `src/routes/charts.ts`. |
| C-25 | `src/services/polarsAggregator.ts` is removed if no remaining importers (verified by static scan). |
| C-26 | `/charts/batch` parity: a fixture call that previously hit `/charts/auto` produces a response of the same shape from `/charts/batch`. |

## T-03 — SQL endpoint hardening

| ID | Contract |
|---|---|
| C-30 | Cache key is `${ontologyId}:${branchId ?? "_main"}:${securityFingerprint}` where `securityFingerprint` = first 16 hex chars of `sha256(JSON.stringify(buildSecurityFilter(ctx)))`. |
| C-31 | Two principals with different security fingerprints get different cached DBs (no row leak). |
| C-32 | In-flight-promise mutex: N concurrent callers on same cache key after TTL expiry produce 1 PG/OS load and N-1 `inflight_join` counter increments. |
| C-33 | DuckDB sandbox: `enable_external_access=false`, `disable_external_extensions=true`, `allow_unsigned_extensions=false`, `enable_http_metadata_cache=false`, `threads=2`, `memory_limit='512MB'` are set on every newly-built DB. |
| C-34 | `pragma` is **not** in `ALLOWED_LEADING`; new allowlist is `['select','with','describe','show','explain']`. |
| C-35 | The `INSTALL 'json'; LOAD 'json';` statements are removed; `read_csv_auto` and `read_json` are unavailable. |
| C-36 | A SQL statement exceeding `SQL_STATEMENT_TIMEOUT_MS=10_000` returns `SQL_STATEMENT_TIMEOUT` error code with HTTP 504. |
| C-37 | A SQL leading keyword outside the allowlist returns `SQL_DISALLOWED_KEYWORD` error code with HTTP 400. |
| C-38 | `POST /sql/invalidate` from a non-admin (lacking `role:ontology-admin` in `cbac`) returns HTTP 403 with `INSUFFICIENT_ROLE`. |
| C-39 | `POST /sql/invalidate` from an admin without `ontologyId` body field returns HTTP 400 with `VALIDATION_ERROR`. |
| C-40 | `POST /sql/invalidate` from an admin with `ontologyId` returns HTTP 204. |
| C-41 | The PG-direct dump in `buildDb` is replaced by per-object-type OpenSearch search using `applyContextToBody` so RLS markings are honored. |
| C-42 | DuckDB build streams via OpenSearch with at most `FURNACE_SAMPLE_LIMIT` rows per type (default 5000, range 1000..50000). |
| C-43 | Metrics `tellus_sql_query_duration_seconds`, `tellus_sql_cache_hits_total`, `tellus_sql_invalidate_total` are emitted at the documented points. |

## T-04 — Branch-aware writeback overlay

| ID | Contract |
|---|---|
| C-50 | `OverlayRecord` has a required `branchId: string` field; `_main` is the sentinel for null branch. |
| C-51 | `overlayKey(branchId, ot, pk)` returns `overlay:${branchId ?? "_main"}:${objectType}:${pk}`. |
| C-52 | `legacyOverlayKey(ot, pk)` returns `overlay:${objectType}:${pk}` and is used only during `OVERLAY_READ_LEGACY=true`. |
| C-53 | Cross-branch read isolation: a record written on branch B with PK `emp-1` is not returned by a read on branch A with the same PK. |
| C-54 | CAS on version: incoming write with `version <= stored.version` throws `OVERLAY_VERSION_CONFLICT` (HTTP 409). |
| C-55 | Legacy compatibility: when `OVERLAY_READ_LEGACY=true`, a record at the legacy key is returned only on `_main`-branch reads. |
| C-56 | Phase 3 (`OVERLAY_READ_LEGACY=false`): legacy keys are never read. |
| C-57 | When `OVERLAY_DUAL_WRITE=true` and `branchId="_main"`, writes go to both new key and legacy key. |
| C-58 | `tellus_overlay_reads_total{branch_match, source}` and `tellus_overlay_writes_total{outcome}` and `tellus_overlay_legacy_hits_total` counters are emitted at the documented points. |
| C-59 | `OVERLAY_BRANCH_MISMATCH` is thrown if a read parses to a record whose `branchId` does not match the request branch (defense-in-depth). |

## T-05 — Export pipeline

| ID | Contract |
|---|---|
| C-70 | `GET /api/v1/ontology/:ontologyId/exports/:jobId` for user B targeting user A's job returns HTTP 404 (IDOR-prevention pattern). |
| C-71 | The per-poll status-tick fakery is removed from `routes/exports.ts`; the row is returned as-is. |
| C-72 | At job-creation time, `security_context_snapshot` and `branch_id_snapshot` are persisted (Phase B). |
| C-73 | Worker (`executeExportActivity`) executes against the snapshotted security context, not the requester's live session. |
| C-74 | Job state transitions: PENDING → RUNNING → (COMPLETED | FAILED). |
| C-75 | Worker enforces `MAX_EXPORT_ROWS=1_000_000`; exceeding produces `EXPORT_LIMIT_EXCEEDED` and `status=FAILED`. |
| C-76 | Download URLs are signed and TTL-bounded by `EXPORT_DOWNLOAD_TTL_MS=24h`; expired URL returns `EXPORT_DOWNLOAD_EXPIRED` (HTTP 410). |
| C-77 | Workflow retries on transient failure: `EXPORT_WORKFLOW_RETRIES=3` with exponential backoff. |
| C-78 | `tellus_export_jobs_total`, `tellus_export_rows_streamed_total`, `tellus_export_duration_seconds` are emitted. |
| C-79 | Phase A: `/exports/:downloadToken.:format` returns HTTP 501 with `EXPORT_NOT_AVAILABLE`. |

## T-06 — Eliminate `|| "system"` auth fallback

| ID | Contract |
|---|---|
| C-90 | `currentUser(req)` returns the authenticated `req.user.id` string. |
| C-91 | `currentUser(req)` throws `UNAUTHORIZED` (HTTP 401) when `req.user.id` is missing or empty. |
| C-92 | No `(req as any).user?.id || "system"` or `?? "system"` literal remains in `src/`. |
| C-93 | `/summary` excludes object types whose `marking_required` is not a subset of the user's marking set. |
| C-94 | `/summary` excludes object types whose `visibility = 'hidden'`. |
| C-95 | Favorites/recents are scoped: user A's favorites do not appear in user B's `/summary`. |
| C-96 | Favorites query is bounded by `LIMIT 20`. |
| C-97 | The migration `add_marking_required_to_metadata` is idempotent and reversible. |

## T-07 — Unified error envelope + verbose-404 gate

| ID | Contract |
|---|---|
| C-110 | Every error response on the explorer surface conforms to `ErrorEnvelope { errorCode, errorName, message, statusCode, requestId, parameters?, error: { code, message } }`. |
| C-111 | `ErrorCode` is a TypeScript-checked union — passing an unknown code to `appError` fails type-check. |
| C-112 | `sanitizeMessage` strips file paths, IPs, stack traces, and SQL fragments from any user-facing message. |
| C-113 | `ensureObjectTypeExists` returns `Object type not found.` (no name leak) in production unless both `NODE_ENV !== 'production'` AND `TELLUS_DEBUG_404 === 'true'`. |
| C-114 | Removed codes (`CHART_ERROR`, `SQL_ERROR`, `VALIDATION_FAILED`, `NOT_FOUND`, `LINK_CYCLE_DETECTED`) are not present in `src/`. |
| C-115 | `LINK_CYCLE_DETECTED` migrates to `VALIDATION_ERROR` with `parameters.subtype = "link_cycle"`. |
| C-116 | `requestId` is propagated to every error envelope from `req.requestId`. |

## T-08 — Saved Explorations marking-aware visibility

| ID | Contract |
|---|---|
| C-130 | `saved_exploration.required_markings` column exists, `TEXT[] NOT NULL DEFAULT '{}'`, GIN-indexed. |
| C-131 | Single-GET `/explorations/:id`: a row whose `required_markings` is not subset of user's markings returns 404. |
| C-132 | List `/explorations`: rows excluded by markings or by visibility/owner filter are absent. |
| C-133 | `resolveRequiredMarkings(config)` walks the config object-type and property refs and returns the union of `marking_required`. |
| C-134 | PATCH/PUT updating `config` re-runs `resolveRequiredMarkings` and updates the column atomically. |
| C-135 | `tellus_saved_exploration_marking_misses_total` counter is emitted on filtered reads. |
| C-136 | A backfill job populates `required_markings` for existing rows. |

## T-09 — Multi-hop / full-text / pagination

| ID | Contract |
|---|---|
| C-150 | Multi-hop traversal uses an accumulated `visitedPKs` Set; cycles do not produce duplicates. |
| C-151 | `MAX_INTERMEDIATE = 100_000`: exceeding accumulated `visitedPKs` returns `SEARCH_AROUND_LIMIT_EXCEEDED` (HTTP 400). |
| C-152 | Per-hop concurrency is bounded by `MULTI_HOP_CONCURRENCY = 50` (chunked Promise.all). |
| C-153 | Full-text spec syntax: `~`, `*`, `?`, quoted phrases, `AND`/`OR`/`NOT` keywords, parens trigger a `query_string` `should` clause beside `multi_match`. |
| C-154 | `query_string.allow_leading_wildcard = false` is hard-set; leading `*foo` is rejected by Lucene parser. |
| C-155 | `query_string.lenient = true` is set for tolerance to type-mismatch on broad searches. |
| C-156 | `MAX_PAGE_SIZE = 1000` is enforced; requests beyond are clamped to 1000. |
| C-157 | Header `x-tellus-large-page: true` raises the cap to `MAX_PAGE_SIZE_OPT_IN = 2000`. |
| C-158 | `tellus_search_around_visited_pks`, `tellus_search_around_hops`, `tellus_full_text_spec_syntax_total{syntax_used}`, `tellus_pagination_size` histograms/counters are emitted. |

## T-10 — Observability uniformity + AST contract guard

| ID | Contract |
|---|---|
| C-170 | `routeMetric(req, route, branchId)` increments `tellus_read_branch_filtered_total{route, scoped}` exactly once per call. |
| C-171 | `routeLog(req, route, status, durationMs, extras)` emits a JSON line with `level, type='route_call', route, status, durationMs, requestId, traceId, user, ...extras`. |
| C-172 | `routeLog` observes `tellus_route_duration_seconds{route, status_class}` histogram. |
| C-173 | `RouteName` is a bounded TypeScript union — invalid names are a compile-time error. |
| C-174 | The AST guard test in `tests/contract/routeContractGuard.test.ts` walks each read route file and asserts every read handler calls `buildSecurityFilter` AND `readBranchHeader` AND `routeMetric` (or is on the `EXEMPT_LIST`). |
| C-175 | A deliberate diff that removes `buildSecurityFilter` from a handler causes the AST guard test to fail. |
| C-176 | Per-route integration tests cover happy-path, 4xx-input, unauthorized, empty-marking exclusion, cross-branch isolation. |
| C-177 | Cardinality bound: synthetic load with 50 distinct user IDs produces ≤ 132 series for `tellus_route_duration_seconds`. |
| C-178 | `traceparent` request header propagates to a `traceId` field in every `routeLog` line. |
