# D-2026-05-04 — Quiver Drive: Starting Protocol decisions

> Decisions taken during the Starting Protocol of the Quiver Implementation Drive.
> Each entry: ambiguity / options considered / chosen / rationale / what evidence would change it / contract IDs touched.

---

## D-01 — `tellus-quiver-blueprint.md` is absent

**Ambiguity.** The task spec references `tellus-quiver-blueprint.md` as "the architectural fidelity bar". The file is not present anywhere under `/Users/olivierhabimana/Desktop/projects/tellus/` (or in the sibling repos `tellus-fe`, `blueprint`, `tellus-tasks`).

**Options.** (a) Stop and surface as Hard Stop. (b) Treat the task spec (`quiver-tasks.md`) as the single source of truth and proceed.

**Chosen.** (b). The task spec is exhaustive: it defines RID format, error taxonomy, card-type registry, OT instructions, SLO targets, metrics names, validation rules. It is the binding contract. The blueprint is referenced but not required for any specific behavior; nothing in this drive is conditioned on a blueprint section that is silent in the task spec.

**Rationale.** Spec defaults: production-safety (proceed with a strict reading) over fail-loud-stop when the strict reading is unambiguous. The brief explicitly empowers Decision Protocol over user escalation when the spec covers the behavior.

**What would change it.** Discovery of the blueprint document with binding architectural constraints not in the task spec.

**Contracts touched.** All — establishes the binding source.

---

## D-02 — Foundry vocabulary maps onto the existing tellus monorepo stack

**Ambiguity.** Task spec says "New service repos to be created: `tellus-quiver-service` (Witchcraft, Java 21, Gradle 8, gradle-conjure)" and treats Multipass / Compass / OMS / OSS / Codex / MMDP / Functions / Actions / AIP / Blobster / Iceberg as "existing Tellus services with stable contracts; honor them, do not re-implement them." The actual workspace at `/Users/olivierhabimana/Desktop/projects/tellus` is `ontology-engine`, a Node/TypeScript/Postgres monorepo with no Java / Gradle / Cassandra / Witchcraft / Conjure / standalone Multipass / standalone Compass etc. Prior modules (workshop, code-repository, object-explorer, Funnel-pipeline, Pipeline-builder) followed the same Foundry-style spec idiom and were implemented as Express/Fastify TypeScript modules **in this same monorepo**.

**Options.** (a) Stop and request a Java monorepo. (b) Implement in Java and assume infrastructure will appear. (c) Treat the Foundry vocabulary as aspirational and implement in this monorepo's idiom (TS / Postgres / vitest), mirroring the prior modules' pattern.

**Chosen.** (c).

**Rationale.** The prior modules' contracts.md / dag.md / PROGRESS.md (see `tasks/workshop/`) follow the exact same Foundry idiom and were implemented in TypeScript here. The companion services the spec names map cleanly onto existing tellus modules (Multipass = Keycloak, Compass = folders/breadcrumb service, OMS = object data store, OSS = object sets service, Functions = `functionRuntime.ts`, Actions = `actions.ts` route, Blobster = S3 via `@aws-sdk/client-s3`, Iceberg = Lakekeeper, MMDP = DuckDB+Polars). Witchcraft conventions (audit log shape, error envelope, RID format) are observable behaviors that translate.

**What would change it.** A directive to start a Java/Gradle subdir under `services/`.

**Contracts touched.** Every contract; establishes the implementation idiom.

**Mapping.** See `tasks/quiver/PROGRESS.md` "Vocabulary mapping" table.

---

## D-03 — Card Type Registry expansion: `PARAMETER_*` becomes 4 entries

**Ambiguity.** Spec lists `PARAMETER_*  inputs: {}  output: STRING|NUMBER|DATETIME|BOOLEAN`. Counted as one or four?

**Options.** (a) One generic `PARAMETER` entry with declared output sub-type. (b) Four type-specialized entries.

**Chosen.** (b) — `PARAMETER_STRING`, `PARAMETER_NUMBER`, `PARAMETER_DATETIME`, `PARAMETER_BOOLEAN`.

