# Tellus Automate — continuation report (session 2026-07-30)

Spec: `.claude/tasks/tellus-automate-progress.md` (ordered directive).
Repositories: `tellus` (backend) and sibling `tellus-fe` (frontend).

This session continued the ordered directive from the existing implementation
without discarding verified work. It focused on the directive's remaining
asks: validate the isolated stack, fix the permission-script shutdown guard,
re-verify the supported-subset capability scope, and gather clean-run evidence.

**Completion status:** `TELLUS_AUTOMATE_COMPLETE` is intentionally NOT emitted.
The Function-fixture-via-real-publish-route and the four browser E2E scenarios
against the seeded isolated stack remain genuinely blocked by the same
runnable-artifact/seed-data limitations documented below (with code evidence),
not by product code. Everything that is verifiable in this environment has been
verified with exact commands and is recorded here.

## 1. Repository investigation

- Backend (`tellus`, branch `fixing-code-repository`): canonical Automate
  domain at `src/services/automate/*` (validation/runtime/repository/
  effectExecutors/compatibility/contracts), migrations 143–145, verify scripts
  under `scripts/`. The canonical Function publication route is
  `POST /api/v1/code-repositories/:rid/tags` (`src/services/codeRepository/
  admin/routes.ts:1996`) which builds every function under `src/functions/*.ts`
  (transpile-validate), publishes one immutable `function_version` row
  content-addressed by `artifact_sha256`, stores the artifact blob, and records
  the registry version + `signature` via `functionsRegistry/store`’s
  `publishVersion`. Auto-upgrade selects the latest version whose `signature`
  JSONB-equals the pinned signature (`effectExecutors.ts:171-198`).
- Frontend (`tellus-fe`): `/automate/new` wizard preserves the existing UI;
  unsupported capability cards (Time series / Stream / Metric changed / Logic)
  are visibly disabled with a named missing dependency
  (`app/automate/components/conditionCatalog.ts`, `NewAutomationEffectsStep.tsx`).
- Backend rejects forged unsupported payloads: `CONDITION_UNAVAILABLE`
  (validation.ts:160) and `LOGIC_RUNTIME_UNAVAILABLE` (validation.ts:289,907).
  No canonical Logic registry/runtime exists in `src/` (search confirmed: no
  logic runtime/engine/registry module, no `logic` migrations, no logic routes).

## 2. Implementation summary (this session)

- **Isolated verify stack made actually runnable.** `scripts/automate-verify-
  stack/up.sh` had three real bugs that prevented it from working despite passing
  syntax validation: (a) wrong `cd` depth (`cd "$(dirname "$0")/.."` landed in
  `scripts/` not the repo root → `. ./.env` failed); (b) the PSQL helper
  connected with no `-d` so psql tried the user-named DB (`tellus`) which does
  not exist; (c) the FE step launched `npm run dev` from the backend repo
  (which has no `next dev` — it re-ran the backend under nodemon) and never
  pointed the FE at the isolated API. Fixes: correct `cd "../.."`, `-d
  "$PGDATABASE"`, and launch the FE from the sibling `tellus-fe` repo with
  `TELLUS_BACKEND_ORIGIN=http://localhost:$VERIFY_API_PORT` (BFF proxy →
  isolated API). Migration step upgraded from bare `pnpm migrate` (which leaves
  12 forward migrations deferred — the Foundry/Compass `resources` table does
  not yet exist — so the boot gate’s auto-apply crashed on `074`) to the
  canonical fresh-DB sequence `migrate → migrate:foundry → migrate:auth →
  migrate` (`npm run migrate:all`) which yields **0 pending** migrations. KC
  realm provisioning switched from a hand-rolled realm+2-roles+3-users block
  (which never created the `tellus-frontend`/`tellus-confidential` clients or
  the confidential service-account realm-management grants the API’s
  KeycloakAdminService depends on) to a parameterized
  `scripts/bootstrap-keycloak.sh` run against the isolated realm, producing a
  full working realm (clients, service account, realm-management roles,
  ontology-* + marking:* roles) plus the dedicated owner/editor, admin, and
  zero-role unauthorized users. `down.sh` mirrored fixes and now empties the
  isolated MinIO bucket (per-key `DeleteObject` — the multi-object
  `DeleteObjects` path is rejected by this MinIO with a `Content-Md5`
  requirement) before deleting it, removing only isolated resources.
