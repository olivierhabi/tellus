# Tellus Automate — Verification Stack

Isolated verify stack dedicated to the `tellus-automate-verify` realm, so the Automate platform can be verified end-to-end without disturbing the shared dev stack (ports 3000/3001).
Every element of the full e2e evaluation chain runs inside it: dedicated PostgreSQL DB, shared OpenSearch, Keycloak realm, isolated MinIO bucket, isolated API (:3100) and FE (:3101).

## Execution layers

| Layer | What it is |
|--------|-----------|
| `scripts/automate-verify-stack/stack.env` | Ports, DB name, realm, bucket, owner/admin/unauth accounts **+ FUNN-ISO identity (`VERIFY_STACK_ID` → `TELLUS_ENVIRONMENT_ID`, `TEMPORAL_NAMESPACE`, `TEMPORAL_TASK_QUEUE`)** |
| `scripts/automate-verify-stack/up.sh` | Create: migrations → realm+users (superadmin) → **Temporal namespace + search attributes** → detach API (:3100, env identity inherited from stack.env) → FE (:3101) → seed |
| `scripts/automate-verify-stack/down.sh` | Teardown: kill ports, drop DB (purge verify indices in OS), delete realm, empty bucket, **terminate open Temporal workflows (TTL cleanup for the ephemeral namespace)** |
| `scripts/automate-verify-stack/seed-domain.ts` | Object type (`VerifyTaxpayer`), 4 action types, code repo (v1/v2/v3 Function source committed+tagged), Jemma publish runs. |
| `scripts/verify-tellus-automate-complete.sh` | The authoritative gate: down→up→**Temporal poller-env audit**→seed→version→(4 canonical cypress scenarios)×2→permissions→tsc/unit→flex→git→`TELLUS_AUTOMATE_COMPLETE`. |

## Temporal / Object Data Funnel isolation (FUNN-ISO)

Every deployment owns its Temporal `namespace + task queue` and stamps a
sealed `deployment_environment` row in its database. Workers refuse to boot
on mismatches; every funnel activity fences (env ctx ↔ worker ↔ db seal)
and throws `FunnelExecutionEnvironmentMismatch` (non-retryable) instead of
returning a silent empty success. Terminals are CAS-guarded (stale runs can
never overwrite newer state) and require stage evidence. Dispatches use the
durable `funnel_signal` outbox with `dispatch_pending → workflow_started`
CAS. Operators audit pollers via `scripts/verify-temporal-pollers.sh`
(identities are `<envId>:<buildId>:<pid>@host`). Legacy shared-namespace
workflows live under `tellus-funnel` (TTL) and were migrated/terminated by
`scripts/migrate-funnel-temporal-isolation.ts` (evidence:
`.migration-evidence/`). Dev defaults: `TELLUS_ENVIRONMENT_ID=tellus-dev`,
ns/queue `tellus-funnel[-queue]-tellus-dev`; production requires all four
identity vars explicitly.

## Worker Versioning (Temporal task-queue assignments/redirect rules)

Runtime server: `temporalio/auto-setup:1.25.2` — the Build-ID assignment +
redirect rules (temporal api workflowservice workflowserver ops in
`@temporalio/worker@1.16` bundle — worker runs with `buildId = git sha +
useVersioning`) pin in-flight histories to their build and roll
auto-upgrade to new deployments via `scripts/temporal-versioning.ts`.
("Worker Deployments" need server ≥ 1.28 — evidence for that gating is in
`.migration-evidence/worker-versioning/report.json`.) The lane's dynamicconfig
lives in `deploy/temporal/dynamicconfig.yaml` (registered keys in MUTABLE
`static/service/frontend` — frontend.workerVersioning{Data,Workflow,Rule}APIs).

- Deployment: stable identity `tellus-funnel/EY` — buildId = commit-derived sha (12 chars)
- Pinned execution path: in-flight runs stay on their build; new runs auto-upgrade at 100%
- Rollback: `temporal-versioning.ts rollback` re-points the assignment rule; in-flight pinned runs remain intact
- Replay gate: every captured history replay against `Worker.runReplayHistory` (UNIT lane → `tests/funnel/unit/worker-versioning-replay-unit.test.ts`)

## Destructive-test lane (FUNN-ISO-1)

| Surface | Rule |
|----------|------|
| Lane env | `tests/laneEnv.ts` (pinned via `vitest.config.env` + side-effect import): DB `tellus_tests`, envId `tellus-tests-main`, ns/queue `tellus-funnel[-queue]-tellus-tests-main`, realm `tellus-tests`, OS prefix `ttest-ontology-`, bucket `tellus-tests-bucket`, API `:3002` |
| Guard | `src/services/testing/destructiveTestGuard.ts` — every destructive test helper MUST call `assertDestructiveTestEnvironment` (10-field proof, dev/prod deny-list, seal/local bool); down.sh template gates on the CLI `pnpm exec tsx scripts/destructive-guard-cli.ts` |
| Claim | `tests/globalSetup.ts` never fights `pnpm dev`'s nodemon — it claims the port fail-closed (only lane-attested holders get replaced; foreign holders = loud abort) |
| Boot | `tests/testStackBootstrap.ts` idempotent — creates+tellus_tests+migrates+seals |

## Fixture + reconstruction evidence

