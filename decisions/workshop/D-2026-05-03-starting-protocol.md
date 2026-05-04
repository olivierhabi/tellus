# Decision Log — Workshop Implementation Drive (Starting Protocol)

Date: 2026-05-03
Author: implementation drive (senior staff engineer role per brief)
Scope: Decisions taken during Starting Protocol when the Workshop spec was silent or when the existing Tellus repos diverge from the spec's stated environment.

Each entry follows the brief's Decision Protocol: ambiguity → options → choice → rationale → contract IDs touched → what evidence would change it.

---

## D-01 — Migration numbering: continue local sequence rather than V101

- **Ambiguity**: Spec calls migrations `V101__workshop_module.sql` (Flyway-style). Existing repo uses 3-digit sequential numbering (`038_…`, `039_…`) terminating at `057_b7_jobspec.sql`. Splicing in a Flyway-style filename mid-stream would silently break the migration runner.
- **Options**:
  - (a) Add a Flyway-style runner alongside the existing sequential runner.
  - (b) Continue the existing sequence with `058_b1_workshop_module.sql`, `059_…`, etc.
  - (c) Renumber existing migrations to make room for V101.
- **Chosen**: (b). Continue sequential numbering. Filename will be `058_b1_workshop_module.sql` plus `058_b1_workshop_module.down.sql` for reversibility.
- **Rationale**: Consistency with existing Tellus convention (§ Decision Protocol priority 2). Production-safer than (a) which doubles the runner surface, and irreversible compared to (c) which rewrites history.
- **Contract IDs touched**: B01 C-25, B02 (in-process validator on save), B03 C-18.
- **What would change it**: Adoption of Flyway across the wider Tellus codebase.

## D-02 — In-tree services collapsed; downstream calls go through service modules, not network

- **Ambiguity**: Spec describes Multipass, Compass, OMS, OSS, Actions, Functions as separate services with HTTP/JWT contracts. The Tellus monolith collapses all of them into one Express app (`src/services/*` + `src/routes/*`). Standing up six separate processes for testing is out of scope for this drive.
- **Options**:
  - (a) Split out each service into its own process before B01 (multi-week side quest).
  - (b) Keep monolith; replace inter-service HTTP calls with direct service-module function calls; preserve branch + JWT propagation as request-context fields threaded through every adapter.
  - (c) Mock the in-tree services (forbidden by the brief).
- **Chosen**: (b). Implement a `WorkshopServiceAdapter` interface per downstream surface (`OMSAdapter`, `OSSAdapter`, `ActionsAdapter`, `CompassAdapter`, `MultipassAdapter`); the monolith binds the adapter to the in-tree implementation; integration tests can swap to a recording test double for assertions on outbound calls (e.g., branch-forwarding).
- **Rationale**: §0.5 ("Forgetting branch on a single path breaks Foundry-style branching for the entire app") is preserved by the adapter boundary even without process separation. Foundry-faithful when no separate process exists yet.
- **Contract IDs touched**: G-05, G-06, B05 C-05/C-06, B06 C-06, B07 C-16, B08 C-09, B10 C-19.
- **What would change it**: Service split landed in a separate effort.

## D-03 — Conjure pipeline absent → Zod schemas + generated TS types

- **Ambiguity**: Spec mandates "Conjure-typed contract tests" and "Conjure clients generated from the IR." There is no Conjure pipeline in the repo.
- **Options**:
  - (a) Stand up Palantir Conjure tooling.
  - (b) Use Zod schemas as the contract source-of-truth; generate TS types via `z.infer<typeof ...>`; share the schemas between server (validation) and client (typed fetch wrappers); add a `@workshop/contracts` workspace exporting both.
  - (c) Hand-write TS types and validators.
- **Chosen**: (b). Zod is already in the repo's dependency tree where it's needed, is the strictest plausible interpretation of "Conjure-typed contracts" without a real Conjure IR, and produces a single SoT.
- **Rationale**: Production-safety (validation at the wire), consistency with existing Tellus patterns, the more restrictive option (Zod refuses unknown keys when configured strictly).
- **Contract IDs touched**: every contract test referenced by the DoD.
- **What would change it**: Conjure adoption across Tellus.

## D-04 — Redis absent → Postgres-backed cache with `LISTEN/NOTIFY`

- **Ambiguity**: Spec says publish/resolve cache and OMS metadata cache live in Redis. Repo has Postgres but no Redis. Redis pub/sub channels named in the spec (`oms.schema.invalidated`, `workshop.module.published`) have no Redis to live on.
- **Options**:
  - (a) Add Redis dependency.
  - (b) Implement a small `WorkshopCache` interface; default impl uses Postgres `LISTEN/NOTIFY` + an in-process LRU; swap to Redis when provisioned.
  - (c) No cache for v1.