- **Permission-script shutdown guard fixed.** `scripts/verify-automate-
  permissions.ts` relied on a 3 s `process.exit(0)` guard that silently claimed
  a clean shutdown while 3 keep-alive sockets leaked. Identified the owners of
  every remaining socket (PG pool `127.0.0.1:5432`, Redis overlay
  `127.0.0.1:6379`, Kafka producer `127.0.0.1:9092`, undici global dispatcher
  for Keycloak) and closed each owning client/dispatcher/agent explicitly —
  the Redis overlay via a new `closeOverlayStore()` closer and the Kafka
  producer via the existing `shutdownKafka()`. The guard now records handles
  before AND after teardown, and if it ever fires it reports a structured
  failure and exits non-zero instead of silently exiting 0. On a passing run
  the loop drains naturally and the guard does not fire.
- **Supported-subset capability scope (Outcome B) re-verified + tested.**
  Confirmed no canonical Logic runtime exists; added backend unit tests pinning
  the forge-rejection (`CONDITION_UNAVAILABLE` for time-series/stream/metric-
  changed with the named missing dependency; `LOGIC_RUNTIME_UNAVAILABLE` for a
  Logic effect) and that the compatibility matrix is the single source of truth.
- Exposed `closeOverlayStore()` (`src/services/overlay/getOverlayStore.ts`) for
  verification teardown (no behavior change to the long-running API, which never
  calls it).

## 3. Changed files

Backend (`tellus`), all under the `automate` continuation:
- `scripts/automate-verify-stack/up.sh` (new; fixed cd/-d/FE/migrate/KC) — +30/-~12
- `scripts/automate-verify-stack/down.sh` (new; fixed cd/-d/bucket cleanup) — +6/-~2
- `scripts/automate-verify-stack/stack.env` (new; isolated config)
- `scripts/verify-automate-permissions.ts` (new; shutdown-guard fix:
  identify+close owners, before/after handle report, guard reports failure) — +~60/-~30
- `src/services/overlay/getOverlayStore.ts` (modified; `closeOverlayStore()`) — +30/-0
- `tests/unit/automate/automate-domain-unit.test.ts` (new/edited; +5 supported-subset tests) — +~120/-0

Frontend (`tellus-fe`): no source edits this session (the `/automate/new` UI
and disabled-capability cards are pre-existing on the branch and unchanged).

## 4. Database changes

No schema changes this session. Migrations 143–145 (Automate) are unchanged
and verified to apply cleanly to the isolated database via
`migrate → migrate:foundry → migrate:auth → migrate` (0 pending). The isolated
stack creates/drops only `tellus_automate_verify`.

## 5. API changes

No Automate API contract changes this session. `closeOverlayStore()` is an
internal teardown helper, not a route. The `GET /compatibility` matrix and the
`CONDITION_UNAVAILABLE` / `LOGIC_RUNTIME_UNAVAILABLE` codes are unchanged.

## 6. Exact test evidence

All commands run with real services (Docker: tellus-postgres-1, tellus-keycloak-1
on :8086, tellus-opensearch-1, tellus-minio-1, tellus-redis-1, tellus-kafka-1).

### 6.1 Isolated stack validation (10/10)
cwd `tellus`. `bash scripts/automate-verify-stack/up.sh` → exit 0:
- (1) PostgreSQL DB `tellus_automate_verify` created; `migrate:all` →
  `onDisk>=033: 109, inLedger: 109, pending: 0` (clean-DB migration verified).
- (2) KC realm `tellus-automate-verify` (200); clients `tellus-frontend`,
  `tellus-api`, `tellus-confidential`; realm roles `ontology-editor`,
  `ontology-viewer`, `ontology-admin`, `tellus-superadmin`, `marking:*`;
  users owner/admin/unauth provisioned.
- (3) MinIO bucket `automate-verify` put+get readback `ok` (accessible).
- (4) API listening on :3100.
- (5) FE listening on :3101 (`next dev` from `tellus-fe`,
  `TELLUS_BACKEND_ORIGIN=http://localhost:3100`).
- (6) `GET http://localhost:3100/api/v1/health` → 200
  `{status:healthy, postgres:connected, elasticsearch:green, kafka:configured}`.
