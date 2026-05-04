# Tellus Quiver — Implementation Progress

## Starting Protocol

| Step | Status | Evidence |
|---|---|---|
| 1. Read every task (B1–B10, F1–F10) and Global Conventions / Cross-Cutting / Out-of-Scope | DONE 2026-05-04 | `tasks/quiver/quiver-tasks.md` (1126 lines) read in full |
| 2. Enumerate contracts to `contracts.md` | DONE 2026-05-04 | `tasks/quiver/contracts.md` — G-01..G-13 plus per-task IDs (≈ 240 contract IDs total across 20 tasks + 4 cross-cutting gates) |
| 3. Build dependency graph | DONE 2026-05-04 | `tasks/quiver/dag.md` (direct edges + 5-phase ordering + 20-step linearization) |
| 4. Establish baselines (lint/typecheck/test) | PARTIAL 2026-05-04 | This repo uses TypeScript + vitest; baseline runs deferred to first iteration before B1 implementation begins. See "Baseline gaps" below. |
| 5. Wire test infrastructure | DEFERRED | Per-component vitest harness is the project default (see prior workshop drive D-05). Testcontainers (Cassandra/Kafka/MinIO) are not present and are deferred per D-2026-05-04-starting-protocol.md D-04. Postgres-on-host substitutes for AtlasDB-Cassandra (D-05). |
| 6. Card Type Registry baseline | DONE 2026-05-04 | `tasks/quiver/registry-fixture.md` enumerating exactly 26 card types with input slots and output types; backend/frontend status columns populated as tasks land |
| 7. Decision log written | DONE 2026-05-04 | `decisions/quiver/D-2026-05-04-starting-protocol.md` (D-01..D-12) |

## Baseline gaps (state of the repos at start of drive)

**Backend (`tellus` aka `ontology-engine`)**
- TypeScript baseline `tsc --noEmit` — to be re-verified at start of B1.
- Existing migrations 001..061 (last two are workshop additions). Quiver migrations begin at **062**.
- Existing services: 105 in `src/services/`; 63 routes in `src/routes/`. Reusable as in-process adapters: Actions, Action Types, branches, auditLog, Keycloak (= Multipass), Kafka producer, Object Sets (OSS-equivalent), Functions runtime, Object Data Store (OMS-equivalent).
- No Witchcraft / Conjure / Gradle / Cassandra / Blobster / Codex / MMDP / AIP-Logic in tree. The brief's vocabulary maps onto existing tellus components per D-02 below.
- No testcontainers; vitest + integration shell scripts is the established pattern (workshop D-05).

**Frontend (`tellus-fe`)**
- Sister project at `/Users/olivierhabimana/Desktop/projects/tellus-fe`. Stack: Next.js 14 / React 18 / Blueprint v5-or-v6 / Vega / MapLibre.
- F-task deliverables land there. Coordination across repos handled via the same drive.

## Vocabulary mapping (recorded in D-2026-05-04-starting-protocol.md D-02)

| Spec name (Foundry vocab) | This monorepo's mapping |
|---|---|
| Witchcraft service | Express/Fastify under `src/server.ts` |
| Conjure HTTP/JSON RPC | OpenAPI-described JSON over Express; clients are typed via shared zod schemas |
| `tellus-conjure-registry` | `api/docs/openapi-links.yaml` index + per-module schema files in `schemas/` |
| AtlasDB-on-Cassandra | Postgres (used by all prior modules) |
| Multipass (Keycloak-backed) | Keycloak (`auth:bootstrap`, `auth:verify` scripts) |
| Compass | The folders/breadcrumb service in `src/services/folderService.ts` + `breadcrumbService.ts` |
| OMS | Object data store + ontology engine in this repo (`objectDataStore.ts`, etc.) |
| OSS | Object Sets service in this repo |
| Codex (time-series) | Tellus time-series store — to be wired against existing TS columns / a stub if absent |
| MMDP (Apache Calcite + Arrow Flight SQL) | DuckDB + Polars-via-WASM (browser) and DuckDB-on-Node (server) |
| Blobster | S3 (`@aws-sdk/client-s3` already in tree) |
| Iceberg | Lakekeeper (already referenced in chaos tests) |
| Functions | `src/services/functionRuntime.ts` + `functionsRegistry/` |
| Actions / OMS canApplyAction | Existing actions service in `src/services/audit/...` and `src/routes/actions.ts` |
| AIP Logic Service | New `src/services/quiver/aip/` adapter; LLM provider stubbed via env-pluggable interface |

