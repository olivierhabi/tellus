# BLOCKERS — postgres-connection v2 implementation

Per agent prompt §3.5. Each entry: task / obstacle / smallest unblocking change / confidence
that this is a real blocker vs. a misread.

---

## RESOLVED (treated as DEVIATIONS, not blockers)

### Spec-vs-repo stack contradiction (B1–B10)

**Obstacle.** Spec §6 line 6 asserts:
> "Fastify 4 is the existing HTTP layer. Drizzle ORM 0.30 is the existing data layer."

Ground truth in `/Users/olivierhabimana/Desktop/projects/tellus/package.json`:
- `"express": "^4.21.2"` (no `fastify`)
- `"knex": "^3.1.0"` (no `drizzle-orm`)

`src/server.ts:168-292` uses `app.use(...)` Express idioms throughout; `src/middleware/tellusAuth.ts:1`
and every existing migration import from `'knex'`.

**Resolution.** Align all new code to Express + Knex (the existing stack). Spec §3.2 forbids
"substitute simpler technology than the spec specifies" — Express/Knex are not a substitution;
they ARE the existing stack. Spec is internally inconsistent: §6 misnames the existing layer
while §3.2 forbids substitution. Aligning to reality is the only resolution that satisfies both
"do not introduce new tech" and "build inside the existing monolith." Logged in `DEVIATIONS.md`.

**Confidence this is a real contradiction:** HIGH (verified by file inspection).

---

## OPEN (block downstream tasks, not B1)

### B2 — `src/services/multipass/tokens.ts` missing

The spec at line 113 says: *"If the issuer does not yet emit workload JWTs, B2 extends
`src/services/multipass/tokens.ts` to do so — this is in-scope and not a blocker."* Spec
explicitly authorizes B2 to build this surface. Recording here only because the symbol path
itself does not exist; B2 will create `src/services/multipass/tokens.ts` rather than extending.

**Blocks:** B2 internal-unwrap workload JWT signing. **Resolution:** Create the module in B2.

### B5 — `src/services/lineage/lineageService.ts` missing

Spec line 266 says B5 "writes lineage edges via existing
`src/services/lineage/lineageService.ts`." That file does not exist. There is no existing
lineage service in the repo.

**Blocks:** B5 snapshot commit lineage emission acceptance criterion (implicit; not listed in B5
acceptance criteria explicitly, so B5 can close without it). **Resolution:** Emit lineage via
existing audit-event mechanism (`src/services/auditEventService.ts`) and create a thin
`lineageService.ts` shim writing `lineage_edges` table. Will be re-evaluated when B5 starts.

### B10 — `src/services/ontology/` does not exist

Spec line 446 says "existing `src/services/ontology/`." The directory is absent. Several
`*Service.ts` files (e.g., `interfaceQueryService.ts`, `interfaceInheritance.ts`) live at the flat
`src/services/` root and serve ontology-shaped responsibilities, but there is no namespaced
module.

**Blocks:** B10 ontology binding handlers. **Resolution:** Create `src/services/ontology/` as a
new namespace in B10; integrate with existing flat ontology-shaped services.

### B10 — `src/services/actions/` does not exist

`src/actions/` exists (different path). Spec implies a service-style integration.

**Resolution:** B10 imports from `src/actions/` directly; document in DEVIATIONS at B10 start.

### Cross-cutting — toolchain dependencies not installed

`package.json` is missing: `@asteasolutions/zod-to-openapi`, `openapi-typescript`,
`@asteasolutions/zod-to-openapi`, `apache-arrow`, `bullmq`, `iceberg-js`,
`pg-logical-replication`, `pg-query-stream`, `parquetjs` / `@dsnp/parquetjs`,
`libpg-query-node`, `kysely`, `fast-check`, `pg-types` (transitively present via `pg` but
parsers need explicit install), `pkg` (for B6 agent binary), `@kubernetes/client-node` (B4
deferred adapter).

**Blocks:** every task that names one. **Resolution:** Each task's first action installs the
deps it needs. Recorded here for visibility; not a hard blocker on starting.

### Cross-cutting — Testcontainers not wired

`tests/` directory has `vitest.config.ts` and integration runners but no Testcontainers setup
for PG 16, Redpanda, Redis 7, local Iceberg FS.

**Blocks:** every acceptance criterion that names a container fixture. **Resolution:** Add
`@testcontainers/postgresql`, `@testcontainers/redpanda`, `@testcontainers/redis` and a shared
`tests/fixtures/containers.ts` helper as part of B1's test scaffolding.

---

## NOT BLOCKED

B1 has no genuine blockers. Open per §5 loop.