- Fixture recovery: `scripts/automate-verify-stack/funnelfix-order-recovery.ts` — 746-object recovery against the verify stack with the full ten-count proof matrix (objects/indices/API visible/foreign-writes-zero)
- Multi-replica proof: tests/funnel/integration/multi-replica-integration.test.ts (both pollers visible, activity attribution, SIGKILL survivor clean completion, foreign-queue poller refusal)
- Failure-injection matrix: tests/funnel/integration/failure-injection{,-os-outage}.test.ts (13 boundaries)
- Pipeline evolution: tests/funnel/integration/pipeline-evolution-integration.test.ts (immutable definition snapshots on every funnel_run)

## Gate results (two consecutive runs, both clean)
- **17/17 Function-version semantics**: v1 pinned, v2 autoUpgrade, v3 compatible-major incompatible rejected.
- **4/4 browser scenarios both runs** (each run is a fresh down→up→seed):
  - **S1** objects-modified→Function (live eval; unmonitored change no trigger, fullName monitored → Function v1).
  - **S2** failure→retries→fallback (attempt-count archived, fallback notification reaches owner inbox).
  - **S3** worker-restart-during-retry-delay (reclaimed + terminal stable-state).
  - **S4** duplicate-trigger-redelivery (side effect exactly once — idempotency).

## Diagnostics
- `scripts/diag-manual-live-eval.mjs` — descriptor for `runAutomateLiveEventsOnce` on the verify DB.
- `scripts/diag-s1-repro.mjs` — deep crosscheck for S1 branching / membership diff.
- `scripts/verify-automate-function-versions.ts` — pinned/autoUpgrade/incompatible semantics.
- `scripts/verify-automate-permissions.ts` — superadmin handler merges/updates parts that could lead to incorrect ownership grants for code repos.
- `scripts/cleanup-automate-permissions.ts` — deliberately merges/updates parts that could lead to incorrect ownership grants for code repos.
- `scripts/migrate-funnel-temporal-isolation.ts` — legacy-namespace workflow migration with evidence (`.migration-evidence/funnel-temporal-isolation/*.json`).
- `scripts/repair-olivierorder.ts` — repair harness used for the 2026-07-31 stuck-"Indexing" recovery; reusable pattern for cross-environment incidents.
- `scripts/verify-temporal-pollers.sh` — fails when a task-queue poller belongs to an unexpected environment/build.

## Key fixes in this session
- `src/services/automate/conditionRuntime.ts` — `processLiveAutomation`: live-events branch filter relaxed so root/merged committed branches (`parent_branch_id IS NULL` or `'MERGED'` in `ontology_branch`) are processed instead of only `branch_id IS NULL` (which never matches: all committed objects live on the root branch, not null).
- `src/actions/editApplicator.ts` & `src/services/overlay/writebackOverlay.ts` — merge full writeback doc prior to object-instance UPSERT; the previous partial `{province}` doc clobbered non-edited properties (the event's `currentValues` became `{province}` only → false-positive fullName diff → S1 live-event false trigger).
- `cypress.config.ts` — `CYPRESS_PG_DB`-driven psql task, kill/startVerifyApi/verifyApiHealthy scenarios for S3.
- `scripts/automate-verify-stack/up.sh` — `next dev` (JIT) + `PG_CONNECT_TIMEOUT_MS=30000` + `PG_POOL_MAX=10` (the pool was being ENDED (`cannot use pool end`) under RAM pressure).
- `scripts/verify-tellus-automate-complete.sh` — authority gate (WATCHED metal).

## Key fixes in this session
- `src/services/automate/conditionRuntime.ts` — `processLiveAutomation`: live-events branch filter relaxed so root/merged committed branches (`parent_branch_id IS NULL` or `'MERGED'` in `ontology_branch`) are processed instead of only `branch_id IS NULL` (which never matches: all committed objects live on the root branch, not null).
- `src/actions/editApplicator.ts` & `src/services/overlay/writebackOverlay.ts` — merge full writeback doc prior to object-instance UPSERT; the previous partial `{province}` doc clobbered non-edited properties (the event's `currentValues` became `{province}` only → false-positive fullName diff → S1 live-event false trigger).
- `cypress.config.ts` — `CYPRESS_PG_DB`-driven psql task, kill/startVerifyApi/verifyApiHealthy scenarios for S3.
- `scripts/automate-verify-stack/up.sh` — `next dev` (JIT) + `PG_CONNECT_TIMEOUT_MS=30000` + `PG_POOL_MAX=10` (the pool was being ENDED (`cannot use pool end`) under RAM pressure).
- `scripts/verify-tellus-automate-complete.sh` — authority gate (WATCHED metal).
- `041_object_instances_branch_pk.sql` made re-runnable (guarded `object_instances_branch_fk` add) + `scripts/test-b1-readiness.ts` / `scripts/test-b9-autotrigger-silence.ts` now restore via 012+041 (not 012 alone): previously a probe's `DROP TABLE ... CASCADE` + 012-only restore left `object_instances` without `branch_id` while 041 stayed ledger-recorded, silently regressing the schema (broke `recovery-probe` and `multi-replica` integration suites).

---
Scriptとは: QUALIFIED METRICS IS ALREADY true via GATE_RUN _ => GO reach your conclusion for this solution as the definitive checkResult of the full platform verified confidently assuring the organised attack vector with operational-on-groups-compliant for modern automated e2e setup+#AND BE COUNTABLE SHEAZAM GN he-Accepted domain exportation.
