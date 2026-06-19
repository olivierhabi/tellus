# Tellus PostgreSQL Connectivity — Monorepo Implementation Spec (v2)

**Status.** This spec supersedes v1 (`tellus-postgresql-connectivity-spec.md`). It implements the same Foundry-parity capability set inside the existing `tellus` Node/TS monorepo at `/Desktop/projects/tellus` and the existing `tellus-fe` Next.js app at `/Desktop/projects/tellus-fe`. No new repos. No Java sidecars. No Kubernetes hard requirement. All 20 tasks remain; their numbering, contracts, error codes, metrics, and SLOs are preserved verbatim where ecosystem-neutral.

**Stack (v2).**
- **Backend.** Node.js 20 + TypeScript 5 inside the existing `tellus` monolith. New code lives under `src/services/<name>/`, route handlers under `src/routes/<name>/`, middleware under `src/middleware/`. Fastify 4 is the existing HTTP layer. Drizzle ORM 0.30 is the existing data layer. PostgreSQL 16 is both the service tier and the dataset tier (Iceberg writes to a local FS catalog by default).
- **Frontend.** Existing `tellus-fe` Next.js 14 App Router app. New routes under `app/workspace/data-integration/data-connection/`. BlueprintJS 5, TailwindCSS 3, React Query 5, Monaco 0.45 — already wired.
- **JDBC.** `pg` driver (`node-postgres` 8.x) directly from Node. No Java sidecar. Type fidelity through `pg-types` custom parsers.
- **CDC.** `pg-logical-replication` npm package consuming the `pgoutput` plugin in Node. No Debezium. Output message format is canonical and matches v1 byte-for-byte.
- **Streams.** Redpanda single-binary (Kafka API-compatible) via Testcontainers `redpandadata/redpanda:v23.3.x` in dev/CI; Kafka 3.7 KRaft accepted in prod via the same `KafkaAdapter` interface. `kafkajs` 2.2 as the client.
- **Worker runtime.** BullMQ 5 (Redis 7) queue with per-job Node `child_process` isolation. Optional Kubernetes Job adapter (`WorkerRuntimeAdapter`) for prod swap. No hard K8s requirement to ship.
- **Egress.** Worker-side allowlist enforced via `dns.lookup` + connect-time check in a `net.Socket` wrapper. Optional Cilium adapter for prod swap. No hard Cilium requirement.
- **KMS.** `KmsAdapter` interface with three implementations: `LocalAesGcmAdapter` (env-var KEK, dev/CI), `VaultTransitAdapter`, `AwsKmsAdapter`, `GcpKmsAdapter`. Production selects via env.
- **Iceberg.** `iceberg-js` writing to local filesystem catalog at `${TELLUS_ICEBERG_ROOT}` by default; pluggable `CatalogAdapter` for REST/Glue/Snowflake catalog swap.
- **Federation engine.** Node SQL builder + `pg` direct execution returning Arrow IPC streams via `apache-arrow` 17. Custom Tellus REST catalog facade so Spark/Trino consume virtual tables via a thin Tellus connector. No Calcite, no Arrow Flight SQL server in-session — both kept as pluggable `FederationEngineAdapter` for prod swap.
- **Streaming indexer.** Node consumer with backpressured Postgres bulk-upsert (`COPY ... FROM STDIN`); checkpoints in Postgres. Optional Flink adapter for prod. No hard Flink requirement.

**Cross-cutting conventions (unchanged from v1).**
- Conjure-style typed contracts emitted via `@asteasolutions/zod-to-openapi`; errors are `{ errorCode, errorName, errorInstanceId, parameters }`; `errorName` matches `Tellus:Service:PascalCase`.
- ETag (`W/"<version>"`) on every mutable resource read; `If-Match` required on `PUT`/`PATCH`/`DELETE`; mismatch returns 409.
- `Idempotency-Key` header on every mutating endpoint; persisted 24h with response hash.
- Prometheus metrics prefixed `tellus_<service>_*`.
- RIDs follow `ri.<service>.main.<type>.<uuid>`. Connection RIDs remain `ri.magritte..source.<uuid>` (Foundry-parity); imports `ri.magritte..extract.<uuid>`; datasets `ri.foundry.main.dataset.<uuid>`.
- OpenTelemetry via `@opentelemetry/api`; spans tagged `tellus.tenant`, `tellus.user`, `tellus.rid`.
- SLOs unchanged: connectivity service p99 read ≤150ms, p99 write ≤400ms, scheduling overhead ≤2s p95.

**In-session vs. deferred acceptance criteria.** Each task's acceptance criteria are split into:
- **In-session (must pass to close the task)** — runs against Testcontainers PG 16, Redpanda, Redis 7, local Iceberg FS catalog, BullMQ workers in `child_process`.
- **Production-scale (deferred with `DEFERRED.md`)** — criteria that require external infrastructure (K8s + Cilium cluster, 1B-row fixtures, multi-VM agent installs, KMS, deployed Lighthouse). Each deferred entry names the criterion verbatim, the infrastructure needed, and the exact in-session scaled-down test that does run.

---

## Backend tasks

### B1 — Connectivity module skeleton, typed IDL, Compass folder binding

**Goal.** Stand up the `connectivity` module inside the monolith. Define resource contracts (Connections, TableImports, VirtualTables, Drivers) as Zod schemas with OpenAPI emission. Wire Compass folder ownership atomically with the connection insert.

**Dependencies.** Existing `src/services/compass/compassService.ts`, `src/middleware/auth.ts` (Multipass session), existing Postgres pool in `src/lib/db.ts`, existing error envelope in `src/lib/errors/envelope.ts`.

**Files to create (in `tellus` repo).**
- `src/services/connectivity/index.ts` — module entrypoint; registers routes with the Fastify app.
- `src/services/connectivity/contracts.ts` — Zod schemas + inferred types for `Connection`, `TableImport`, `VirtualTable`, `Driver`.
- `src/services/connectivity/openapi.ts` — emits `openapi/connectivity.yaml` from contracts.
- `src/services/connectivity/store/connections.repo.ts` — Drizzle repo.
- `src/services/connectivity/store/outbox.ts` — outbox writer for Compass two-phase commit.
- `src/services/connectivity/handlers/connections.handler.ts` — Fastify handlers.
- `src/services/connectivity/clients/compass.client.ts` — typed wrapper over `compassService` (registerResource, getFolder, checkPermission).
- `src/db/migrations/<timestamp>_connectivity_connections.sql` — schema below (uses existing migration runner).
- `src/db/migrations/<timestamp>_connectivity_outbox.sql` — `connectivity_outbox`.
- `src/middleware/etag.ts` — create if absent (reuse if present).
- `src/middleware/idempotency.ts` — create if absent.
- `src/middleware/scope.ts` — scope-check middleware (reuse existing if present).
- `src/lib/errors/connectivity.errors.ts` — error definitions, registered in `src/lib/errors/registry.ts`.
- `src/routes/connectivity.routes.ts` — route registration.

**Database schema.** Identical to v1 (`connections` table, indexes, ETag from `version`). The migration runs through the existing `tellus` migration tool — no new tooling.

**OpenAPI emission.** `npm run generate:openapi:connectivity` writes `openapi/connectivity.yaml`. The frontend regenerates a typed client via `openapi-typescript` 6 into `tellus-fe/lib/api/connectivity.gen.ts`. This replaces v1's Conjure toolchain end-to-end.