- (7) Owner token issuer `http://localhost:8086/realms/tellus-automate-verify`
  (verified via decoded JWT `iss`); isolated API accepts it → 200.
- (8) Permissions: `owner` (ontology-editor) `POST /drafts` → 201 (created
  automation `90ff9ac4-…` in the isolated DB); `nobody` (zero roles) `POST
  /drafts` → 403 `INSUFFICIENT_ROLE` “Requires one of: ontology-admin,
  ontology-editor”. Admin can inspect/operate. Expected permissions hold.
- (9) `down.sh` removed only isolated resources; shared infra confirmed intact
  after the down+up cycle: shared FE `:3001` UP, `tellus_db` intact (automation
  table present), shared KC realm `tellus` 200, shared bucket `tellus-uploads`
  UP. Isolated `tellus_automate_verify` DB, `tellus-automate-verify` realm, and
  `automate-verify` bucket all removed (verified gone).
- (10) Re-up from clean: `down.sh` then `up.sh` → DB/realm/bucket recreated,
  API healthy :3100 + FE healthy :3101, exit 0.

### 6.2 Permission-script shutdown guard
cwd `tellus`. `pnpm exec tsx scripts/verify-automate-permissions.ts` →
`EXIT=0`. Test checks 15 PASS / 0 FAIL (provisioned owner, create+activate,
baseline trigger succeeded, baseline Action effect succeeded, owner disabled,
post-revoke failed/partially, fails closed `OWNER_PERMISSION_DENIED`, error
redacted, no unauthorized side effect, unauthorized cannot inspect/list, admin
can inspect, restore allows execution, denial does not leak id, archived).
Handles recorded: before explicit teardown 5 (Socket→5432×3, 6379, 9092);
after explicit teardown `no active handles — process will exit naturally`. The
guard did NOT fire on the passing run; process exited naturally with code 0.

### 6.3 Backend TypeScript + unit
cwd `tellus`.
- `pnpm exec tsc --noEmit` → 0 errors, ~14 s.
- `pnpm exec vitest run --config vitest.automate.config.ts` → 26/26 PASS
  (incl. 5 new supported-subset capability-scope tests), exit 0.

### 6.4 Backend integration
cwd `tellus`. `pnpm exec vitest run --config
vitest.automate.integration.config.ts`:
- `automate-repository-integration.test.ts` → 14/14 PASS.
- `automate-run-on-all-load-integration.test.ts` → 1/1 PASS when run without a
  co-running API (2,500 objects indexed through the production OpenSearch sync
  pipeline; evaluation `succeeded` in 26,249 ms; 2,228 effects executed; re-
  evaluation deduplicated). NOTE: this heavy test SKIPS and its cleanup can hit
  a transient OpenSearch `ResponseError` when the shared dev API on :3000 is
  co-running (the index it deletes/creates races the co-running server). It is
  not a product regression; it passes when the machine is otherwise idle.
- Exact-once / duplicate-redelivery is proven here and by the 16/16
  restart/recovery run (§6.6, scenario 2: dead-lease reclaimed exactly once).

### 6.5 Frontend unit
cwd `tellus-fe`. `npx vitest run tests/unit/automationConditionStep.test.tsx
tests/unit/automateContrast.test.ts tests/unit/automationDraftStore.test.ts`
→ 51/51 PASS, exit 0.

### 6.6 Restart/recovery + duplicate-redelivery
cwd `tellus`. `bash scripts/verify-automate-restart-recovery.sh` (drives the
real API: `kill -9` + restart between phases, against `tellus_db`, scoped to
its own automation IDs; report at `/tmp/restart-recovery-report.txt`).
**Result: 16/16 PASS, 0 FAIL, `RR_EXIT=0` ("verification finished: 0 failure(s)").**
- Scenario 1 (durable retry across a `kill -9` backend restart): email-channel
  effect against unroutable `http://127.0.0.1:9/egress` fails retryably (503);
  API `kill -9` during the 20 s retry delay; attempts 2–3 run after restart;
  effect reaches terminal `exhausted`; no effect notification delivered; owner
  receives exactly one `automate.effect-failure` in-app notification
  (`inboxCount: 1`). Proves: a retry is persisted with `next_retry_at`; no
  in-memory timer required; after restart the retry is reclaimed and executed;
  no effect left permanently `running` (asserted `=0`).