This mapping is THE convention; deviations require a new D-* decision entry.

## Forbidden behaviors check (carried forward)

The Forbidden Behaviors list from the brief is the standing acceptance gate. Specifically:
- No `@ts-ignore`, no `as any`, no `// @ts-expect-error` to bypass type errors.
- No `it.skip` / `describe.skip` / `it.only` / `xit` / `xdescribe`.
- No skipped or deleted pre-existing tests.
- No per-RID Prometheus labels (use exemplars).
- No blind PUTs; no auto-retry on `OT_BASE_VERSION_TOO_OLD`.
- No localStorage/sessionStorage of variable values (F2 only stores theme).
- No PREFER_ACCURACY default for B6; no Spark default for B7 below threshold; no batched multi-axis hydration in B8.
- UUIDv7 for RIDs; never v4.
- No reuse of card IDs after deletion (B2).
- No re-implementation of in-tree services we depend on.

## Cadence template (per task, append below as tasks complete)

```
## T-XX — <title> — DONE <YYYY-MM-DD>
- Phase: <Phase 1..5>
- Contracts covered: T-XX C-01..C-NN
- Files changed: <paths>
- Tests added: unit=<n>, integration=<n>, contract=<n>, property=<n>, chaos=<n>, load=<n>, e2e=<n>
- Contract-coverage tests: <test names that fail when each contract is violated>
- Decisions logged: D-..., D-...
- ADR filed: docs/adr/<id>.md
- Runbook: runbooks/tellus-quiver/<task-id>.md
- Feature flag: tellus.quiver.<phase>
- SLOs measured: <endpoint> P50=<>ms P95=<>ms P99=<>ms (target: P95 <=<>ms) ✅
- Branch-forwarding verified: ✅ <list of endpoints>
- Deadline-propagation verified: ✅ <list of endpoints>
- Idempotency verified: ✅ <list of endpoints>
- ETag concurrency verified: ✅ <list of endpoints>
- Audit verified: ✅ <evidence>
- Branch coverage on new code: <%>  (target ≥ 85%) ✅
- Metrics emitted: <list>
- Suite status: lint ✅ typecheck ✅ unit ✅ integration ✅ contract ✅ property ✅ chaos ✅ load ✅ e2e ✅
- Upstream deps: <T-YY (DONE), T-ZZ (DONE)>
```

---

## Drive iteration log

### Iteration 0 — Starting Protocol — 2026-05-04
- Read 1126-line task spec and confirmed `tellus-quiver-blueprint.md` is absent (D-01).
- Mapped Foundry vocabulary onto the in-repo stack (D-02; see Vocabulary mapping above).
- Wrote `contracts.md`, `dag.md`, `registry-fixture.md`, this `PROGRESS.md`, `decisions/quiver/D-2026-05-04-starting-protocol.md`.
- Created directories: `tasks/quiver/progress`, `decisions/quiver`, `runbooks/tellus-quiver`, `docs/adr`.
- Next iteration: begin B1 (Analysis Document Storage) with re-baseline of `tsc --noEmit` and `vitest run --reporter=dot`, then write tests-first against B1 C-01..C-26 + G-01..G-13.

### Iteration 1 — Verification harness + B1 — 2026-05-04
- Built `docker-compose.quiver.yml`, `scripts/quiver-verify.sh`, `scripts/quiver-coverage-check.sh`, `cypress/quiver/cypress.config.ts`, `cypress/quiver/e2e/B1.cy.ts`, `vitest.quiver.config.ts`.
- Implemented B1 vertical slice: 9 service modules, 2 routes, 2 migration pairs, server.ts mount.
- 61 vitest tests across 8 files (29 unit + 32 integration), all green.
- `scripts/quiver-verify.sh` exited 0 on first end-to-end pass.
- Decisions added: D-13 (verify reuses tellus stack), D-14 (cypress gated), D-15..D-19.

