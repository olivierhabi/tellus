# Changelog

All notable changes to the Ontology Engine project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- **Funnel merge promote no longer times out at multi-million-row scale**:
  `promoteMergeStaging` copied a whole staging run into `object_instances`
  in ONE statement; at 6,353,307 rows it hit the 60 s
  `PG_STATEMENT_TIMEOUT_MS` (`57014`) and, being silent, starved the
  progress-coupled Temporal heartbeat. Verify, promote and staging cleanup
  now walk the run in primary-key chunks (`mergePromoteChunkRows`,
  250k) inside the caller's single transaction (still all-or-nothing),
  deletes go through an index-keyed `primary_key = ANY(...)` instead of a
  join, and progress is reported after every chunk. Measured on Postgres 16
  (2 vCPU / 4 GB) with the default 60 s timeout: 6.35M-row first load
  promoted in 133 s, slowest chunk 5.7 s.
- **`funnel-scale.yml` never ran** (0 jobs on every push): job-level `env`
  used `${{ runner.temp }}`, which GitHub rejects. The workdir is now set at
  step level, and the job asserts it runs on the 4 vCPU / 16 GB public-repo
  runner.
- Merge log says "first load" instead of "materialized-count drift" when the
  live table is empty.

### Added
- **God-file breakup, second wave (behavior-preserving, no logic changes)**:
  - `src/services/transformService.ts` (2726 LOC) → chain replay
    (`applyExistingTransforms` / `applyExistingTransformColumns`, ~340 lines)
    extracted to `src/services/transform/applyExisting.ts`, service keeps
    thin wrappers (public API + `TransformOpsContext` seam unchanged),
    guarded by `tests/unit/services/transform/applyExisting-unit.test.ts`
    (14 tests) with the legacy
    `tests/foundry/unit/transform-service-aggregate-family-unit.test.ts`
    suite green through the wrappers
  - `src/services/deploymentService.ts` (3557 LOC) → PB-B6 preview-snapshot
    pinning (`collectPreviewPinning`, ~120 lines) extracted to
    `src/services/deploy/previewPinning.ts`, guarded by
    `tests/unit/services/deploy/previewPinning-unit.test.ts` (6 tests:
    empty envelope, digest stability, PREVIEW_STALE + details, force and
    ignore-preview overrides)
  - `src/docs/openapi.ts` (3299 LOC) → served-spec auto-stub machinery
    (`normShape`/`areaTag`/`pathParameters`/`isPublicPath`/`autoStub`)
    extracted to `src/docs/openapiAutoStub.ts`, guarded by
    `tests/unit/docs/openapiAutoStub-unit.test.ts` (8 tests)
- **Pipeline orchestration & lineage docs** (`docs/operations/pipeline-orchestration.md`):
  Temporal as the orchestrator, `datasetLineage` edges, immutable
  `funnel_run` definition snapshots, and the layered data-quality gates —
  closes the "no orchestrator / no lineage docs" finding against existing code
- **IaC direction ADR** (`decisions/infrastructure/D-2026-09-09-001-iac-direction.md`):
  Helm-first, Terraform deferred until a cloud-provisioned dependency lands
- **Contributing guide** (`CONTRIBUTING.md`, linked from `README.md` §10):
  setup, test lanes, raise-only coverage ratchet, CI gates, commit/release
  conventions, and contributor security rules
- **Deploy pipeline** (`.github/workflows/deploy.yml`): tag-gated Docker image
  build, Helm lint for `deploy/substrate/charts/tellus-tenant`, and
  manifest validation for `k8s/` + `infra/k8s/`
- **Coverage enforcement**: `vitest.config.ts` now carries `coverage.thresholds`
  (integration lane floor; the unit lane in `vitest.unit.config.ts` remains
  authoritative) and the Codecov **patch** gate is enforcing (80% target)
- **Secret-scan precision** (`.gitleaks.toml`): scoped allowlists for CI/test-only
  fallback credentials (`ci.yml`, `coverage-gate.yml`, compose files,
  `.env.test.example`) so new real secrets still fail the build
- **Growth guards** (`eslint.config.js`): `max-lines` + `complexity` warnings
  flag god-file growth without failing the build

### Changed
- **Structured logging** (`src/logging/pino.ts`): static `pino` import — `pino`
  is a hard dependency (`package.json`), so the stale dynamic-require fallback
  comment is retired; the console-backed shim remains for minimal environments