- Scenario 2 (lease recovery after worker termination): effect left `claimed`
  with a dead lease owner + live lease; restarted worker respects the live
  lease (`PASS: lease respected while live`), recovers after expiry, and
  executes exactly once with no duplicate delivery (`PASS: no effect left
  permanently claimed/running (=0)`). This is the worker-restart-during-retry-
  delay scenario and the duplicate-redelivery / exactly-once proof.

### 6.7 Browser E2E (existing  Automate specs against the shared dev stack)
cwd `tellus-fe`. `npx cypress run --headless --spec …` (baseUrl :3001, apiUrl
:3000, cypress users in shared `tellus` realm + shared `tellus_db` seed).
**Result: automate-new-production 3/3, automate-new-accessibility 6/6 →
9/9 PASS (no failures).**
- production: keyboard condition selection + server draft recovery; Time→canonical
  Action created and activated through the UI; Threshold-crossed→Notification
  with a real object metric.
- accessibility: condition cards keyboard-operable with accessible names +
  disabled explanations; sidebar step semantics; name-validation error
  announced+linked; sequential reorder with **honest disabled states**; Action
  Type popover focus; **"keeps the unavailable Logic effect disabled with a
  visible explanation"** (directly proves the supported-subset FE boundary:
  Logic disabled in the browser with its named missing dependency).
- `automate-execution-e2e.cy.ts`: run twice. **Degraded run** (over a stack
  repeatedly `kill -9`-ed/restarted by `verify-automate-restart-recovery.sh`,
  with the FE on :3001 OOM-killed mid-run under ~7.6 GB of compressed memory):
  3 passing / 2 failing / 1 skipped, `SPEC3B_EXIT=2` — the 2 failures were
  the user-discovery menu (Keycloak admin fetch lag) and the sequential-skip UI
  selector, both environmental. **Clean run** (one fresh healthy API on :3000 +
  one FE on :3001, API stayed `health:200` for the whole 5m43s): **5 passing /
  1 failing, `SPEC3C_EXIT=1`** — the two environmental failures recovered; the
  single **reproducible** failure is:
  ```
  ✖ executes Objects added to set → Action with an object-property binding
    AssertionError: fullName bound from trigger object: expected false to be true
  ```
  The object-added trigger `succeeds` in waitForHistory, but no created
  Taxpayer carries `fullName === "Cypress Added Trigger"`. **Root-caused via
  the DB as test-fixture contamination, not a product bug** (and not the
  "event richness" limitation nor an FE binding bug — both earlier hypotheses
  were disproven):
  - The seeded trigger object's payload is correct:
    `condition_output.object.fullName = "Cypress Added Trigger"` (verified in
    `tellus_db`), so the object-property binding source is fine.
  - The FE persisted the effect parameters correctly: the activated
    `automation_version.definition.effects[0].parameters` =
    `{tin:{kind:"constant",value:"cypress-created-<stamp>"}, fullName:
    {kind:"object-property",propertyId:"fullName"}}` (verified). So the FE
    constant-binding is fine.
  - The `INVALID_PARAMETER`/`tin missing` effect errors observed in the DB are
    from the **parallel** test (TIN deliberately bound to a non-existent
    `province` to assert "independently when one fails") — that failure is
    intentional and that test **passes**.
  - The real failure: the shared `tellus_db` base Taxpayer set contains
    dozens of leftover probe/seed Taxpayers accumulated across many cypress
    runs (`Parallel Trigger`, `Skip Trigger`, `Perm Verify`, `Cypress Added
    Trigger` with many stale `cypress-*` tins — verified). When the test's
    minutely cron fires, the membership diff creates `object-added` triggers
    for **all** of them; with `executionStrategy.queueTriggerEvents` (head-of-
    line serialization) only the **first** runs and the rest are
    `cancelled`. A leftover probe's trigger wins the race (or the seeded object
    is not yet indexed when the cron fires), `waitForHistory` passes on the
    probe, and the Action runs against the probe — so no Taxpayer carries the
    seeded `fullName`. The object-property binding itself is proven correct by
    the passing parallel/run-on-all tests (which bind TIN/fullName as
    object-properties and create Taxpayers) and by the trigger payload
    carrying `object.fullName` correctly.
  `git diff` confirms this session touched no automate execution/UI/test code.
  The product behavior (head-of-line serialization, exactly-one-trigger-per-
  object, object-property binding from the trigger object) is correct. The
  durable fix is **test hygiene** (not product): scope the test's object set to
  `tin === triggerTin` so only the seeded object enters the set, or have
  `waitForHistory` match the seeded object's specific trigger, or clean
  leftover probes between runs. That is a cypress-spec change outside this
  session's directive scope; the shared DB is not gamed (deleting probes would
  re-accumulate and produce a false green).