**Rationale.** (1) The brief Starting Protocol mandates "26 card types listed" and (b) counts to exactly 26 if `AIP_GENERATE_RESULT` is treated as a transient client-side type (see D-04). Type-specialized cards also avoid runtime branching in the F5 inspector (a parameter card's editor depends on its type). Foundry-faithful: Quiver's UI exposes parameter type at create-time.

**What would change it.** Spec text saying "PARAMETER is one entry".

**Contracts touched.** B2 C-02, F5 C-02, registry-fixture.md.

---

## D-04 — `AIP_GENERATE_RESULT` is a transient client-side type, not a registered card

**Ambiguity.** Spec lists it in the registry but it has no slot or stable output (`output: ARRAY<Card>`); it represents a sub-DAG proposal, not a renderable card.

**Chosen.** Treat as a parse-target (the validator accepts incoming SSE proposals shaped as `AIP_GENERATE_RESULT`) but NOT a registered card type. Materialized as a list of standard cards on user-accept.

**Rationale.** The spec's F9 + B9 flows describe Generate output as a proposed sub-DAG that the user accepts; the accepted cards are normal types. Storing `AIP_GENERATE_RESULT` rows would create dead artifacts after acceptance.

**Contracts touched.** B2 C-02, B9 C-04, F9 C-01, registry-fixture.md.

---

## D-05 — Postgres substitutes for AtlasDB-Cassandra

**Ambiguity.** Spec specifies AtlasDB-on-Cassandra throughout. This repo runs Postgres.

**Chosen.** Postgres with TIMESTAMPTZ + JSONB; UUIDv7 stored as TEXT (canonical lowercase) with CHECK constraint; primary keys aligned to Cassandra wide-row partition keys (e.g. `(rid, version)`).

**Rationale.** Consistency with all prior modules (workshop B01-B10, code-repository, etc.). AtlasDB's transactional semantics on Cassandra are weaker than Postgres SERIALIZABLE; we adopt the more restrictive option (Postgres SERIALIZABLE in conflict-prone hot paths).

**TTL substitution.** Cassandra `default_time_to_live = N` becomes a periodic sweep job (`src/services/quiver/sweepers/`) plus a `expires_at` column with `WHERE expires_at < now()` filters on read.

**Contracts touched.** B1 C-05, B3 C-09, B4 C-10, B5 C-07, B5 C-08, B7 C-06, B9 C-09.

---

## D-06 — Cassandra read consistency → Postgres default `READ COMMITTED` with `SELECT FOR UPDATE` on race-prone reads

**Chosen.** Default `READ COMMITTED`. Hot-path PATCH/PUT race resolution uses `SELECT … FOR UPDATE` followed by an `UPDATE ... WHERE rid = $1 AND etag = $2` to enforce CAS semantics; if `affected_rows = 0` → 412 `VERSION_MISMATCH`. Where snapshot semantics are required (B7 plan-equivalence), use `SET TRANSACTION ISOLATION LEVEL REPEATABLE READ` for the duration.

**Rationale.** Same as workshop drive's precedent. Spec defaults: more restrictive option (CAS via etag column).

**Contracts touched.** B1 C-17, B3 C-09, B4 C-01, B5 cache, B10 C-11.

---

## D-07 — Conjure IR substitute: shared zod schemas + OpenAPI export

**Chosen.** Public types defined as zod schemas in `src/services/quiver/api/types.ts`; emitted as OpenAPI 3.1 via `zod-to-openapi` to `api/docs/quiver.yaml`; consumed by frontend as TS types via `openapi-typescript`. The "consume by at least one client" universal-DoD item is satisfied by the frontend importing the generated types.

**Rationale.** Pattern from prior modules. zod gives runtime validation that Conjure code-gen also gives.

**Contracts touched.** Universal DoD item 4 (Conjure IR published & consumed) for every B-task.

---

## D-08 — Witchcraft `service.1.log` substitute: structured pino logs with the same field set

**Chosen.** Use the existing `pino` logger in this repo with a stable schema: `{ ts, level, traceId, spanId, userId, orgId, requestId, event, ridsTouched: [], result, errorCode, errorName, branch, ... }`. Audit rows additionally written to `audit_event` table per the existing `auditEventService.ts` for SOC2/audit retention.

**Rationale.** Existing convention; Witchcraft's wire format is internal to Palantir; we match its semantic content.

**Contracts touched.** G-09, G-10, every audit-related per-task contract.

---

## D-09 — Idempotency cache: Redis if available, Postgres `idempotency_keys` table fallback

**Chosen.** Postgres-backed `quiver_idempotency_keys` table (composite PK `(idempotency_key, user_id, route)`) with a sweeper. If `REDIS_URL` is configured, write-through to Redis with 24 h TTL for read-fast path; otherwise Postgres only.

**Rationale.** No Redis dependency in this repo's prior modules (workshop D-05). Same precedent.

**Contracts touched.** G-04, B1 C-16, B5 C-11, B10 C-12.

---

## D-10 — UUIDv7 generation

**Chosen.** Adopt `uuid` v9 with the `v7()` export (already in `package-lock.json` indirectly), or vendor a minimal v7 generator at `src/utils/uuidv7.ts`. RID validators reject any UUID where bit positions don't match v7 layout.

**Rationale.** Spec is explicit: time-ordered for index locality. Fail loudly on v4.

**Contracts touched.** G-01, B1 C-02, every RID-emitting endpoint.

---

## D-11 — Branch propagation contract: `?branch=` query param OR `X-Tellus-Branch` header

**Chosen.** Both accepted on every endpoint that touches OMS/OSS/Codex/MMDP. Header takes precedence if both supplied. Outbound calls always use header. The trunk has special string `main` (matching prior modules' convention); empty / absent is also `main`.

**Rationale.** Existing tellus pattern. Header is canonical for service-to-service; query param is convenient for shareable URLs.

**Contracts touched.** G-05, every B-task.

---

## D-12 — Phase feature flags: env-driven, default off

**Chosen.** `process.env.TELLUS_QUIVER_PHASE = "1" | "2" | "3" | "4" | "5"` (cumulative; phase 3 implies phases 1+2 enabled). Each phase's routes register only when the env var is at or above their phase. Test environment forces phase 5 (all features) unless a test pins lower. Production default unset = phase 0 = nothing mounted.

**Rationale.** Simple, observable, reverts cleanly. Spec mandates per-phase flags; this is the minimal correct implementation.

**Contracts touched.** G-13, every endpoint registration.
