# DECISIONS — postgres-connection v2

Per agent prompt §3.4. Decisions the spec leaves open; each chosen with the most defensible
default and a one-line rationale, then committed-to.

---

- DECISION: HTTP layer is Express 4 (existing repo stack). See DEVIATIONS D1.
- DECISION: ORM/query builder is Knex 3 (existing repo stack). See DEVIATIONS D2.
- DECISION: OpenAPI emitter is `@asteasolutions/zod-to-openapi` 7.x — spec line 19 names it.
- DECISION: TS client generator is `openapi-typescript` 6.x — spec line 59 names it.
- DECISION: Connectivity migrations use the repo's `NNN_b<n>_<topic>.sql` convention with `.down.sql` peers. See DEVIATIONS D6.
- DECISION: `errors/registry.ts` is a typed module (not YAML) — TypeScript catches drift at compile time; spec §844 says "Error codes registered in `src/lib/errors/registry.ts`" without mandating format.
- DECISION: Error envelope helper exports a single `toEnvelope(err, requestId)` adapter so existing inline patterns (`src/routes/quiver/compute.ts`) can incrementally migrate.
- DECISION: Connection RID format per spec line 23: `ri.magritte..source.<uuid>` (the empty `instance` segment is the Foundry-parity Magritte convention).
- DECISION: Connectivity outbox uses an `outbox_id BIGSERIAL` watermark + a `claimed_at` advisory-lock column for at-least-once delivery to Compass — simplest pattern that gives at-most-once write semantics with idempotent claim.
- DECISION: ETag emitted as weak `W/"<version>"` per spec line 20. Strong ETag rejected because `version` is a coarse logical counter, not a byte-identity hash.
- DECISION: `If-Match` mismatch returns 409 with `errorName: Tellus:Connectivity:ResourceVersionMismatch` per §9 of prompt.
- DECISION: Soft delete is `deleted_at IS NOT NULL` filter on all list/get reads. Delete sets `deleted_at = now()` and bumps `version`.
- DECISION: Compass two-phase commit pattern — write `connectivity_outbox` row in same Knex transaction as `connections` insert; a poller (separate worker added in B1) claims and forwards to `compassService.registerResource`. If `compassService` call fails, row stays claimed for retry (idempotent operation on Compass side).
- DECISION: Concurrent `PUT` test (B1 §76.2) uses `UPDATE … WHERE rid=$1 AND version=$2 RETURNING version` — Postgres-level OCC; row update fails → If-Match conflict → 409.
- DECISION: B1 in-session integration test uses `@testcontainers/postgresql` against `postgres:16` (matches the spec's `postgres:16` testcontainer in B3 line 172).