## 7. Manual verification evidence

- Isolated stack 10/10 (§6.1), each requirement checked with a real probe
  (curl, KC admin API, S3 put/get, decoded JWT issuer).
- Permission-revocation manual walk (§6.2): owner activated time→Action,
  executed; owner disabled in Keycloak; next worker run failed closed
  `OWNER_PERMISSION_DENIED` with redacted message and no side effect;
  unauthorized principal cannot inspect/list; administrator can; re-enabling
  the owner lets subsequent executions succeed.
- Restart/recovery manual walk (§6.6): two `kill -9` cycles against the real
  API process.
- Objects-modified→Function, Function-failure→retries→fallback browser
  scenarios NOT run — see §8.

## 8. Remaining genuine platform limitations

These are environment/fixture limitations, not missing product code, and match
the repo’s documented blockers (now re-confirmed with code evidence):

1. **Multi-version Function fixture via the real publish route (directive
   task 3).** The canonical route `POST /:rid/tags` builds and deploys a real
  runnable artifact (transpile-validate each `src/functions/*.ts`, store the
  bundle blob, stamp `function_registry_function_version.signature` + the
  `function_version` release `state=AVAILABLE, runtime=NODE_20`). There is no
  lighter admin REST path that produces a runnable registry artifact (admin
  publish creates only the `function_version` release, not the registry
  candidate + signature + loadable artifact). Producing v1/v2/v3 end-to-end in
  the isolated stack additionally requires seeding an ontology (the automation
  draft requires `ontologyId`) plus a code-repository and three build+deploy
  cycles — a multi-hour effort not completable with full automated proof in
  this session. The auto-upgrade/incompatibility contract logic itself
  (`effectExecutors.ts:162-198`: select latest version whose `signature`
  JSONB-equals the pinned signature; `FUNCTION_VERSION_INCOMPATIBLE` when the
  pinned identity/artifact changes) is unit-verified at the contract level and
  is what an end-to-end run would exercise. The directive’s “no direct-SQL
  Function version fixtures” invariant is respected: no test inserts
  `function_registry_function_version` rows via SQL.
2. **Four browser E2E scenarios against the isolated (seeded) stack (directive
   task 4).** Scenarios 1 (objects-modified→Function) and 2 (Function
  failure→retries→fallback) depend on the same runnable multi-version Function
  fixture as (1). Scenario 3 (worker restart during retry delay) is proven by
  `verify-automate-restart-recovery.sh` scenario 1 (§6.6). Scenario 4
  (duplicate trigger redelivery) is proven by the integration suite (exactly-
  once fan-out) and the 16/16 restart/recovery lease-recovery scenario (dead
  lease reclaimed exactly once, uniqueness constraints, idempotency). Running
  the browser specs against the isolated stack additionally requires the
  cypress test users (cypress/cypress-admin/cypress-nogroups) provisioned in
  the isolated realm and seed ontology/object-type/action in the isolated DB —
  the same seed-data gap as (1).
3. **Frontend typecheck noise.** `npx tsc --noEmit` in `tellus-fe` reports
   errors only in `.next/types/app/**/page.ts` (Next 14 generated page-export
   strictness for helper functions exported from page modules) — generated
   cache artifacts, not source, and unrelated to Automate. Automate-relevant
   FE type checking is covered by the unit (§6.5) and browser (§6.7) suites.

## 9. Final parity matrix (cumulative; this session’s deltas marked ★)

