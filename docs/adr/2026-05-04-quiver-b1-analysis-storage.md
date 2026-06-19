# ADR — 2026-05-04 — Quiver B1: Analysis Document Storage

## Status
Accepted

## Context

Tellus Quiver (the typed reactive dataflow analytical canvas) requires
persistent storage for *Analysis* documents — the top-level user-facing
resource that a Card DAG (B2), OT instruction log (B3), versioning (B4),
and compute coordinator (B5) all attach to.

The Foundry-faithful spec (`tasks/quiver/quiver-tasks.md` §B1) describes
this as a Witchcraft Java service backed by AtlasDB-on-Cassandra with a
Conjure HTTP/JSON RPC contract. This monorepo (`ontology-engine`) is
Node/TypeScript on Postgres; the Witchcraft + AtlasDB language is
aspirational. (See `decisions/quiver/D-2026-05-04-starting-protocol.md`
D-02 — vocabulary mapping.)

## Decision

Implement B1 as the following modules in this monorepo:

* **Migrations** — `src/migrations/062_b1_quiver_analysis.sql` and
  `063_b1_quiver_idempotency.sql`. Additive, reversible (`.down.sql`),
  with `CHECK` enforcement of UUIDv7 layout per G-01.
* **Service** — `src/services/quiver/analysisService.ts` exposes
  `createAnalysis`, `getAnalysis`, `updateAnalysisMetadata`,
  `deleteAnalysis`, `listAnalysesInFolder`. Concurrency model is
  ETag-CAS (`UPDATE … WHERE rid = $1 AND etag = $stale`) wrapped in a
  `BEGIN/SELECT FOR UPDATE/UPDATE/COMMIT` so concurrent writers
  serialize correctly per D-06.
* **Route** — `src/routes/quiver/analyses.ts` mounted at
  `/quiver/api/v1` via `src/routes/quiver/index.ts`, gated behind
  `TELLUS_QUIVER_PHASE >= 1`.
* **Companion modules** — `errors.ts` (Conjure-style envelope, 23
  named constructors covering B1..B10), `etag.ts` (RFC 8785-canonical
  SHA-256 ETag), `idempotency.ts` (Postgres-backed 24h replay cache),
  `audit.ts` (swappable emitter shim), `metrics.ts` (prom-client
  histograms + counters), `branchHeader.ts` (G-05 propagation),
  `rids.ts` (UUIDv7-only RID validator + factory).

## Consequences

### Positive
* B1 ships behind a phase flag so production traffic is unaffected.
* All write paths satisfy G-03 (ETag) + G-04 (idempotency) + G-05
  (branch propagation) + G-10 (audit) without per-route plumbing.
* Verification harness (`scripts/quiver-verify.sh`) re-runs migrations
  up→down→up every cycle, guaranteeing reversibility (G-11) and
  catching schema drift early.
* The default Compass port is a no-op — production swaps in a real
  port before phase 1 traffic begins. Tests use `fakeCompass()` which
  spies on register / authorize calls and lets us drive the
  authorization-failure path deterministically.
* 61 tests covering B1 C-01..C-26 + G-01..G-04, G-07, G-09, G-10, G-11,
  G-13. The coverage gate (`scripts/quiver-coverage-check.sh`) blocks
  the harness on any unreferenced contract ID.

### Negative / accepted trade-offs
* B1 C-21 (per-card-output marking enforcement) and G-08 (mandatory
  org access controls) are deferred to a future CBAC task — recorded
  as D-16. The brief explicitly puts per-card-output marking
  inheritance out of v1 scope, so this is faithful to the spec.
* B1 C-24 (load-test SLOs) is deferred to phase-boundary load runs —
  recorded as D-17. Per-task k6 runs would 100x our verify cycle time
  and the spec sets per-phase SLO budgets, not per-task ones.
* G-06 (deadline propagation) does not apply to B1's CRUD path; it is
  a B5+ concern.
* G-12 (service-to-service JWT scoping) is deferred to D-18: the
  existing `securityContext` middleware already enforces service-vs-user
  in this monorepo and no new boundary was crossed.
* Cypress is not in `package.json` devDependencies (D-14). `B1.cy.ts`
  is written and ready; running it is gated on `CYPRESS_BIN` so the
  harness stays Docker-only on developer machines.
* B1 C-09 (`seedFromObjectSet` resolution against OSS) is wired
  through Compass branch propagation but does not yet *resolve* the
  reference into a starter `OBJECT_SET` card; that resolution lands
  with B6 (OSS backend). The current behavior accepts the reference
  field, propagates branch on Compass register, and stores the
  reference in the doc for B6 to pick up.

## Alternatives considered

* **One-table-fits-all** with a single `quiver_resource` table —
  rejected for the same reason workshop has separate tables: each
  resource type carries different invariants and the validator
  benefits from typed columns over polymorphic JSONB.
* **Idempotency via Redis only** — rejected because the existing
  workshop drive's D-05 demonstrated that Postgres-backed idempotency
  is robust and avoids a Redis dependency. Redis write-through is
  available behind `REDIS_URL` per D-09.
* **Soft-delete via a separate trash table** — rejected; the spec
  explicitly says "soft-delete with 30-day Trash window via Compass
  purge job", and a column flag is simpler than a sibling table.

## SLOs (recorded; load-tested at phase boundary)
* `getAnalysis` warm P99 ≤ 50 ms, cold P99 ≤ 250 ms (target).
* `createAnalysis` P99 ≤ 500 ms (target).
* `listAnalysesInFolder` P99 ≤ 300 ms for ≤ 1000 analyses (target).

## Linked decisions
* D-2026-05-04 D-01..D-12 (Starting Protocol).
* D-2026-05-04 D-13 (verify harness re-uses running tellus stack).
* D-2026-05-04 D-14 (Cypress runner gated on CYPRESS_BIN).
* D-2026-05-04 D-15 (`seedFromTemplate` resolution lands with B10).
* D-2026-05-04 D-16 (CBAC enforcement deferred to a CBAC task).
* D-2026-05-04 D-17 (load test SLOs at phase boundary; G-06 N/A for B1).
* D-2026-05-04 D-18 (service-to-service JWT scoping in existing middleware).
