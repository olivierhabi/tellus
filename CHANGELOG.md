# Changelog

All notable changes to the Ontology Engine project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