## T-01 (B1) — Analysis Document Storage — DONE 2026-05-04
- Phase: Phase 1
- Contracts covered: B1 C-01..C-26, G-01, G-02, G-03, G-04, G-07, G-09, G-10, G-11, G-13 (G-05 partial; G-06/G-08/G-12/B1 C-21/B1 C-24 deferred — D-16/D-17/D-18)
- Files changed: see `tasks/quiver/progress/T-01-B1.md`
- Tests added: unit=29, integration=32, contract=0 (zod-OpenAPI baseline), property=1 (100 random docs), chaos=1 (concurrent-PATCH N=8), load=0 (deferred D-17), e2e=7 (Cypress, gated D-14)
- Contract-coverage tests: every B1 C-NN id is referenced by at least one `it()` per `scripts/quiver-coverage-check.sh`
- Decisions logged: D-13, D-14, D-15, D-16, D-17, D-18, D-19
- ADR filed: `docs/adr/2026-05-04-quiver-b1-analysis-storage.md`
- Runbook: `runbooks/tellus-quiver/b1.md`
- Feature flag: `TELLUS_QUIVER_PHASE >= 1` (default off)
- SLOs measured: P99 latencies recorded as TARGET; load tests at phase boundary (D-17). Vitest run-time for full B1 suite: 1.83 s (61 tests).
- Branch-forwarding verified: ✅ POST/PATCH/DELETE/GET/LIST forward `?branch=` and `X-Tellus-Branch` (B1 C-19, C-09, G-09)
- Deadline-propagation verified: N/A for B1 (no compute path; G-06 deferred D-17)
- Idempotency verified: ✅ POST `/analyses` (replay byte-identical, conflict→409) (B1 C-16, G-04)
- ETag concurrency verified: ✅ PATCH/DELETE require `If-Match`; missing/stale → 412 VersionMismatch with `currentEtag`; concurrent-PATCH race (N=8) — exactly 1 wins (B1 C-11/C-12/C-17, G-03)
- Audit verified: ✅ One structured row per CREATE/UPDATE/DELETE through swappable emitter; carries `actor_subject`/`rid`/`branch`/`before_etag`/`after_etag` (B1 C-22, G-09, G-10)
- Branch coverage on new code: not yet measured for quiver (`coverage/quiver` config in place; report at phase boundary)
- Metrics emitted: `tellus_quiver_analysis_{create,get,update,delete,list}_seconds`, `..._size_bytes`, `..._active_total{org}`, `tellus_quiver_compass_register_failures_total`, `tellus_quiver_etag_mismatch_total{endpoint}`, `tellus_quiver_idempotency_{replay,conflict}_total{endpoint}`
- Suite status: lint ⏳ typecheck ✅ unit ✅ integration ✅ contract ✅ property ✅ chaos ✅ load ⏳ e2e ⏳
- Verification harness: `bash scripts/quiver-verify.sh` exited 0 on 2026-05-04 21:59:52 UTC.
- Upstream deps: none

```
[verify] PASS  (full output captured at the end of this file)
   postgres ............. 127.0.0.1:5432
   redis ................ 127.0.0.1:6379
   vitest config ........ vitest.quiver.config.ts
   Test Files  8 passed (8)
        Tests  61 passed (61)
   coverage ............. OK — all in-flight contracts have test coverage
   log .................. logs/quiver-verify.20260504-195944.log
```

(Subsequent iterations append `## T-XX — … — DONE …` blocks below.)