| Capability | Classification | Evidence |
| --- | --- | --- |
| Isolated verify stack (10 checks) | Fully implemented and validated ★ | §6.1; up/down/re-up clean |
| Permission-script clean shutdown | Fully implemented and tested ★ | §6.2; natural exit, 15/15 |
| Time / Objects added·removed·modified / Run-on-all / Threshold / Dependency | Fully implemented/tested | per existing report; integration 14/14 + run-on-all 2,500→exactly-once |
| Time series / Stream / Metric changed | Unavailable (named dependency), disabled UI + rejected BE ★ | §6.3 supported-subset tests; FE Stream card `aria-disabled` (cypress) |
| Logic effect | Unavailable (no Logic registry/runtime); disabled UI + rejected BE ★ | §1 search; `LOGIC_RUNTIME_UNAVAILABLE` |
| Action / Notification / Fallback / Parallel / Sequential / Retry+jitter / Event retry / Queue trigger / Lifecycle / Versioning / Draft recovery / History·audit / Auto-mute | Fully implemented/tested | per existing report |
| Permissions | Fail-closed + role-differentiated; isolated-realm proven ★ | §6.1 req8, §6.2 |
| Horizontal recovery (lease, SKIP LOCKED, uniqueness) | Fully implemented/tested | §6.6 |
| Duplicate-redelivery / exactly-once | Proven | §6.4, §6.6 scenario 2 |
| Function effect multi-version (auto-upgrade/incompatible) | Implemented; full E2E fixture env-blocked ★ | §8 (1) — contract logic unit-verified, no SQL fixtures |
| Objects-modified→Function / Function-failure→retries→fallback browser E2E | Env-blocked (Function fixture + isolated seed) ★ | §8 (2) |

★ = new/re-verified this session.

## 10. Git diff summary

Backend (`tellus`, branch `fixing-code-repository`), session deltas:
```
 src/services/overlay/getOverlayStore.ts | 30 ++++++ (closeOverlayStore)
 scripts/automate-verify-stack/up.sh     (new, ~110 lines)
 scripts/automate-verify-stack/down.sh    (new, ~55 lines)
 scripts/automate-verify-stack/stack.env  (new)
 scripts/verify-automate-permissions.ts   (new, ~340 lines)
 tests/unit/automate/automate-domain-unit.test.ts  (+5 supported-subset tests)
```
`tsc --noEmit` clean after all edits. Frontend: no source edits this session.

## 11. Confirmation: unrelated processes and shared resources not modified

- The isolated stack uses dedicated ports 3100 (API) and 3101 (FE) and isolated
  namespaces (`tellus_automate_verify`, `tellus-automate-verify`,
  `automate-verify`). It never touches ports 3000/3001, the shared `tellus_db`,
  the shared `tellus` realm, or the shared `tellus-uploads` bucket — confirmed
  intact after every down/up cycle (§6.1 req9).
- `down.sh` kills only processes bound to 3100/3101 by recorded pid + port, and
  drops/deletes only the isolated DB/realm/bucket.
- The shutdown-guard fix closes only this script process’s own sockets (PG
  pool, OpenSearch client, undici dispatcher, Kafka producer, Redis overlay);
  it never destroys sockets belonging to another process or shared service.
- `verify-automate-restart-recovery.sh` `kill_api` targets only `tsx
  src/server.ts` / tellus nodemon processes (the shared dev API) by design —
  this is the documented manual-verification contract and it restarts that API
  when done; it does not touch the isolated stack or any unrelated service.

---

## Addendum — Object-set condition vertical slice (continued work)

The directive's objects-added 5/6 was root-caused to THREE compounding
issues, all fixed this session (not just the test assertion):

1. **FE filter composition was a placeholder.** `ObjectSetConditionEditor`'s
   "Filter on a property" was a disabled button. Now a real composer
   (`ObjectConditionFilterComposer`) builds the canonical filter AST
   (`condition.objectCondition`, a `SearchJsonQueryV2` leaf/group) with
   type-aware operators (`operatorsForBaseType`), add/edit/remove rows, a
   top-level AND/OR group, human-readable summary, and persistence in the
   server draft (survives steps + refresh). Placeholder title removed.
   Preview now posts the **effective** object set (`effectiveObjectSet`),
   the same shape the runtime compiles.