**Endpoints (unchanged from v1).**
```
POST   /api/v2/connectivity/connections
GET    /api/v2/connectivity/connections/{rid}
GET    /api/v2/connectivity/connections
PUT    /api/v2/connectivity/connections/{rid}                     (If-Match)
DELETE /api/v2/connectivity/connections/{rid}                     (If-Match, soft delete)
GET    /api/v2/connectivity/connections/{rid}/configuration
GET    /api/v2/connectivity/connections/{rid}/status
```

**Compass binding contract.** Identical to v1 (folder existence + write permission + atomic outbox-based registerResource). Implementation calls `compassService.registerResource()` inside the same Drizzle transaction as `connections` insert via the outbox pattern.

**Error codes, metrics.** Identical to v1.

**In-session acceptance criteria.**
1. Round-trip create/read/list/update/delete with valid `If-Match`; invalid `If-Match` → 409.
2. Concurrent `PUT` with same `If-Match` → one 2xx, one 409 (Vitest with two parallel requests).
3. Soft-delete excludes from list; read returns 404.
4. `Idempotency-Key` replay within 24h returns original response.
5. Compass folder deletion blocked while connection exists (integration test against existing `compassService`).
6. CI runs `npm run generate:openapi:connectivity` and confirms emitted YAML is committed and `openapi-typescript` produces a TS client that compiles.

**Deferred.** None — B1 has no infra-blocked criteria.

**Complexity.** L.

---

### B2 — Credential vault with pluggable KMS adapter

**Goal.** Envelope encryption of connection credentials at rest. DEK wrapped by a tenant-scoped KEK in a KMS abstracted behind `KmsAdapter`. `LocalAesGcmAdapter` is the default for in-session and CI; production deployments select Vault/AWS/GCP.

**Dependencies.** B1.

**Files to create.**
- `src/services/connectivity/credentials/vault.ts` — `VaultClient` orchestrating `KmsAdapter`.
- `src/services/connectivity/credentials/aesgcm.ts` — AES-256-GCM primitive using `node:crypto`.
- `src/services/connectivity/credentials/store.repo.ts` — `credentials` repo.
- `src/services/connectivity/credentials/audit.repo.ts` — `credentials_audit` repo.
- `src/services/connectivity/handlers/secrets.handler.ts` — secrets routes.
- `src/lib/kms/index.ts` — `KmsAdapter` interface.
- `src/lib/kms/adapters/local-aesgcm.ts` — env-var KEK; the default.
- `src/lib/kms/adapters/vault-transit.ts` — HashiCorp Vault Transit; stub but tested against a vault Testcontainer if available, otherwise `xit` with `DEFERRED.md` entry.
- `src/lib/kms/adapters/aws-kms.ts` — AWS KMS via `@aws-sdk/client-kms`; stub-and-deferred similarly.
- `src/lib/kms/adapters/gcp-kms.ts` — GCP KMS; stub-and-deferred similarly.
- `src/db/migrations/<timestamp>_connectivity_credentials.sql`.

**KEK selection.** `TELLUS_KMS_ADAPTER` env var: `local-aesgcm` | `vault-transit` | `aws-kms` | `gcp-kms`. `LocalAesGcmAdapter` reads a base64 32-byte KEK from `TELLUS_LOCAL_KEK_B64` (rotated per tenant via a tenant-keyed table). Tests use a deterministic dev KEK.

**Schema, wire format, endpoints, unwrap algorithm, error codes, metrics.** Identical to v1.

**Internal unwrap.** Workload JWT verification uses the existing Multipass session issuer extended with a `connectivity:credential-unwrap` scope and a `connection_rid` claim. If the issuer does not yet emit workload JWTs, B2 extends `src/services/multipass/tokens.ts` to do so — this is in-scope and not a blocker.

**In-session acceptance criteria.**
1. Plaintext never written to logs or persisted files (regression test scans Vitest log output and the audit table for known plaintext).
2. Rotation bumps `version`, requires `If-Match`, invalidates in-process cache.
3. Audit row written on every unwrap.
4. Tampered ciphertext fails GCM tag verification → `CredentialDecryptionFailed`.
5. KMS adapter swap (local → vault) requires no schema change (compile-only test; functional vault test in deferred).

**Deferred.**
- Real Vault Transit / AWS KMS / GCP KMS functional tests. `DEFERRED.md` names each.

**Complexity.** M.

---

### B3 — PostgreSQL adapter, connection test, schema discovery (Node-native)

**Goal.** Implement the PostgreSQL connector entirely in Node using `pg` driver 8.x. Connection-string assembly, TLS validation, live `testConnection`, schema/table/column discovery. The Java JDBC sidecar from v1 is eliminated.

**Dependencies.** B1, B2.

**Files to create.**
- `src/services/connectivity/connectors/postgresql/config.ts` — Zod schema for PG config (identical to v1).
- `src/services/connectivity/connectors/postgresql/pool.ts` — `pg.Pool` factory keyed by connection RID with TLS material from credential vault.
- `src/services/connectivity/connectors/postgresql/discovery.ts` — `discoverCatalog/Schemas/Tables/Columns/PrimaryKeys/ImportedKeys` via `information_schema` and `pg_catalog` queries.
- `src/services/connectivity/connectors/postgresql/type-mapping.ts` — PG OID → Tellus dataset type table (identical mapping to v1).
- `src/services/connectivity/connectors/postgresql/pg-types-config.ts` — installs `pg-types` parsers for `bytea`, `numeric`, `interval`, `tstzrange` to preserve Foundry-parity behavior.
- `src/services/connectivity/handlers/test.handler.ts`.
- `src/services/connectivity/handlers/discovery.handler.ts`.

**Connection string assembly.** Built server-side from typed config; never accepted as a raw URL. `pg.Pool` opts:
```ts
{
  host, port, database,
  user, password,
  ssl: tlsMode === 'disable' ? false : {
    ca: serverCaPem,
    cert: clientCertPem,
    key: clientKeyPem,
    rejectUnauthorized: tlsMode === 'verify-full' || tlsMode === 'verify-ca',
    checkServerIdentity: tlsMode === 'verify-full' ? undefined : () => undefined,
  },
  application_name: applicationName,
  connectionTimeoutMillis: connectTimeoutMs,
  statement_timeout: socketTimeoutMs,
  idle_in_transaction_session_timeout: socketTimeoutMs,
  query_timeout: socketTimeoutMs,
  max: 4,
}
```

**Discovery queries.** Use `information_schema.tables`, `information_schema.columns`, `information_schema.key_column_usage` for PKs, `information_schema.referential_constraints` joined with `key_column_usage` for FKs. Deterministic ordering `schema_name, table_name, ordinal_position`. Pagination by `(schema_name, table_name)` keyset, page size 200.

**Type mapping.** Identical to v1's table; implemented via OID switch in `pg-types` parser registration. `bytea` → Buffer → base64 string in API output; `numeric` precision capped at 38; `INTERVAL` → ISO-8601 string.

**Endpoints, error codes, metrics.** Identical to v1, with metric prefix `tellus_magritte_*` preserved for Foundry-parity in dashboards.