- **Chosen**: (b). The cache contract (TTL, invalidation channel, hit-ratio metric) is preserved; the impl is swappable. SLOs in the spec assume cached reads; (c) would violate the SLO contract.
- **Rationale**: Auditability + Foundry-faithful (cache is a real component, not bolt-on); reversible.
- **Contract IDs touched**: B03 C-11, B03 C-13, B06 C-03, B06 C-04, B06 C-11.
- **What would change it**: Redis provisioned.

## D-05 — Testcontainers harness absent → vitest + ephemeral Postgres schema

- **Ambiguity**: Brief says "stand up the testcontainers harness" before B01. The repo has no testcontainers dep. The integration test pattern in `tests/integration/` uses a shared Postgres with per-test schema namespaces.
- **Options**:
  - (a) Add testcontainers; rewrite integration test runner.
  - (b) Use the existing per-schema pattern; add a `withSchema()` helper that creates an isolated schema, runs migrations into it, runs the test body, drops the schema.
  - (c) Run tests against shared schema (causes cross-test contamination, forbidden).
- **Chosen**: (b). Existing pattern, well-known, fast (no container churn), correct enough for the contracts B01–B10 require.
- **Rationale**: Consistency with existing Tellus conventions; the harness can be upgraded later without changing test bodies because tests already use a `db` fixture.
- **Contract IDs touched**: every integration-test contract.
- **What would change it**: Testcontainers harness landed.

## D-06 — RID format and generation

- **Ambiguity**: Spec demands `ri.workshop.main.module.<uuid v4>`; UUID generator unspecified.
- **Chosen**: `crypto.randomUUID()` (native Node 19+ which the repo uses), validated by the DDL CHECK constraint and a Zod refinement on the wire.
- **Contract IDs touched**: B01 C-02.

## D-07 — Display-name uniqueness implementation

- **Ambiguity**: Spec demands case-insensitive uniqueness within `parent_folder_rid`; insertion under concurrent POST race must produce 409.
- **Chosen**: Postgres partial unique index `UNIQUE (parent_folder_rid, lower(display_name)) WHERE deleted_at IS NULL`. Insert on conflict caught at the route layer and remapped to `Tellus:Workshop:ModuleNameConflict`.
- **Contract IDs touched**: B01 C-06.

## D-08 — ETag computation: ordered JSON canonicalization

- **Ambiguity**: Spec says `sha256(definition_jsonb || updated_at_micros)`. JSONB has no defined byte order; reusing Postgres's binary representation is a hidden version-coupling.
- **Options**:
  - (a) Hash Postgres `jsonb_build_object` output.
  - (b) Canonicalize `definition` to RFC 8785 (JSON Canonicalization Scheme) at the application layer, then hash with `updated_at_micros`.
- **Chosen**: (b). Deterministic across Postgres versions; reproducible from the API response. Computed in the same transaction that bumps `updated_at`, so concurrent PUTs see consistent ETags.
- **Contract IDs touched**: G-02, B01 C-09, B01 C-10, B01 C-11.

## D-09 — `Idempotency-Key` table

- **Ambiguity**: Spec says 24h TTL; cleanup mechanism unspecified.
- **Chosen**: Same per-row `expires_at` column, scheduled `DELETE … WHERE expires_at < now()` via the existing cleanup-service pattern in `src/services/cleanupService.ts`. PK = `(idempotency_key, user_id, route)`. Body hash stored as `body_sha256 BYTEA`.
- **Contract IDs touched**: G-03, B01 C-15, B01 C-16, B04 C-07, B10 C-01..C-03.

## D-10 — Concurrent PUT race semantics

- **Ambiguity**: Brief says "exactly one wins; the loser MUST be told to refetch."
- **Chosen**: Inside a single transaction, `SELECT … FOR UPDATE` on the row, recompute current ETag from `definition_jsonb || updated_at_micros`, compare to `If-Match`. Mismatch → ROLLBACK + 412 with `parameters.currentEtag`. Match → `UPDATE … SET definition = $1, updated_at = clock_timestamp(), updated_by = $2` and recompute new ETag from the post-update row. Returned to client. Default isolation = READ COMMITTED is fine because the row lock serializes the conflict; SERIALIZABLE not required.
- **Contract IDs touched**: B01 C-09, B01 C-10, B01 C-11, B01 C-19.

---

These ten decisions cover the gaps that would otherwise block B01. Subsequent decisions (per task) will be added as `D-2026-05-DD-<slug>.md`.