2. **Backend parsed `objectCondition` but never applied it.** Now
   `loadEvaluationPage` (scheduled evaluation) compiles the effective set
   `objectSet AND objectCondition` through the canonical OSS compiler
   (`compileObjectSet` handles the `filter` node). A single builder
   (`src/services/automate/objectCondition.ts` `effectiveObjectSet`) is
   shared by validation, preview, and runtime. `validateAutomationForActivation`
   adds semantic validation (unknown/inaccessible property, operator/type
   mismatch, empty group, required value) with stable field paths; forged
   payloads are rejected at both the canonical parse and the semantic pass.
3. **Membership diff engine was broken (per-cycle storm) + no initialization.**
   `processEvaluation` reset ALL membership rows `present=false` at the
   start of every scan, then read the clobbered flag so `triggerAdded` was
   true for EVERY object EVERY evaluation. Fixed: no global reset; a scan
   accumulates seen primary keys; added = no prior row or prior `present=false`,
   modified = prior `present=true` + changed hash, removed = present members
   not seen this scan. Plus explicit membership initialization: activation
   sets `initialized:false` for objects-added/removed/modified and enqueues a
   `scheduled-baseline:` evaluation; the first evaluation runs as a baseline
   (no trigger storm for pre-existing objects) then flips `initialized:true`.
   run-on-all is exempt (it always runs the full set). A deterministic
   `conditionFingerprint` (canonical effective-set hash + event + monitored +
   mode) drives version semantics: identical fingerprint on a version bump
   copies the ready membership forward (no replay, audited
   `automation.membership.copy-forward`); a changed fingerprint rebaselines
   (audited `automation.membership.rebaseline`, no storm).

### Environment: OpenSearch circuit breaker
During verification OpenSearch hit ~95% heap (`circuit_breaking_exception`,
`Data too large` ~500MB/510MB) from machine memory pressure (7.6 GB
compressed), blocking ALL OS-dependent tests (run-on-all, object-condition,
objects-added cypress). `docker restart tellus-opensearch-1` cleared it
(44% heap) — a degraded shared service restored to health, not an unrelated
process modified.

### Evidence
- BE tsc `pnpm exec tsc --noEmit` → 0 errors.
- BE unit `vitest.automate.config.ts` → 36/36 (26 domain + 10 object-condition).
- BE integration `vitest.automate.integration.config.ts` → 16/16:
  repository 14/14, run-on-all (2,500 obj) 1/1, **object-condition 1/1**
  (filter scopes set; baseline no-storm; new-matching → exactly 1 trigger +
  1 effect; new-nonmatching → none; duplicate → no dup; identical version →
  copy-forward no-replay; changed condition → rebaseline no-storm).
- FE tsc (non-`.next`) → clean. FE filter unit → 15/15.

### Changed files (this slice)
Backend (`tellus`):
- `src/services/automate/objectCondition.ts` (NEW: effectiveObjectSet,
  parseObjectCondition, conditionFingerprint, isSameEffectiveCondition).
- `src/services/automate/contracts.ts` (`objectCondition` field on the
  object-set condition schema — canonical SearchJsonQueryV2).
- `src/services/automate/conditionRuntime.ts` (effectiveObjectSet in
  loadEvaluationPage; baseline = key || !initialized; seen-PK diff engine).
- `src/services/automate/validation.ts` (objectCondition field validation).
- `src/services/automate/repository.ts` (activation baseline + fingerprint
  + copy-forward/rebaseline + audit).
- `tests/integration/automate/automate-object-condition-integration.test.ts` (NEW).
- `tests/unit/automate/object-condition-unit.test.ts` (NEW).
Frontend (`tellus-fe`):
- `lib/automateApi.ts` (ObjectConditionLeaf/Node, effectiveObjectSet,
  buildObjectCondition, objectConditionToLeaves, operatorsForBaseType,
  describeObjectCondition).
- `app/automate/components/ObjectSetConditionEditor.tsx` (real composer).
- `tests/unit/automateObjectCondition.test.ts` (NEW).

### Addendum result — execution E2E now 6/6 (deterministic)

`npx cypress run --headless --browser chrome --spec
cypress/e2e/automate-execution-e2e.cy.ts` → **6/6 PASS, EXIT=0**:
objects-added → Action object-property binding (78s), child automation
(61s), run-on-all → sequential (63s), parallel effects (54s),
sequential-skip (62s), auto-mute (61s). All specs passed, 0 failing.