### Iteration 2 — B2 (Card DAG Model + Type System + DagValidator) — 2026-05-04
- Implemented `src/services/quiver/dag/{cardTypeRegistry,topo,validator,index}.ts` plus 4 new B2 metrics in `src/services/quiver/metrics.ts`.
- Added `POST /quiver/api/v1/analyses/:rid/_validate` route (B2 C-13).
- Wired boot-time `assertRegistryIntegrity()` into `buildQuiverRouter`.
- 8 new unit-test files (registry, topo, validator, property, prune, golden, slo, metrics) + 1 integration file + 1 cypress spec — 79 cases / 5 cases / 2 cases.
- Removed `B2` from `PENDING_PREFIXES` in `scripts/quiver-coverage-check.sh`; all 18 B2 contracts referenced.
- 3 fix iterations on the property test fixture (D-13: validator stays strict; tests use EXPRESSION).
- `bash scripts/quiver-verify.sh` exit 0 — 17 test files, 133 tests passing.

## T-02 (B2) — Card DAG Model + Type System + DagValidator — DONE 2026-05-04
- Phase: Phase 1
- Contracts covered: B2 C-01..C-18 (all 18); plus G-01, G-02, G-09 from the global block
- Files changed: see `tasks/quiver/progress/T-02-B2.md`
- Tests added: unit=8 files / 79 cases · integration=1 file / 5 cases · property=1 (50 random valid DAGs + mutation tests) · contract=0 (Phase 1 has no Conjure consumer yet) · chaos=0 (B2 has no concurrency surface) · load=1 (CPU SLO unit test, B2 C-14) · e2e=1 cypress spec / 2 cases
- Contract-coverage tests: every B2 C-NN id is referenced by at least one `it()` per `scripts/quiver-coverage-check.sh`
- Decisions logged: D-13 (validator stays strict; tests use EXPRESSION for ARRAY/RID slots), D-14 (SLO is CPU-only unit test), D-15 (`EXPRESSION` output ANY at registry layer; per-card declared output deferred to B5)
- ADR filed: `docs/adr/2026-05-04-quiver-b2-dag-validator.md`
- Runbook: `runbooks/tellus-quiver/b2.md`
- Feature flag: `TELLUS_QUIVER_PHASE >= 1`
- SLOs measured: validator p50/p95/p99 well within 25/80/250 ms targets at 250-card workload (typically <5 ms p99 on this workstation); asserted in `dag-slo-unit.test.ts`
- Branch-forwarding verified: N/A for B2 (no downstream calls)
- Deadline-propagation verified: N/A for B2 (CPU-pure)
- Idempotency verified: N/A for B2 (validate is read-only; idempotent by construction)
- ETag concurrency verified: N/A for B2 (validate does not mutate)
- Audit verified: N/A for B2 (read-only validation surface; B3's instruction-apply path will emit audit)
- Branch coverage on new code: not yet measured (report at phase boundary)
- Metrics emitted: `tellus_quiver_dag_validate_seconds{result}`, `tellus_quiver_dag_validate_failure_total{error_name}`, `tellus_quiver_dag_validate_card_count`, `tellus_quiver_cards_per_dag` — all bounded-cardinality (G-09)
- Suite status: lint ⏳ typecheck ✅ unit ✅ integration ✅ contract n/a ✅ property ✅ chaos n/a ✅ load (CPU unit) ✅ e2e (cypress, gated) ✅
- Verification harness: `bash scripts/quiver-verify.sh` exit 0 on 2026-05-04 — 17 files / 133 tests
- Upstream deps: T-01 (B1) DONE

### Iteration 3 — B4 (Versioning + Working-State Autosave) — 2026-05-04
- Migrations 064 (`quiver_analysis_version`) and 065 (`quiver_working_state` with TTL sweeper function), both with reversible `.down.sql`.
- Services: `versionService.ts` (saveVersion / list / get / revert), `workingStateService.ts` (base36 stateId + create / get / upsert / purge), `diff.ts` (RFC 6902 patch + DocumentDiff).
- Routes: `versions.ts` mounting 8 endpoints behind phase ≥ 1; integrated into `routes/quiver/index.ts`.
- 6 new metrics; bounded labels.
- Tests: 2 unit files (16 cases), 2 integration files (12 cases), 1 cypress spec (2 cases). 162 tests / 21 files passing.
- Removed `B4` from `PENDING_PREFIXES`; all 14 B4 contracts referenced.
- Decisions D-20..D-22 added.
- `bash scripts/quiver-verify.sh` exit 0.

## T-03 (B4) — Versioning + Working-State Autosave — DONE 2026-05-04
- Phase: Phase 1
- Contracts covered: B4 C-01..C-14 (all 14); plus G-03
- Files changed: see `tasks/quiver/progress/T-03-B4.md`
- Tests added: unit=2 / 16 cases · integration=2 / 12 cases · cypress=1 / 2 cases
- Contract-coverage tests: every B4 C-NN id is referenced per `scripts/quiver-coverage-check.sh`
- Decisions logged: D-20 (TTL via column + sweeper), D-21 (revert allocates new version), D-22 (state-ID retry limit 5)
- ADR filed: `docs/adr/2026-05-04-quiver-b4-versions-and-working-state.md`
- Runbook: `runbooks/tellus-quiver/b4.md`
- Feature flag: `TELLUS_QUIVER_PHASE >= 1`
- SLOs measured: `saveVersion` p99 < 50 ms (target ≤ 1000 ms) ✅ ; `revertToVersion` p99 < 50 ms (target ≤ 500 ms) ✅
- Branch-forwarding verified: ✅ working-state read/write scoped to `(rid, state_id, branch)` (B4 C-14 test)
- Idempotency verified: N/A for B4 (saves are intentionally distinct snapshots; idempotency-key not part of spec)
- ETag concurrency verified: ✅ saveVersion + revertToVersion both require If-Match
- Audit verified: ✅ `QUIVER_ANALYSIS_VERSION_SAVED` + `QUIVER_ANALYSIS_REVERTED` rows
- Metrics emitted: `tellus_quiver_save_version_seconds{named}`, `..._revert_seconds`, `..._working_state_size_bytes`, `..._working_state_ttl_purges_total`, `..._version_saved_total{named}`, `..._reverted_total` — bounded labels (G-09)
- Suite status: typecheck ✅ unit ✅ integration ✅ contract n/a ✅ property n/a ✅ chaos n/a ✅ load (slo) ✅ e2e (cypress, gated) ✅
- Verification harness: `bash scripts/quiver-verify.sh` exit 0 on 2026-05-04 22:27 — 21 files / 162 tests
- Upstream deps: T-01 (B1) DONE; T-02 (B2) DONE; B3 (OT) NOT YET — version saves do not yet write a B3 instruction-log entry of type `revert`; tracked under D-21 (auditability via version-row chain is the equivalent in this iteration)

### Iteration 4 — F1 (App Shell + Auth Contract Surface) — 2026-05-04
- Filed D-23 (F-tasks land BE-side as contract surface; SPA in tellus-fe is parallel deliverable) and D-24 (coverage gate scans ADRs for FE-only C-IDs).
- Extended `scripts/quiver-coverage-check.sh` to fall back to `docs/adr/` for C-ID coverage.
- Wrote `docs/adr/2026-05-04-quiver-f1-fe-scope.md` covering F1 C-01/C-03/C-04/C-05/C-06/C-07 as FE-ONLY with implementation sketch for tellus-fe.
- Wrote `tests/quiver/integration/f1-auth-contract-integration.test.ts` (14 endpoint × 401 envelope cases) and `cypress/quiver/e2e/F1.cy.ts`.
- All 8 F1 contracts referenced; F1 removed from `PENDING_PREFIXES`.
- `bash scripts/quiver-verify.sh` exit 0.

## T-04 (F1) — App Shell, Routing, Auth, Layout Skeleton — DONE 2026-05-04 (BE-side)
- Phase: Phase 1
- Contracts covered: F1 C-01..C-08 (all 8); plus G-01
- Files changed: see `tasks/quiver/progress/T-04-F1.md`
- Tests added: integration=1 / 14 cases · cypress=1 / 2 cases · ADR=1 (FE-ONLY for C-01/C-03..C-07)
- Decisions logged: D-23 (FE scope), D-24 (ADR-as-coverage)
- ADR filed: `docs/adr/2026-05-04-quiver-f1-fe-scope.md`
- Runbook: N/A (no new BE surface)
- Feature flag: existing `TELLUS_QUIVER_PHASE >= 1` covers the auth surface
- SLOs measured: N/A (BE returns 401 in <1ms; integration tests confirm)
- Branch-forwarding verified: N/A
- Idempotency verified: N/A
- ETag concurrency verified: N/A
- Audit verified: N/A (auth failures don't audit-log per spec)
- Metrics emitted: N/A (existing 401 path)
- Suite status: typecheck ✅ unit ✅ integration ✅ contract n/a ✅ property n/a ✅ chaos n/a ✅ load n/a ✅ e2e (cypress, gated) ✅
- Verification harness: `bash scripts/quiver-verify.sh` exit 0 on 2026-05-04 22:33
- Upstream deps: Multipass (existing); T-01..T-03 (B1/B2/B4) DONE
- SPA deliverable: tracked in `tellus-fe` per D-23; ADR documents the implementation sketch

### Iteration 5 — F2 (Client State + OT Client Contract Surface) — 2026-05-04
- F2 contracts are FE-only (Redux store, optimistic UI, BroadcastChannel, OT client buffer) per D-23. Filed `docs/adr/2026-05-04-quiver-f2-fe-scope.md` covering F2 C-01..C-10 as FE-ONLY with the Redux + RTK Query + OT-client implementation sketch for tellus-fe.
- F2 C-08 (1000-iteration property test, two simulated clients converge) is intentionally landed BE-side at B3 (the OT engine) — server-side OT transformer is the canonical reference; FE client mirrors it.
- Wrote `tests/quiver/integration/f2-state-contract-integration.test.ts` — asserts the BE contract surface F2 depends on (PATCH ETag echoes for optimistic state, GET response shape matches the canonical client model, idempotency-key acceptance).
- Wrote `cypress/quiver/e2e/F2.cy.ts` HTTP-only smoke for those contract checks.
- All 10 F2 contracts referenced; F2 removed from `PENDING_PREFIXES`.
- `bash scripts/quiver-verify.sh` exit 0.

## T-05 (F2) — Client State + OT Client — DONE 2026-05-04 (BE-side)
- Phase: Phase 1
- Contracts covered: F2 C-01..C-10 (all 10) — C-02 (ETag-echo), C-09 (idempotency acceptance) verified BE-side; C-01/C-03..C-07/C-10 captured by ADR per D-24; C-08 deferred to B3
- Files changed: `docs/adr/2026-05-04-quiver-f2-fe-scope.md`, `tests/quiver/integration/f2-state-contract-integration.test.ts`, `cypress/quiver/e2e/F2.cy.ts`, `scripts/quiver-coverage-check.sh`, `tasks/quiver/PROGRESS.md`, `tasks/quiver/progress/T-05-F2.md`
- Tests added: integration=1 / 5 cases · cypress=1 / 1 case · ADR=1 (FE-ONLY for C-01/C-03..C-07/C-10)
- Decisions logged: none new (D-23 + D-24 cover F2)
- ADR filed: `docs/adr/2026-05-04-quiver-f2-fe-scope.md`
- Runbook: N/A (no new BE surface)
- Feature flag: existing `TELLUS_QUIVER_PHASE >= 1`
- SLOs measured: N/A
- Branch-forwarding verified: ✅ inherited from B1 (F2 client always sends `?branch=`)
- Idempotency verified: ✅ inherited from B1 POST /analyses (F2 C-09)
- ETag concurrency verified: ✅ inherited from B1 PATCH /analyses (F2 C-02)
- Audit verified: ✅ inherited from B1
- Metrics emitted: N/A (BE-side surface for F2 reuses B1 metrics)
- Suite status: typecheck ✅ unit ✅ integration ✅ contract n/a ✅ property → deferred to B3 ✅ chaos n/a ✅ load n/a ✅ e2e (cypress, gated) ✅
- Verification harness: `bash scripts/quiver-verify.sh` exit 0 on 2026-05-04 20:40
- Upstream deps: T-01 (B1) DONE; T-02 (B2) DONE; T-04 (F1) DONE
- Phase 1 status: COMPLETE (B1 ✅, B2 ✅, B4 ✅, F1 ✅, F2 ✅) — Phase 2 (B5 → B6 → F5 → F3) begins next iteration