- **Dependency prune**: removed 6 unused runtime deps (`adm-zip`, `bcrypt`,
  `http-proxy-middleware`, `nodejs-polars`, `otplib`, `swagger-ui-express`)
  and 3 orphaned `@types` packages — verified unreferenced across `src/`,
  `scripts/`, `tests/` and configs (docs are CDN-served, TOTP uses `qrcode`
  directly, polars references were Python-side); `@temporalio/common` kept
  as an SDK peer despite no direct import

## [0.4.0] - 2026-09-09 (Wednesday)

### Added
- **Error-tracking sink** (`src/services/errorTracking.ts`): `captureError()` forwards
  5xx-class failures to Sentry when `SENTRY_DSN` is set; unset DSN is a hard no-op,
  4xx client errors never forward, missing SDK degrades to structured logs. Wired
  into every terminal branch of `src/middleware/errorHandler.ts` (response
  envelopes unchanged) with `tests/unit/middleware/errorHandler-unit.test.ts`
- **Structured logging**: `pino` (^10.3.1) + `pino-pretty` (dev) dependencies and
  canonical `src/utils/logger.ts` over the PII-redacting `src/logging/pino.ts`;
  `src/services/otelBootstrap.ts`, all 75 call sites in `src/server.ts`, and
  `src/middleware/errorHandler.ts` now log structured JSON
- **Test-lane secret resolution** (`tests/testEnvFile.ts`): `requiredTestSecret()`
  chain (env > `.env.test` > `.env.test.example`, fail-fast) replaces the
  `tellus123` / `tellus_ch_pw` literals in `tests/laneEnv.ts`,
  `vitest.osv2-serving.config.ts`, lane bootstrap and lane configs

### Changed
- `.env.example`: audited gap-fill — all 272 `process.env.*` vars referenced in
  `src/` now documented as commented placeholders with code defaults
- `.env.test.example`: carries the lane container dev defaults (env still wins)
- CI: unit lane documented as the first zero-Docker gate (`pnpm install &&
  npm run test:unit`, no compose up); `vitest.unit.config.ts` drops the
  `PGPASSWORD` fail-fast for a non-functional sentinel (lane proven green
  with a bogus password) and enforces a raise-only coverage floor
  (lines 37 / branches 30; 70/60 remains the tracked aspiration)

## [0.3.1] - 2026-09-09 (Wednesday)

### Changed
- **God-file breakup, behavior-preserving (no logic changes)**:
  - `src/routes/actionTypes.ts` (3926 LOC) → `src/routes/actionTypes/`
    (`create`/`list`/`update`/`clone`/`impact`/`migrate`/`delete` + `shared`,
    thin `index.ts` preserving route order and public API), guarded by
    `tests/unit/routes/actionTypesRouter-unit.test.ts`
  - `src/services/deploymentService.ts` → `src/services/deploy/`
    (`csvSerialization`, `icebergOutputReads`, `batchEngineSelection`),
    each with focused `tests/unit/services/deploy/*-unit.test.ts`
- Each extraction landed as its own small commit with its spec; full unit
  lane green (`test:unit` exit 0) after every commit

## [0.3.0] - 2026-03-15 (Sunday)

### Added
- **Interface System (Polymorphism)**
  - `interface` and `interface_property` PostgreSQL tables with CHECK constraints
  - `object_type_interface` junction table for Object Type → Interface mapping
  - Full CRUD API for Interfaces (`POST/GET/PUT/DELETE /api/v1/ontology/:id/interfaces`)
  - "Implements Interface" API for Object Types (`POST/GET/DELETE .../implements`)
  - Interface property mapping validation service with type compatibility checks
  - Polymorphic search across all implementing Object Types (`POST .../interfaces/:name/search`)
  - Polymorphic aggregation with merge strategies (`POST .../interfaces/:name/aggregate`)
  - Query DSL translation from Interface property names to Object Type property names

- **Object View API**
  - Single object complete view with property metadata enrichment
  - Linked objects retrieval grouped by link type
  - Batch object views (up to 100 primary keys)
  - Property metadata enrichment service with cached lookups and type-aware formatting

- **Enhanced Middleware**
  - Global error handler with AppError hierarchy (Validation, NotFound, Conflict, Auth, Server)
  - Enhanced request logger with timing, structured JSON, configurable health check skip
  - Schema-based request validation middleware factory
  - Input sanitization (whitespace trimming, null byte stripping, XSS prevention, depth limiting)
  - 404 handler with available endpoints link

- **System Health & Resilience**
  - Kubernetes-compatible health probes (health, readiness, liveness)
  - OpenSearch connection resilience with retry and circuit breaker patterns
  - PostgreSQL connection resilience with transient error detection
  - Graceful shutdown handler (SIGTERM/SIGINT with connection draining)