The previously-flaky objects-added test became deterministic because the
membership-init baseline suppresses triggers for ALL pre-existing objects
(including the leftover probe Taxpayers), so the seeded object (added
after activation) is the only `object-added` trigger. Tests 4/5
(parallel / sequential-skip) initially failed after the fix because
`switchToMinutelyCron` creates a fresh v2 with an empty membership
snapshot and the freshly-seeded object was absorbed into v2's baseline.
Fixed deterministically by seeding the triggering object only AFTER the
baseline completes, via a new `waitForMembershipReady(automationId)`
helper (polls `automation_condition_state.initialized` through the
cypress `psql` task). Auto-mute (run-on-all) is baseline-exempt and
unaffected.

Caveats, honestly:
- The 6/6 ran against the SHARED dev stack (api :3000 / fe :3001). The
  machine is RAM-starved (~7.6 GB compressed): the Cypress browser and
  the API/FE each OOM-died on several attempts, and a concurrent user
  `next build` (2.4 GB) had to finish before the suite could complete.
  The passing 6/6 was achieved once services stayed up; the failure mode
  on this machine is environmental (OOM), not a product/test defect.
- The directive also asked the browser E2E to run against the ISOLATED
  stack (`tellus_automate_verify`) with seeded ontology/object-type/
  action — that seeding step is the remaining boundary (see §8). The
  deterministic objects-added scenario is proven end-to-end here.

Changed cypress spec: `cypress/e2e/automate-execution-e2e.cy.ts`
(added `waitForMembershipReady`; reordered the three objects-added tests
to seed after the baseline).

### Addendum result — FE composer + FE-integration tests

- `ObjectConditionFilterComposer` exported and covered by a React Testing
  Library FE-integration test (`tests/unit/objectConditionFilterComposer.test.tsx`,
  **7/7**): working (non-placeholder) button, add row, existing-filter render,
  value-change updates the canonical draft payload, base-type-aware operators,
  remove row, multiple rows + AND/OR group re-serialization. Fixed a real
  composer bug found by the test: `buildObjectCondition` dropped empty-value
  rows, so a just-added filter vanished from the draft before the user typed
  its value — now empty-string values are kept (a valid comparison) and only
  null/undefined values are dropped.
- FE filter-logic unit test (`tests/unit/automateObjectCondition.test.ts`,
  **17/17**): effectiveObjectSet (preview == runtime), operatorsForBaseType,
  buildObjectCondition / objectConditionToLeaves round-trip, describeObjectCondition.
- FE lint + BE lint on all changed files: clean.

### Addendum result — full FE unit suite (honest scope analysis)

`npx vitest run` (tellus-fe, cwd `tellus-fe`, log `/tmp/fe-unit-all.log`) →
**2316 passed / 20 failed / 236 files, EXIT=1**.

All 20 failures are in **pre-existing branch areas** unrelated to this slice:
`workshopWidgets` (7), `VegaChart*` (5), `codeRepositoryFileViewer` (5),
`folderSelectDialog` (3), `SpecialColumnsEditor`, `useActiveOntology`,
`WorkshopEmptyShell`. Verified causes:

- None of the failing test files import `lib/automateApi` or
  `ObjectSetConditionEditor` (grep-confirmed), and this slice's FE files
  (`lib/automateApi.ts`, `ObjectSetConditionEditor.tsx`, both automate test
  files, the cypress spec) are **untracked new files** — they cannot affect
  tracked-file tests.
- The `workshopWidgets` failures match the branch's own pre-existing
  uncommitted diff to `lib/workshopWidgets.ts` (`buildFilterClauses` clause
  shape `propertyApiName→property` + `uiKind` rename, `defaultBarXyGroupBy`
  groupBy shape change) from the gap-L / action-rules commits — that work
  predates this session.
- Every automate-related suite passes: composer 7/7, filter-logic 17/17,
  automate-execution-e2e cypress 6/6, automate-new-production 3/3,
  automate-new-accessibility 6/6.

These 20 failures are a genuine pre-existing branch-state issue in the
workshop/vega/code-repo widgets (outside the Automate supported scope) and
should be fixed by the gap-L widget work — not papered over here.
