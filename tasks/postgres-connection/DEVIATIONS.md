# DEVIATIONS — postgres-connection v2

Per agent prompt §7. Spec §850–865 pre-authorizes the v1→v2 substitutions (JVM-free stack,
local Iceberg FS, etc.). Those are not re-listed here. This file records:
  (a) NEW deviations beyond the pre-authorized table, surfaced per §7 / §3.4
  (b) Resolutions of spec-vs-repo contradictions per §3.2

---

## D1 — Express 4 instead of Fastify 4 (resolves spec-vs-repo contradiction)

**Where the spec asserts the alternative.** Line 6: *"Fastify 4 is the existing HTTP layer."*

**Ground truth.** `package.json` declares `"express": "^4.21.2"` with no `fastify` dep.
`src/server.ts:168–292` uses Express middleware/routing throughout.

**Resolution.** All connectivity routes register as Express routers. Per §3.2 the spec wins
on technical detail when it conflicts with this prompt — but the spec ALSO instructs not to
substitute existing technology. Express is the existing technology; adopting it is faithfulness
to the spec's intent, not substitution.

**Impact on contracts/SLOs.** None. Express 4 meets the connectivity p99 ≤150ms read / ≤400ms
write SLOs trivially; the route shapes, error envelope shape, ETag / `If-Match` / `Idempotency-Key`
semantics, and Prometheus metric prefixes are framework-agnostic.

## D2 — Knex 3 instead of Drizzle ORM 0.30 (resolves spec-vs-repo contradiction)

**Where the spec asserts the alternative.** Line 6: *"Drizzle ORM 0.30 is the existing data
layer."*

**Ground truth.** `package.json` declares `"knex": "^3.1.0"` with no `drizzle-orm` dep.
Migrations in `src/migrations/` import from `'knex'`.

**Resolution.** New repos (`*.repo.ts`) use Knex query builder + raw SQL where ergonomic.
Where the spec says "Drizzle repo," read "Knex repo." Two-phase commit via Knex transactions
(`db.transaction(...)`) provides identical outbox-pattern semantics.

## D3 — Flat `src/services/<name>.ts` allowed where existing

The spec uses paths like `src/services/compass/compassService.ts` (line 39),
`src/services/ontology/`, etc. Reality is mixed: `src/services/compassService.ts` is flat;
`src/services/oss/` is nested. New code follows the spec's *nested* form
(`src/services/connectivity/...`); imports from existing flat-form services use their actual
paths (`from '../compassService'`, not `from '../compass/compassService'`).

## D4 — `src/db.ts` instead of `src/lib/db.ts`

Spec line 39 references "existing Postgres pool in `src/lib/db.ts`." Actual path is
`src/db.ts` which exports `{pool, query, getClient, withTransaction, queryWithRetry}`. All
new code imports from `src/db.ts`. A future cleanup may relocate to `src/lib/db.ts`; that
move is out of scope for this implementation.

## D5 — Reuse existing `src/middleware/idempotencyKey.ts`

Spec line 52 says "create if absent" for `src/middleware/idempotency.ts`. The repo already
has `src/middleware/idempotencyKey.ts` (166 LOC, UUIDv4 validation, sha256 request hashing,
status 200/201 capture, fire-and-forget INSERT with ON CONFLICT, prom-client counter
`tellus_idempotent_replay_total`). It already satisfies the spec's 24h replay contract and
the §9 cross-cutting requirements. New code mounts it directly; no duplicate
`src/middleware/idempotency.ts` is created.

## D6 — Migration filename convention

Spec uses `<timestamp>_<name>.sql`. Repo uses `NNN_<area>_<name>.sql` with `.down.sql` peers
(see `src/migrations/072_b4_resource_imports.sql`, `073_backfill_pipeline_output_dataset_names.sql`).
New migrations follow the repo convention: `074_b1_connectivity_connections.sql`,
`074_b1_connectivity_connections.down.sql`, etc.

## D7 — Error registry path

Spec line 54: `src/lib/errors/connectivity.errors.ts` registered in `src/lib/errors/registry.ts`.
Neither file exists. Created fresh under `src/lib/errors/` (new directory) using the spec's
shape: `{ errorCode, errorName, errorInstanceId, parameters }` matching the inline pattern
already used in `src/routes/quiver/compute.ts:errorName: "Tellus:Quiver:..."`.

## D8 — Idempotency keys persisted via existing `idempotency_keys` table

Verified via reading `src/middleware/idempotencyKey.ts:91–97`. New endpoints register the
middleware with an `endpoint` label of the form `connectivity.<verb>.<resource>`; no schema
migration is needed because the table is already provisioned by an earlier migration.

---

## Future deviation candidates (record at start of relevant task)

- **B6 agent binary signing.** Spec line 334 defers cosign signing. Will note in B6 DEVIATIONS
  whether `cosign` is invoked locally for non-prod builds or fully deferred.
- **B7 Kafka adapter target.** In-session uses Redpanda Testcontainer (spec authorizes line 10).
  Documenting which `kafkajs` version + Redpanda image tag at B7 start.