- **Documentation & Tooling**
  - API reference documentation generator
  - Comprehensive seed data script (RRA demo environment)
  - Docker Compose test environment configuration
  - Performance benchmarks for Sunday features
  - CHANGELOG.md

### Changed
- Enhanced error handler middleware to support structured JSON responses with requestId
- Enhanced request logger to include timing, body size, and configurable skip paths

### Security
- Removed hardcoded test credentials: `vitest.config.ts`, `vitest.unit.config.ts`, and `vitest.osv2-serving.config.ts` now read `PGPASSWORD` from the environment and fail fast when it is unset — no inline literal defaults remain
- `test-datasource-attach.sh` and `test-datasource-funnel-trigger.sh` now require `API_KEY` to be exported by the caller instead of defaulting to a baked-in value
- Added `.env.test.example` documenting the required test-only variables (`PGPASSWORD`, `API_KEY`)

### Added
- Full contributor README: prerequisites, install, environment setup, docker-compose local stack (Postgres/OpenSearch/Keycloak/MinIO with ports), run/test instructions, one-command smoke test, and an architecture overview
- CI `typecheck` job (`tsc --noEmit`) gating all test jobs; lint job confirmed to fail the workflow on violations
- Dependabot configuration for weekly npm and GitHub Actions updates (`.github/dependabot.yml`)

## [0.2.0] - 2026-03-14 (Saturday)

### Added
- **Dataset Integration Layer**
  - `dataset` and `dataset_transaction` PostgreSQL tables
  - `reindex_history` table for audit trail
  - `dataset_id` foreign key on `backing_datasource` table
  - File upload handler with Multer (CSV/JSON/JSONL, 500MB limit)
  - Dataset creation API (`POST /api/v1/datasets/upload`)
  - Dataset listing, detail, and deletion endpoints
  - Append transaction endpoint with schema compatibility validation

- **Reindex Engine**
  - Multi-transaction file merging (Map keyed by PK, latest transaction wins)
  - Edit preservation across reindex (user edits always win over datasource data)
  - Smart skip logic (no-op if no changes since last reindex)
  - Atomic locking to prevent concurrent reindex operations
  - Reindex status and history endpoints

- **Dataset-Backed Datasources**
  - Updated datasource registration to accept `datasetId` or `filePath`
  - Levenshtein distance suggestions for column name typos ("Did you mean?")
  - Auto-index-on-upload pipeline (optional, non-blocking)

- **Column Mapping Suggestion Engine**
  - Name similarity scoring (Levenshtein + substring matching)
  - Type compatibility scoring matrix
  - Greedy assignment algorithm with confidence levels (exact/high/medium/low)

- **File Processing Utilities**
  - File reader utility (CSV with delimiter detection, JSON array, JSONL)
  - Type conversion utility (European decimals, DD/MM/YYYY dates, geopoints, arrays)
  - BOM stripping, null normalization, encoding detection

- **Edit Verification**
  - Edit listing with filtering (indexed, operation, primaryKey)
  - Diff view showing datasource vs. ontology values per object

- **Bulk Actions**
  - Bulk action endpoint (up to 1000 items per request)
  - `stopOnError` and `autoIndex` flags
  - Partial success handling with per-item results

- **Data Preview**
  - Preview endpoint with column statistics (null/unique counts, sample values, numeric stats)
  - Merged multi-transaction preview without edit overlay

- **Health & Monitoring**
  - Enhanced health check with PostgreSQL + OpenSearch probes
  - Comprehensive system status endpoint

- **Documentation & Testing Infrastructure**
  - API documentation generator
  - Test data generator with Rwandan-specific data (names, locations, TINs)
  - Performance benchmark suite (indexing, query, search-around, action throughput)
  - Run-all-tests orchestrator
  - Architecture documentation with Palantir mapping reference

## [0.1.0] - 2026-03-10 (Monday - Friday)

### Added
- PostgreSQL metadata store (ontology, object_type, property, backing_datasource tables)
- Full CRUD API for ontologies, object types, and properties
- 23 Palantir base type system with validation and coercion
- OpenSearch indexing pipeline (CSV reader, type converter, bulk indexer)
- Link types with 4 cardinalities (ONE_TO_ONE, ONE_TO_MANY, MANY_TO_ONE, MANY_TO_MANY)
- Link resolution, Search Around, and multi-hop traversal
- Action engine with rules (createObject, modifyObject, deleteObject, addLink, removeLink)
- Action audit logging with idempotency key protection
- Query API with filter DSL, full-text search, and aggregations
- Cursor-based pagination across all list endpoints
- Security headers (Helmet), rate limiting, CORS, compression
- Swagger UI documentation
- Comprehensive test suite (unit, integration, E2E) for Monday-Friday