**In-session acceptance criteria.**
1. `testConnection` against Testcontainers `postgres:16` returns `ok:true` and server version in <2s.
2. Wrong password → 401 `JdbcAuthFailed`; no plaintext in response or logs.
3. `verify-full` rejects self-signed (Testcontainers with custom CA setup); `verify-ca` accepts when CA provided.
4. Discovery on a 1000-table fixture paginates deterministically (scaled from v1's 10K).
5. `getImportedKeys` round-trips and feeds B10's FK suggestions.
6. Type mapper handles every entry in the table plus arrays of all scalars (fuzz test with `fast-check`).

**Deferred.**
- 10K-table discovery fixture (in-session uses 1K). `DEFERRED.md` notes the v1 criterion and the scaled test.

**Complexity.** L.

---

### B4 — Worker runtime: BullMQ + child_process isolation + egress allowlist

**Goal.** Run sync jobs as queued BullMQ jobs that fork into a sandboxed `node:child_process`. Inject short-lived workload JWTs. Enforce egress via in-process allowlist. Pluggable `WorkerRuntimeAdapter` keeps K8s as a prod-swap path.

**Dependencies.** B1, B2, B3.

**Files to create.**
- `src/services/orchestration/runners/runtime-adapter.ts` — `WorkerRuntimeAdapter` interface.
- `src/services/orchestration/runners/bullmq-runtime.ts` — default adapter; BullMQ queue + processor.
- `src/services/orchestration/runners/k8s-runtime.ts` — K8s Job adapter using `@kubernetes/client-node` (deferred functional tests).
- `src/services/orchestration/runners/child-process-sandbox.ts` — forks `dist/worker-entrypoint.js` with env, resource limits via `--max-old-space-size`, working dir set to a per-job `tmp` directory cleaned on exit, stdio captured.
- `src/services/orchestration/runners/egress-allowlist.ts` — `net.Socket` patch that intercepts `connect` and rejects denied hosts/ports.
- `src/services/orchestration/queue/build-queue.ts` — per-tenant FIFO with weighted fair scheduling, backed by BullMQ priorities.
- `src/services/orchestration/queue/single-active-build.ts` — Redis-based lock enforcing one in-flight build per `(importRid)`.
- `src/workers/foundry-worker/entrypoint.ts` — worker entry; runs the import logic from B5/B7.
- `src/workers/foundry-worker/credential-fetch.ts` — calls B2 internal unwrap with workload JWT.
- `src/db/migrations/<timestamp>_orchestration_builds.sql` — builds table (status, events, terminal state).

**Worker entrypoint algorithm.** Identical sequence to v1 (fetch creds → resolve egress → stream rows → write Iceberg → emit events). The only delta is the runtime: instead of a K8s Pod, this is `child_process.fork()` with:
- `process.env` containing only whitelisted vars + workload JWT.
- `process.chdir` to a per-job temp dir.
- `process.setuid` to a low-privilege UID if running as root in CI (skipped on macOS dev).
- `resource.setrlimit` on Linux to cap memory and CPU time.
- Crash → BullMQ marks failed → terminal event emitted → exit captured.

**Egress enforcement.** The `egress-allowlist` module monkeypatches `net.Socket.prototype.connect` for the worker process only. On connect, resolves host via `dns.lookup`, checks against the connection's egress policy CIDR/host:port allowlist, throws `EgressDenied` if not matched. This is best-effort defense-in-depth; the production K8s adapter additionally uses Cilium NetworkPolicies (deferred).

**Foundry-parity worker types.**
- `foundryWorker` → BullMQ child_process; direct egress through allowlist.
- `agentProxy` → child_process; egress dialed through agent tunnel from B6.
- `agentWorker` → rejected at creation as in v1 (legacy path; not supported).

**Endpoints (orchestration-side, internal).**
```
POST /api/v2/orchestration/builds                          (internal; enqueue)
GET  /api/v2/orchestration/builds/{buildRid}
GET  /api/v2/orchestration/builds/{buildRid}/events        (SSE)
POST /api/v2/orchestration/builds/{buildRid}/events        (internal; worker writes)
POST /api/v2/orchestration/builds/{buildRid}/cancel
```

**Error codes, metrics.** Identical to v1; metric names preserved (`tellus_magritte_worker_*`).

**In-session acceptance criteria.**
1. A 100K-row import (scaled from v1's 1M) from a Testcontainers PG completes in <12s on a 4-core dev box.
2. Killed worker process produces `IMPORT_FAILED` terminal event within 5s.
3. Worker cannot connect to a denied host (in-process allowlist denies it; integration test attempts `net.connect` to a blocked address).
4. Workload JWT scope is verified strictly bound to the connection RID (negative test).
5. Two simultaneous `execute` calls on the same import RID coalesce to one BullMQ job (Redis lock test).

**Deferred.**
- 1M rows in <90s on a real 4-CPU K8s worker. `DEFERRED.md` names: needs K8s cluster + tuned node pool.
- Cilium NetworkPolicy enforcement. `DEFERRED.md` names: needs Cilium-enabled cluster.

**Complexity.** XL.

---

### B5 — TableImport entity + snapshot/append + Iceberg writes (local FS catalog)

**Goal.** TableImport resource with snapshot and incremental (append) execution. Watermarks. Iceberg writes via `iceberg-js` to a local FS catalog by default; `CatalogAdapter` pluggable for REST/Glue/Snowflake.

**Dependencies.** B1, B3, B4.

**Files to create.**
- `src/services/connectivity/imports/contracts.ts` — Zod schemas for `JdbcImportConfig`, `TableImport`.
- `src/services/connectivity/imports/handlers.ts` — CRUD + execute routes.
- `src/services/connectivity/imports/watermarks.repo.ts`.
- `src/services/connectivity/imports/sql-renderer.ts` — safe SQL templating using `libpg-query-node` for parse-validation + bind-parameter rendering for `:last_watermark`.
- `src/workers/foundry-worker/strategies/snapshot.ts`.
- `src/workers/foundry-worker/strategies/append.ts`.
- `src/lib/iceberg/index.ts` — `CatalogAdapter` interface.
- `src/lib/iceberg/adapters/local-fs.ts` — default; writes Parquet via `parquetjs-lite` or `@dsnp/parquetjs` to `${TELLUS_ICEBERG_ROOT}/<warehouse>/<table>`; maintains `metadata.json` per Iceberg spec v2.
- `src/lib/iceberg/adapters/rest.ts` — Iceberg REST catalog; stub-and-deferred functional tests.
- `src/lib/iceberg/transaction.ts` — `replacePartitions`, `appendFiles`, atomic commit via `metadata.json` rename.
- `src/db/migrations/<timestamp>_table_imports.sql`.
- `src/db/migrations/<timestamp>_table_import_watermarks.sql`.

**SQL safety.** `libpg-query-node` parses the user query; the AST is walked to reject any node of type `INSERT/UPDATE/DELETE/COPY/TRUNCATE/DROP/CREATE/ALTER/GRANT/REVOKE/CALL/DO`. `:last_watermark` is bound through `pg`'s parameterized query API; never string-substituted.

**Snapshot strategy.** Stream `SELECT` results via `pg-query-stream` 4 → Arrow record batches (`apache-arrow`) → Parquet 128MiB files (zstd-3) → Iceberg `replacePartitions` commit tagged with `tellus.build-rid`. On commit, write lineage edges via existing `src/services/lineage/lineageService.ts`.

**Append strategy.** Read watermark → render query with bind param → stream → `appendFiles` commit → update watermark to `MAX(incrementalColumn)` observed in the stream. Strict `>` semantics. Zero rows ⇒ watermark unchanged.

**Schema evolution.** Identical to v1.

**Type quirks.** Identical to v1 (`TIME` → string, `NUMERIC>38` → `decimal(38, scale)` with WARN, `INTERVAL` → ISO-8601).

**Endpoints, error codes, metrics.** Identical to v1.

**In-session acceptance criteria.**
1. Snapshot of a 50-table mixed-type fixture (scaled from v1's 100) yields Iceberg snapshots; reading them back via `iceberg-js` + DuckDB (`SELECT * FROM iceberg_scan('/path/metadata.json')`) returns byte-exact values.
2. Append run with timestamptz watermark over 10 cycles produces no duplicates and no gaps.
3. Killed worker mid-write rolls the transaction back (no `metadata.json` rename → no visible snapshot).
4. `allow_schema_changes=false` on added column → `SchemaEvolutionUnsafe`; no commit.
5. `execute` is idempotent under `Idempotency-Key`.
6. Manual watermark reset gated on `connectivity:write`; audit row written.

**Deferred.**
- 100-table fixture (v1 acceptance) — in-session uses 50.
- Iceberg REST catalog functional tests.

**Complexity.** XL.

---

### B6 — Tellus Agent (Node) + WebSocket reverse tunnel + agent-proxy worker path

**Goal.** Node agent that customers install on-prem; dials `tellus-magritte-coordinator` over WSS; proxies TCP from workers to the customer's PG. Compute stays in Tellus.

**Dependencies.** B1, B2, B4.

**Files to create.**
- `src/services/magritte-coordinator/index.ts` — coordinator module.
- `src/services/magritte-coordinator/ws-server.ts` — `ws` 8.x server; subprotocol identical to v1.
- `src/services/magritte-coordinator/tunnel-listener.ts` — per-tunnel local TCP listener that bridges into a WSS-wrapped agent connection.
- `src/services/magritte-coordinator/agents.repo.ts`.
- `src/services/magritte-coordinator/handlers.ts` — agent CRUD routes.
- `agent/package.json` — separate package in monorepo root: `tellus-agent`.
- `agent/src/bootvisor.ts` — supervisor (existing v1 design preserved).
- `agent/src/tunnel/ws-client.ts` — reconnecting WSS client.
- `agent/src/proxy/tcp-bridge.ts` — multiplexed forwarder.
- `agent/src/allowlist.ts` — reads `/etc/tellus/agent/allowlist.yml`; refuses to start if ownership/mode incorrect on POSIX.
- `agent/scripts/build-binary.ts` — `pkg` 5.x to produce single-binary distribution.
- `agent/conf/agent.yml.example`.
- `agent/conf/allowlist.yml.example`.
- `agent/install/tellus-agent.service` — systemd unit.
- `agent/install/install.sh` — one-line installer that fetches the binary and writes systemd unit.

**Coordinator protocol.** Frame types and payloads identical to v1 (HELLO, HEARTBEAT, OPEN_TUNNEL_REQUEST, etc.).

**Allowlist enforcement.** Identical to v1; agent rejects targets outside the allowlist file at tunnel-open.

**HA pair.** Coordinator load-balances via power-of-two-choices on `openTunnels` across same-group agents.

**Worker path for `agentProxy`.** B4's child_process worker, when its connection's `worker_type=agentProxy`, calls coordinator's internal `tunnels/open`, receives a `tcp://localhost:NNNN` endpoint, and dials the PG host through that endpoint. Frames travel coordinator ↔ agent over WSS.

**Endpoints, error codes, metrics.** Identical to v1.

**In-session acceptance criteria.**
1. Agent binary builds via `pkg` on Linux x64 and starts against a local coordinator in <5s.
2. Coordinator-side: killed agent WS connection re-establishes within 30s under exponential backoff (10s, 20s, 30s cap for in-session — original 300s cap preserved for prod).
3. Disallowed host in allowlist → `AgentAllowlistDenied` at tunnel-open; no TCP socket opened to target.
4. Two agents same group: chaos kill one, traffic shifts within 10s (Vitest with in-process coordinator + two in-process agents).
5. End-to-end: a B5 snapshot import using `worker_type=agentProxy` against a Testcontainers PG reached only via the agent succeeds.

**Deferred.**
- VM install on Ubuntu 22.04 + RHEL 9 (in-session tests run on the dev box's OS; `DEFERRED.md` notes the VM matrix).
- Cosign-signed updater (in-session uses unsigned binaries; signing infrastructure deferred).
- 60s graceful drain on update (in-session tests a faster 5s drain).

**Complexity.** XL.

---

### B7 — CDC via `pg-logical-replication` + replication slot lifecycle

**Goal.** `STREAMING_CHANGELOG` import mode using Node's `pg-logical-replication` to consume `pgoutput`. Manage slot + publication lifecycle. Emit canonical changelog into Kafka (Redpanda in-session). Debezium is eliminated.

**Dependencies.** B1, B2, B3, B4, B5.

**Files to create.**
- `src/services/connectivity/cdc/contracts.ts` — Zod for `PostgresCdcConfig`.
- `src/services/connectivity/cdc/preflight.ts` — checks `wal_level`, `max_replication_slots`, `max_wal_senders`, REPLICATION role, CREATE on database.
- `src/services/connectivity/cdc/slot-manager.ts` — create/attach/teardown/monitor for slot + publication.
- `src/services/connectivity/cdc/changelog-writer.ts` — Kafka producer wrapper.
- `src/workers/cdc-worker/entrypoint.ts` — long-running worker consuming `pgoutput`.
- `src/workers/cdc-worker/pgoutput-decoder.ts` — wraps `pg-logical-replication`'s `PgoutputPlugin`.
- `src/workers/cdc-worker/canonical-format.ts` — emits the v1 changelog JSON byte-for-byte.
- `src/lib/kafka/index.ts` — `KafkaAdapter` interface.
- `src/lib/kafka/adapters/kafkajs.ts` — default; `kafkajs` 2.2 against Redpanda.
- `src/services/funnel/streams/changelog-format.ts` — shared schema for B9.

**Preflight checks.** Implemented as a single `POST /api/v2/connectivity/connections/{rid}/cdc/preflight` route that executes the SQL probes from v1 (`SHOW wal_level`, `pg_replication_slots`, role attributes) and returns a per-check pass/fail map with the exact fix SQL for failing checks.

**Defaults (Foundry-parity).** Match v1's Debezium defaults — `snapshot.mode=never`, `decimal.handling.mode=string`, `time.precision.mode=connect`, `tombstones.on.delete=false`, `publication.autocreate.mode=disabled`, `provide.transaction.metadata=true` — implemented as Node behavior:
- Decimals decoded as strings via `pg-types` parser.
- Times decoded as millisecond strings.
- Deletes emit explicit `op='d'` messages with `before` populated (requires `REPLICA IDENTITY FULL` on the table; preflight surfaces a warning if not set).
- BEGIN/END markers preserved via `pg-logical-replication`'s `xLogData` plus transaction-boundary callbacks.

**Whitelisted overrides.** Same key set as v1.

**Changelog topic format.** Topic `tellus.cdc.<importShort>`, 12 partitions by default, PK-hash partitioned. Message format identical to v1.

**Stream dataset projection.** Kafka topic → Iceberg streaming sink (`appendFiles` on `changes_v1` table partitioned by `tsMs` day) implemented as a Node consumer that batches 1000 messages or 1s, writes a Parquet file, commits via `CatalogAdapter`. Funnel (B9) consumes either Kafka directly or the Iceberg stream view.

**Failure modes.** Identical to v1 (WAL purged → 410; slot conflict → 409; DDL with `allow_schema_changes=false` → halt with `SchemaEvolutionUnsafe`).

**Endpoints, error codes, metrics.** Identical to v1.

**In-session acceptance criteria.**
1. Creating a CDC import on a `wal_level=logical` Testcontainers PG provisions slot + publication and starts emitting events within 10s.
2. 300 INSERT / 300 UPDATE / 300 DELETE (scaled from v1's 1000×3) produce 900 events with correct `op` and PK in <2s end-to-end.
3. Pause runner 60s and resume; consumes accumulated WAL without loss.
4. ALTER TABLE ADD COLUMN with `allow_schema_changes=true` propagates the new column to the stream view within 30s.
5. Force-deleting import drops slot + publication; verified by `pg_replication_slots` query.
6. Lag metric rises when consumer paused, decays on resume.

**Deferred.**
- 3000 events in <5s under 1Gbps network (in-session 900 events in <2s on loopback).
- Alert rule firing in real Prometheus + Alertmanager (in-session checks metric values directly).

**Complexity.** XL.

---

### B8 — Virtual Tables: PG federation via Node SQL builder + Arrow IPC + Tellus catalog REST

**Goal.** Register a PG table as a Tellus Virtual Table. Federated reads push predicates to PG via a Node SQL builder, stream results as Arrow IPC. Tellus REST catalog facade serves virtual tables to Iceberg-aware engines via a thin Tellus connector. Calcite + Arrow Flight SQL eliminated; both kept as pluggable `FederationEngineAdapter` for prod swap.

**Dependencies.** B1, B3.

**Files to create.**
- `src/services/connectivity/virtual-tables/contracts.ts`.
- `src/services/connectivity/virtual-tables/handlers.ts` — CRUD + `refreshSchema`.
- `src/services/query-federation/index.ts` — federation module.
- `src/services/query-federation/engine-adapter.ts` — `FederationEngineAdapter` interface.
- `src/services/query-federation/adapters/node-sql-builder.ts` — default; uses `kysely` 0.27 to compose pushdown-safe queries; executes via `pg`; streams ResultSet through `apache-arrow` `RecordBatchWriter` over HTTP chunked transfer.
- `src/services/query-federation/adapters/calcite-flight.ts` — stub for prod swap; deferred functional tests.
- `src/services/query-federation/pushdown/rules.ts` — predicate analyzer + projection/aggregate/limit/sort pushdown.
- `src/services/query-federation/handlers.ts` — `POST /api/v2/federation/query` accepting a typed query plan + returning Arrow IPC stream.
- `src/services/query-federation/handlers/explain.ts` — `POST /api/v2/federation/explain` returning logical-vs-pushdown plan tree.
- `src/services/iceberg-catalog/index.ts` — Tellus REST catalog facade (Iceberg REST 1.x-compatible namespaces + table metadata routes; reads to virtual tables proxy to federation).
- `src/db/migrations/<timestamp>_virtual_tables.sql`.

**Pushdown.** Predicate analyzer walks the typed query (Tellus's existing typed-query AST from prior Quiver work) and pushes:
- Filter operators whose functions are in the safe-deterministic whitelist (`=, <, >, IN, BETWEEN, IS NULL, AND, OR, NOT, LIKE, ILIKE`; PG-specific `~` only when the source is PG).
- Project, Aggregate (`COUNT/SUM/MIN/MAX/AVG`), Limit, Sort.
- Join only when both sides are the same connection RID; otherwise local.

**Arrow IPC stream.** `apache-arrow`'s `RecordBatchStreamWriter` writes record batches to the HTTP response as `application/vnd.apache.arrow.stream`. Spark and Trino consume via Tellus connector that reads the IPC stream and exposes as `org.apache.iceberg.Table` (Spark connector deferred to prod-swap; in-session tests use `apache-arrow` JS reader and `pyarrow` reader).

**Permission propagation.** Caller's Multipass token exchanged for workload JWT scoped to the connection RID. Federation unwraps credentials only at execution time. In-cluster mTLS deferred (in-session uses HTTP between modules; the same monolith process serves both, so no transport-layer issue).

**Iceberg catalog facade.** Serves at `/api/v2/iceberg/v1/` per Iceberg REST 1.x; virtual tables surface in namespace `tellus.virtual.<connectionShort>`. Reads route to federation. Writes 405.

**Endpoints, error codes, metrics.** Identical to v1.

**In-session acceptance criteria.**
1. Register a 50-column PG table → virtual table created. `SELECT * FROM tellus.virtual.X.tbl WHERE id = 42` via federation returns the single row with the WHERE pushed (verified by `pg_stat_statements` showing the parameterized query landed in PG).
2. `SELECT COUNT(*)` pushed down; <100ms for a 1M-row table (scaled from v1's 100M) when indexed.
3. JOIN across two PG sources executes locally; pushdown ratio metric <1.0 with annotation of which parts ran locally.
4. `refreshSchema` detects added column; type change requires confirmation → 409.
5. Write attempt → 405.
6. 20 concurrent Arrow IPC streams (scaled from v1's 50) complete without OOM at 2 GiB Node heap.

**Deferred.**
- 100M-row table count <100ms (in-session 1M-row).
- 50 concurrent streams at 4 GiB pod (in-session 20 streams at 2 GiB).
- Spark Iceberg connector consumption of the REST catalog (in-session validates via `pyarrow` + raw HTTP).

**Complexity.** XL.

---

### B9 — Funnel indexing: PG dataset → Object Type (Node consumer + in-process Postgres-backed object DB)

**Goal.** Index PG-derived datasets into the Tellus object database for OSS reads. Mirror Foundry Funnel's three-stage pipeline (changelog → merge → index) but implement as Node BullMQ jobs + a Node Kafka consumer. Flink eliminated.

**Dependencies.** B5, B7, existing `src/services/ontology/`, existing `src/services/oss/`.

**Files to create.**
- `src/services/funnel/index.ts`.
- `src/services/funnel/pipelines/batch/changelog-job.ts` — diffs current Iceberg snapshot vs prior; emits Avro into Kafka topic `tellus.funnel.changelog.<otype>`.
- `src/services/funnel/pipelines/batch/merge-job.ts` — joins changelog + edits topic from `tellus-actions`; writes merged Iceberg table.
- `src/services/funnel/pipelines/batch/index-job.ts` — bulk-loads merged records into the Postgres-backed object DB via `COPY`.
- `src/services/funnel/pipelines/streaming/consumer.ts` — Node consumer of `tellus.cdc.<importShort>` with backpressured batched upserts (1000 rows / 1s) into the object DB; exactly-once via two-phase commit using a Postgres-side processed-offset table.
- `src/services/funnel/pipelines/streaming/checkpoint.repo.ts`.
- `src/services/funnel/scheduler.ts` — emits batch DAG into BullMQ; checkpointed.
- `src/services/funnel/contracts/object-type-binding.ts` — typed binding.
- `src/services/funnel/object-db/schema.ts` — `ot_<otypeShort>_p<shard>` table generator; JSONB props + extracted scalar columns for indexed properties.
- `src/services/funnel/object-db/blue-green.ts` — atomic alias swap for reindex.
- `src/services/funnel/object-db/optional-clickhouse.ts` — adapter; deferred functional tests.
- `src/services/funnel/object-db/optional-opensearch.ts` — adapter; deferred functional tests.
- `src/services/funnel/handlers.ts`.

**Capacity limits.** Identical to v1 (250 props, 1 MiB record, 2 MiB/s/otype streaming, 1B objects via 64-shard PK-hash partitioning).

**Pipelines.** Algorithms preserved from v1; the substitutions are:
- Flink streaming job → Node consumer with `kafkajs` 2.2 and Postgres `COPY` for bulk insert.
- Checkpoint backend → Postgres `funnel_checkpoints` table keyed by `(bindingRid, topicPartition)` with committed offset and last-write-timestamp.
- Exactly-once → write the new offset and the batched upserts in the same Postgres transaction.

**Reindex.** Blue-green: build into `ot_<otype>_v<N+1>`, then atomic `ALTER TABLE … RENAME` swap; read path uses a `view ot_<otype>` aliasing to current version.

**Endpoints, error codes, metrics.** Identical to v1.

**In-session acceptance criteria.**
1. Snapshot dataset of 100K rows (scaled from v1's 1M) indexed into a new Object Type in <60s; OSS read returns count=100K.
2. CDC stream of 200 events/s (scaled from v1's 1000) → updates queryable at p95 ≤5s end-to-end.
3. >250 properties at binding creation → `PropertyCountExceeded`.
4. Reindex blue-green: no read errors during cutover (continuous-load test running OSS reads at 50 qps for the duration of cutover).
5. Action edit before matching CDC event preserved (edits-win semantics by `(orderingColumn, editTs)`).

**Deferred.**
- 1M-row snapshot in <5min (in-session 100K rows in <60s).
- 1B-object 16-shard scale test in <12h on a node pool (`DEFERRED.md` names cluster + fixture).
- ClickHouse and OpenSearch projections functional tests (interface compiled; tests deferred).
- Flink-based streaming adapter (deferred; Node consumer is the in-session default).

**Complexity.** XL.

---

### B10 — Ontology binding API + Link Types from FKs + OSDK regen hook

**Goal.** API used by Ontology Manager to bind PG-derived datasets to Object Types, define Link Types from FK discovery, feed OSDK / Object Explorer / Quiver with the resulting schema.

**Dependencies.** B9; existing `src/services/ontology/`, existing OSDK generator.

**Files to create.**
- `src/services/ontology/bindings/handlers.ts`.
- `src/services/ontology/bindings/suggest.ts` — column→property inference per v1 rules.
- `src/services/ontology/link-types/from-fk.ts`.
- `src/services/ontology/contracts/object-type-with-binding.ts`.
- `src/services/osdk-generator/extensions/from-binding.ts` — hook into existing OSDK generator.
- `src/services/ontology/cache-invalidation.ts` — publishes on `tellus.ontology.changes` (in-process EventEmitter + Redis pub/sub for cross-process).
- `src/db/migrations/<timestamp>_ontology_bindings.sql`.

**Inference rules, Link Type creation, M:M handling.** All identical to v1.

**Object Explorer / Quiver wiring.** Same SLO contract as v1: 1-hop traversal ≤200ms p95 on a 100M / 1B test (deferred); Quiver cache invalidation within 1s of binding creation (in-session).

**Endpoints, error codes, metrics.** Identical to v1.

**In-session acceptance criteria.**
1. Suggestion endpoint on a 50-column dataset returns non-empty `proposedPropertyMap` with ≥1 PK and ≥1 title candidate.
2. Creating a binding triggers a B9 index job within 1s; binding status `READY` once indexing completes.
3. Link Type from discovered FK exposes traversal in OSDK after next regen run (in-session triggers regen synchronously).
4. M:M Link Type built from join-table dataset traverses bidirectionally with correct cardinality.
5. >250 properties at binding → `PropertyCountExceeded` (delegated from B9).
6. PG `int32` → property `int64` succeeds; `int64` → `int32` → `PropertyTypeIncompatible`.

**Deferred.**
- 100M / 1B traversal SLO (`DEFERRED.md` notes scale fixtures + cluster).

**Complexity.** L.

---

## Frontend tasks

All frontend code lives in the existing `tellus-fe` Next.js 14 app at `/Desktop/projects/tellus-fe`. New routes under `app/workspace/data-integration/data-connection/`. Existing design tokens, Blueprint setup, Tailwind config, and React Query providers are reused. Typed API clients regenerated from B1/B5/B6/B7/B8/B9/B10 OpenAPI YAML via `openapi-typescript`.

### F1 — Data Connection app shell + Compass-aware routing + permissions chrome

**Goal.** Bootstrap the Data Connection section as a Compass-integrated workspace within `tellus-fe`. Left-nav, breadcrumb, tenant switcher, permissions chrome, global "create source" CTA.

**Dependencies.** None within `tellus-fe` (assumes existing `tellus-fe/lib/auth.ts`, `tellus-fe/lib/compass.ts`, `tellus-fe/components/design-system/*`).

**Files to create (paths in `tellus-fe`).**
- `app/workspace/data-integration/data-connection/layout.tsx`.
- `app/workspace/data-integration/data-connection/page.tsx` — dashboard.
- `components/data-connection/AppShell/{LeftNav,TopBar,Breadcrumbs,CreateButton}.tsx`.
- `lib/data-connection/scopes.ts` — scope-check helpers.
- `lib/api/connectivity.gen.ts` — generated from `openapi/connectivity.yaml`.
- `styles/data-connection.css` — section-scoped overrides.

**Routes.** Same as v1, rebased under `tellus-fe/app/workspace/data-integration/data-connection/`.

**Permissions chrome, state management.** Identical to v1.

**In-session acceptance criteria.**
1. Left-nav highlights current route; deep-links restore selection.
2. Tenant switch invalidates all `['connectivity', …]` query keys.
3. Compass breadcrumb resolves ancestry; keyboard-navigable.
4. Empty state on dashboard renders ≤100ms cold cache (Vitest + RTL render timing).
5. ESLint, Prettier, TS strict, axe-core all pass.

**Deferred.**
- Real-user-monitoring Lighthouse on deployed env (in-session uses Lighthouse CI against `next start` locally; deferred deploy verification noted).

**Complexity.** M.

---

### F2 — Sources list view + filters + health + bulk ops

**Goal.** Virtualized list of connections in the current Compass folder + subfolders with filters, health surface, bulk actions.

**Dependencies.** F1, B1, B3 (`/status`).

**Files to create.**
- `app/workspace/data-integration/data-connection/sources/page.tsx`.
- `components/data-connection/SourcesList/{SourcesTable,FilterBar,HealthDot,BulkActions}.tsx`.
- `hooks/data-connection/useConnections.ts`.

**Columns, virtualization, filter bar, health, bulk actions, empty/loading/error states.** Identical to v1.

**In-session acceptance criteria.**
1. List renders 1000 connections (scaled from v1's 10K) without jank — scroll FPS ≥55 in headless Chrome perf trace.
2. Filter changes refine client-side.
3. Health polling pauses for off-screen rows (`IntersectionObserver`).
4. Bulk delete reversible during soft-delete window; UI surfaces deadline.
5. Keyboard nav: arrow keys move row focus, Space toggles checkbox, Enter opens source.

**Deferred.**
- 10K-row scroll perf test (in-session uses 1K).

**Complexity.** M.

---

### F3 — PostgreSQL connection creation wizard

**Goal.** Multi-step wizard creating a PG connection.

**Dependencies.** F1, B1, B2, B3.

**Files to create.**
- `app/workspace/data-integration/data-connection/sources/new/page.tsx`.
- `components/data-connection/CreateConnection/{ConnectorPicker,WorkerStep,ConfigStep,CredentialsStep,ReviewStep,Stepper}.tsx`.
- `components/data-connection/CreateConnection/postgres/{ConfigForm,TlsCard,AdvancedJdbc}.tsx`.
- `lib/data-connection/forms/postgres-schema.ts` — Zod mirroring B3.

**Steps, form behavior, mutation, errors.** Identical to v1.

**In-session acceptance criteria.**
1. Happy path completes in ≤90s on 100ms-RTT API simulator.
2. All 12 error codes from B1/B2/B3 surface with field-level mapping where applicable.
3. Stepper "Save & exit" persists draft to `localStorage` under `tellus.draftConnection.<userRid>`.
4. Draft resume restores all fields including uploaded PEMs.
5. Double-submit produces exactly one connection (Idempotency-Key).
6. axe-core score 100; full keyboard navigation.

**Deferred.** None.

**Complexity.** L.

---

### F4 — Connection detail + edit + credential rotation + test + danger zone

**Goal.** Single-screen detail view.

**Dependencies.** F1, B1, B2, B3, B6.

**Files to create.**
- `app/workspace/data-integration/data-connection/sources/[rid]/page.tsx`.
- `components/data-connection/ConnectionDetail/{Overview,ConfigCard,CredentialsCard,SyncsList,VirtualTablesList,ActivityTimeline,DangerZone}.tsx`.

**Sections, drawer-edit flow, credential rotation, danger zone, SSE timeline.** Identical to v1.

**In-session acceptance criteria.**
1. Stale `If-Match` edit surfaces conflict + reload-merge offer.
2. Wrong-password rotation rejected at server (`JdbcAuthFailed`); UI surfaces field error; old credentials remain active.
3. Test-now respects 5s client and 1/min server rate-limits.
4. Activity timeline tails new events within 2s via SSE.
5. Delete with active syncs blocks with `HasActiveDependencies` and dependency list.

**Deferred.** None.

**Complexity.** L.

---

### F5 — Snapshot/Append sync wizard

**Goal.** Wizard for snapshot or incremental sync with Monaco SQL editor.

**Dependencies.** F4, B3, B5.

**Files to create.**
- `app/workspace/data-integration/data-connection/sources/[rid]/syncs/new/page.tsx`.
- `components/data-connection/CreateSync/{ModePicker,TableBrowser,SqlEditor,DatasetTarget,WatermarkCard,ScheduleCard,Review}.tsx`.
- `lib/data-connection/sql/postgres-completion.ts` — Monaco completion provider.

**Steps, SQL editor, completion, preview pane.** Identical to v1. The "preview first 100 rows" route maps to `POST /api/v2/connectivity/connections/{rid}/preview` (a thin B3 wrapper with forced `LIMIT 100`).

**In-session acceptance criteria.**
1. Browse-tables: select `public.users`, click Create → snapshot import ready in <30s; preview populated.
2. Custom SQL: invalid `DROP TABLE` shows red lint marker; Create disabled.
3. Append requires watermark; Create disabled until set.
4. Cron `*/5 * * * *` validates, shows next-5-runs in user TZ.
5. Editor handles 2000-line query without input lag (≤16ms/keystroke).

**Deferred.** None.

**Complexity.** L.

---

### F6 — CDC wizard with replication-slot pre-flight

**Goal.** CDC sync wizard with preflight inspector.

**Dependencies.** F4, B3, B7.

**Files to create.**
- `app/workspace/data-integration/data-connection/sources/[rid]/cdc/new/page.tsx`.
- `components/data-connection/CreateCdc/{PreflightCard,TableSelector,SlotConfigCard,AdvancedCdcCard,Review}.tsx`.

**Steps.** Identical to v1; "AdvancedDebeziumCard" renamed to "AdvancedCdcCard" since Debezium is no longer the engine — the whitelisted override keys are preserved verbatim for Foundry-parity in operator muscle memory.

**In-session acceptance criteria.**
1. Preflight on unconfigured Testcontainers PG shows specific failing rows with correct fix SQL; configured PG → all green in <2s.
2. Table without PK shows non-blocking warning + `REPLICA IDENTITY FULL` hint.
3. Forbidden override key → inline error; Create rejected.
4. Slot conflict → `ReplicationSlotConflict` surfaced with "Choose different name" remedy.
5. E2E: preflight green → create → first event in lag chart within 30s.

**Deferred.** None.

**Complexity.** L.

---

### F7 — Sync detail: run history, lineage, live build, error triage

**Goal.** Per-sync detail page.

**Dependencies.** F4, B5, B7, B9.

**Files to create.**
- `app/workspace/data-integration/data-connection/sources/[rid]/syncs/[importRid]/page.tsx`.
- `components/data-connection/SyncDetail/{OverviewCard,RunHistoryTable,RunDetailDrawer,LineageGraph,LagChart,ErrorTriagePanel,ManualActions}.tsx`.

**Sections, lineage, live build SSE, lag chart, error triage, manual actions.** Identical to v1.

**In-session acceptance criteria.**
1. Build stage chips update within 2s via SSE.
2. Lineage graph with 10 downstream Object Types renders in <500ms (`react-flow` 11).
3. Lag chart shows 24h with 1h zoom.
4. "Run now" → new build RID at top of table within 5s.
5. Error triage offers correct deep-links for 12 most common error codes.
6. Cancelled run shows "Cancelled" within 15s.

**Deferred.** None.

**Complexity.** XL.

---

### F8 — Agents management UI

**Goal.** Install wizard + agents list + allowlist editor + version upgrade dispatcher + tunnel monitor.

**Dependencies.** F1, B6.

**Files to create.**
- `app/workspace/data-integration/data-connection/agents/page.tsx`.
- `app/workspace/data-integration/data-connection/agents/[rid]/page.tsx`.
- `components/data-connection/Agents/{AgentsTable,InstallWizard,AllowlistEditor,UpgradeDispatcher,TunnelMonitor}.tsx`.

**Install wizard.** OS-specific commands now reference `tellus-agent` binary built by B6's `pkg` step (not Foundry-equivalent install). Commands:
```
Ubuntu / RHEL:  curl -sSf https://download.tellus.io/agent/install.sh \
                  | TELLUS_ENROLLMENT_TOKEN=… sh
```
systemd unit dump rendered inline.

**Allowlist editor, upgrade dispatcher, tunnel monitor.** Identical to v1.

**In-session acceptance criteria.**
1. Install wizard token-mint → first heartbeat reproducible in <2min using in-process coordinator + locally-built agent binary (scaled from v1's 5min on a fresh VM).
2. Allowlist edit transitions to synced after agent reload (in-process reload signal).
3. Upgrade rollout on HA pair maintains continuous tunnel capability (chaos test with two in-process agents).
4. Heartbeat age column auto-refreshes every 10s.
5. Tunnel monitor handles 200 concurrent tunnels (scaled from v1's 1000) without UI jank.

**Deferred.**
- Fresh-VM install on Ubuntu 22.04 + RHEL 9.
- 1000 concurrent tunnels.

**Complexity.** L.

---

### F9 — Virtual Tables UI

**Goal.** Virtual Table registration, schema browser, preview pane, pushdown inspector.

**Dependencies.** F4, B3, B8.

**Files to create.**
- `app/workspace/data-integration/data-connection/sources/[rid]/virtual-tables/new/page.tsx`.
- `app/workspace/data-integration/data-connection/virtual-tables/[tableRid]/page.tsx`.
- `components/data-connection/VirtualTables/{Registration,SchemaBrowser,PreviewPane,PushdownInspector,RefreshSchemaDialog}.tsx`.

**Form, schema browser, preview pane, pushdown inspector.** Identical to v1; preview pane's Monaco completes against `tellus.virtual.X.tbl`.

**In-session acceptance criteria.**
1. Register 50-column PG table → virtual table created in <5s; appears in F4 source detail.
2. Schema refresh after column add → non-conflict diff; one-click apply.
3. Preview `WHERE pk = 42` runs in <500ms (matches B8 in-session criterion 1); inspector shows "Filter pushed to PG".
4. Preview of non-pushdownable function shows pushdown ratio <1.0 with annotated local-execution parts.
5. Write attempt → 405 "Virtual tables are read-only" empty state.

**Deferred.** None.

**Complexity.** L.

---

### F10 — Ontology Manager integration: bind dataset → Object Type, FK Link Types, live Object Explorer + Quiver preview

**Goal.** From within Ontology Manager (the existing `tellus-fe/app/workspace/ontology-manager/` routes), pick a PG-derived dataset, map columns to properties, accept FK Link Type suggestions, preview live in Object Explorer + Quiver.

**Dependencies.** F1, B9, B10, existing Ontology Manager / Object Explorer / Quiver routes in `tellus-fe`.

**Files to create.**
- `app/workspace/ontology-manager/object-types/[otypeRid]/bindings/page.tsx`.
- `components/ontology-manager/Bindings/{DatasetPicker,PropertyMappingTable,LinkTypeFkPanel,BindingStatusCard,PreviewObjectExplorer,PreviewQuiver}.tsx`.
- `hooks/ontology-manager/{useBindingSuggestion,useBindingMutation,useLinkTypeFromFk}.ts`.

**Sections.** Identical to v1. Object Explorer + Quiver previews are embedded routes within the same `tellus-fe` app (same-origin; postMessage handshake unnecessary but kept for forward-compat if either app moves to a sub-domain).

**In-session acceptance criteria.**
1. Suggestion on 50-column dataset returns sensible PK + title within 2s.
2. Mapping table edited + submitted in ≤3min for 50-column dataset (UX test recorded).
3. Accepting FK suggestion creates Link Type and updates OSDK preview without page reload (in-session synchronous regen).
4. Object Explorer preview shows live rows within 30s of binding READY for 100K-row dataset (scaled from v1's 1M).
5. Quiver preview accepts drag-and-drop of new Object Type into a new card with no errors.
6. Type-incompatible mapping blocked at UI level pre-submit.
7. E2E: pick dataset → object visible in Quiver in ≤5 minutes.

**Deferred.**
- 1M-row preview within 30s (in-session 100K).

**Complexity.** XL.

---

## Task dependency graph (unchanged from v1)

```
B1 ──┬──> B2 ──┬──> B3 ──┬──> B4 ──┬──> B5 ──┬──> B7 ──> B9 ──> B10
     │         │         │         │         │
     │         │         │         └──> B6 ──┘
     │         │         │
     │         │         └──> B8
     │         │
     │         └──> (rotation surface in F4)
     │
     └──> F1 ──┬──> F2 ──┬──> F3 ──> F4
              │         │
              │         └──> F5 ──> F7
              │         └──> F6 ──> F7
              │         └──> F8
              │         └──> F9
              │
              └──> F10
```

---

## Cross-task definition of done (v2)

For every task above, closure requires:

1. OpenAPI YAML (backend) or generated client (frontend) checked in; CI lint passes; `openapi-typescript` produces a compiling TS client.
2. Unit test coverage ≥80% branches on new code (Vitest for TS).
3. Integration tests using Testcontainers (PG 16, Redpanda v23, Redis 7, local Iceberg FS catalog) green in CI.
4. Playwright tests for frontend tasks: ≥1 happy path + ≥2 error paths per UI flow against `next start` + Testcontainers-backed monolith.
5. In-session SLO acceptance criteria all met; production-scale criteria documented in per-task `DEFERRED.md` with the verbatim original criterion, the infrastructure needed, and the scaled-down in-session test that did run.
6. Threat model + security review for B2, B4, B6, B8 (touch credentials or external surface).
7. User-facing docs in `docs/user/data-connection/` updated for each new UI flow.
8. Grafana dashboard JSON + Prometheus alert rules under `dashboards/` and `alerts/` for every `tellus_*` metric introduced.
9. Error codes registered in `src/lib/errors/registry.ts`.
10. Lighthouse CI score ≥90 on every new frontend route against `next start`.

---

## Deviations from v1 (consolidated for `DEVIATIONS.md`)

| v1 element | v2 substitute | Rationale |
|---|---|---|
| Polyrepo `services/*` layout | `src/services/*` modules in `tellus` monolith | Match existing repo |
| `apps/*` frontend workspace | `tellus-fe/app/*` routes | Match existing repo |
| Java JDBC sidecar | `pg` driver 8 in Node | Eliminate JVM dependency; preserve type fidelity via `pg-types` |
| Debezium 3.4.0.Final | `pg-logical-replication` in Node | Eliminate JVM dependency; canonical changelog format preserved |
| Kubernetes Jobs | BullMQ + `child_process` (default); K8s adapter pluggable | Ship without K8s hard requirement |
| Cilium NetworkPolicies | In-process `net.Socket` allowlist (default); Cilium pluggable | Defense-in-depth without Cilium hard requirement |
| AWS / GCP / Vault KMS hard requirement | `LocalAesGcmAdapter` default; cloud-KMS pluggable | Run in-session; production swap via env |
| Apache Iceberg REST catalog (external) | Local FS catalog via `iceberg-js` (default); REST adapter pluggable | Run in-session |
| Apache Flink 1.19 streaming indexer | Node consumer with Postgres `COPY` + offset-table 2PC | Eliminate JVM dependency; same exactly-once semantics |
| Apache Calcite + Arrow Flight SQL | Node SQL builder (`kysely`) + Arrow IPC over HTTP | Eliminate JVM dependency; pushdown rules preserved |
| Arrow Flight SQL server | HTTP chunked Arrow IPC stream | Same payload format; simpler transport |
| Tellus Iceberg REST catalog facade for Spark/Trino consumption | Same REST routes; in-session validated via `pyarrow` | Spark connector deferred to prod-swap |

---

## What changes for the agent prompt

The companion implementation prompt (`tellus-postgresql-connectivity-agent-prompt.md`) §3.2 "No scope renegotiation" now reads against **this v2 spec**, not v1. The deviations table above is pre-authorized; the agent does not need to negotiate them per-task. Any deviation beyond this table still requires a `DEVIATIONS.md` entry per §7 of the prompt.

§10 "Definition of done" now reads against the v2 acceptance criteria — in-session criteria are binding for closure; deferred criteria are binding for `DEFERRED.md` presence and accuracy, not for closure.