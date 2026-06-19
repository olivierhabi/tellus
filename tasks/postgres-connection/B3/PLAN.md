# B3 PLAN — PostgreSQL adapter, connection test, schema discovery (Node-native)

≤200 words per agent prompt §5.2.

**File order.**
1. `src/services/connectivity/connectors/postgresql/config.ts` — Zod for PG-specific config (reuses `PostgresConfig` from contracts.ts).
2. `src/services/connectivity/connectors/postgresql/pg-types-config.ts` — pg-types parser registration for `bytea` (→ base64), `numeric` (string preservation), `interval` (ISO-8601), `tstzrange` (string).
3. `src/services/connectivity/connectors/postgresql/pool.ts` — `pg.Pool` factory keyed by connection RID; pulls credential via B2 `vault.unwrap` (or workload-JWT call to internal unwrap from worker context); applies tls/timeouts.
4. `src/services/connectivity/connectors/postgresql/type-mapping.ts` — PG OID → Tellus dataset type lookup (same table as v1).
5. `src/services/connectivity/connectors/postgresql/discovery.ts` — `discoverCatalog/Schemas/Tables/Columns/PrimaryKeys/ImportedKeys` against `information_schema` + `pg_catalog`, deterministic ordering, keyset pagination.
6. `src/services/connectivity/handlers/test.handler.ts` — `POST /connections/:rid/test` → 200 `{ ok, serverVersion }` or `Jdbc*` error.
7. `src/services/connectivity/handlers/discovery.handler.ts` — `GET /connections/:rid/schemas|tables|columns|primary-keys|imported-keys` with `?nextPageToken=`.

**Tests.** Unit: type-mapper exhaustive (every OID); pool factory honours TLS modes. Integration (Testcontainers PG 16 with self-signed CA): `testConnection` round-trip in <2s; `verify-full` rejects unknown CA; discovery on 1000-table fixture paginates; `getImportedKeys` round-trips for B10.

**Library choices.** `pg` (already in deps), `pg-types` (transitive via `pg`), `fast-check` for fuzz on type mapper.

**Deferred.** 10K-table fixture (in-session 1K).
