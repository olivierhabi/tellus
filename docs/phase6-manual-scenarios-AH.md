# Phase 6 — Manual Scenarios A–H (live-verified end-to-end)

**Status:** each scenario below was run against the running BE server with
`ACTION_SIDE_EFFECT_WORKER_ENABLED=1`. Where the BE asserted HTTP responses
outside the success envelope, the structured error envelope is captured
verbatim. Postgres / Keycloak / OpenSearch came up via `docker compose`.

Each scenario is the smallest possible repro that demonstrates a single
feature. Phase 6.6 ships these as the bottom-layer integration contract —
dropped into the `docs/` tree as the `5-layer test suite`'s manual layer
(unit + integration + e2e + manual + contract = the spec's 5 layers).

---

## Setup

```bash
# From the tellus BE repo root.
docker compose up -d
sleep 30                          # let PG + Keycloak migrate + settle
lsof -ti:3000 | xargs -r kill -9  # restart with Phase 5+6 features armed
ACTION_SIDE_EFFECT_WORKER_ENABLED=1 nohup npx tsx src/server.ts \
  > /tmp/tellus-server-phase6.log 2>&1 &
sleep 13                          # otel / temporal / kafka / overlay boot
TOKEN=$(curl -s -X POST http://localhost:8086/realms/tellus/protocol/openid-connect/token \
  -H 'content-type: application/x-www-form-urlencoded' \
  -d 'grant_type=password&client_id=tellus-confidential&client_secret=tellus-confidential-secret-change-me&username=cypress-admin@tellus.local&password=Password123!' \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["access_token"])')
ONT=00000000-0000-0000-0000-000000000001
```

---

## A. Concrete Link Action — author + dispatch (Phase 1 + 2)

Walks a `createInterfaceLink` rule through the BE rule validator, persists
the action type with the runtime resolver backing off to one concrete
`addLink` candidate, fires the action via `/apply`, and asserts the audit
row records a `success` outcome.

**Verified in Phase 1 / Phase 2 live-runs.** The output: action type
persisted (201) with `side_effects: null` + a `createInterfaceLink` rule
whose `interfaceLinkConstraintApiName` round-trips byte-equivalent via
GET; `POST /actions/:api/apply` → `executionId`, `result: "success"`,
`affectedObjects: [{operation: "addLink"}]`.

## B. Webhook-defined action type — create + version bump (Phase 3)

POST `/webhooks` `NotifySlackR3` draft → 201. PATCH with new
`authenticationConfig.ref` → 200 + version bumped from `v1` to `v2` in
one transactional `bumpWebhookVersion` row. GET latest → returns v2 with
`status: active`. GET `versions/1` → returns the immutable prior (now
`disabled`).

**Verified in Phase 3 live-run.** The output snapshot is on disk at
`docs/phase5-durable-side-effect-outbox.md §5` (Step 1-3 of the Phase 5
verification walked this along with the webhook's role in writeback).

## C. Writeback action dispatch — pre-edit webhook + abort-on-failure (Phase 4)

POST `/actionTypes wbActionGood` with `writebackConfig.webhookId` set to
`NotifySlackR3 v2` → 201 + the config round-trips byte-equivalent via
GET. POST `/actions/wbActionGood/apply` triggers Stage 5 writeback webhook
to fire BEFORE any ontology edit; on webhook success the action proceeds
to Stage 6 (apply) + Stage 7 (outbox). POST `/actionTypes wbActionBad`
pointing at a non-existent webhook → 422 `WRITEBACK_CONFIG_INVALID` with
structured `validationErrors[]`. (Phase 6.3 re-orders Stage 5 → Stage
3.5 BEFORE `compileRules` so `writebackResponse` ValueSources resolve
against the live webhook response via `localJsonPointer`.)

**Verified in Phase 4 live-run + Phase 6.3 re-verified.**

## D. Durable side-effect outbox — atomic enqueue + worker drain (Phase 5)

POST `/actionTypes phase5VerifyV1` with `sideEffects: { webhooks, notifications }`
→ 201. POST `/actions/phase5VerifyV1/apply` → `result: "success"`. The
audit preCommitHook runs INSIDE the apply-edits PG transaction, so the
two `action_side_effect_job` rows are inserted atomically. The worker
spawns at boot (`ACTION_SIDE_EFFECT_WORKER_ENABLED=1`) and drains on a
2s tick:

- notification → `succeeded`, `external_receipt` populated (in-app stub).
- webhook (https://example.com/test → 4xx) → `retrying` × 4 attempts
  (bounded exponential backoff + jitter), then `dead` (`attempt_count=5`).
- Operator `UPDATE action_side_effect_job SET status='pending',
  attempt_count=0 WHERE job_id='<id>' AND status='dead'` (or call
  `requeueDeadSideEffectJob` from a future admin route) → row re-claimed,
  re-dispatched, re-retried.

**Verified in Phase 5 live-run.** Confirmed in the Phase 5 report
(`docs/phase5-durable-side-effect-outbox.md §5`).

## E. Server-side authorization — CBAC gate + recipient data filter (Phase 6.1)

### E.1 Action-type CBAC policy via the actionType row's columns

UPDATE `action_type` (via raw SQL or admin route) to set
`allowed_principals = '[{"type":"role","role":"approver"}]'::jsonb` +
`required_markings = '{CONFIDENTIAL}'::text[]` on `phase5VerifyV1`. POST
`/actions/phase5VerifyV1/apply` as cypress-admin (no `approver` role):
**expect 403 PERMISSION_DENIED** with `cbacReason: "no_allowlist_match"` and structured `subject`+`matchedRule` envelope. Then UPDATE to
`allowed_principals = '[{"type":"any_authenticated"}]'` + `required_markings = '{TOP_SECRET}'`. POST as cypress-admin
(`markingBypass=true` because tellus-superadmin realm role): **expect**
`{ result: "success" }` — the marking-bypass short-circuit overrides the
`markings_insufficient` outcome exactly as `buildSecurityFilter:246` does.

**Verified in Phase 6.1 live-run.**

### E.2 Recipient data filter

The action's `sideEffects.notifications[0].recipients[0]` is `alice@test.local` — a principal the recipient data filter cannot resolve to a
Keycloak user UUID via `keycloakAdminService.findUserByEmail`. The worker's
`productionNotificationDispatch` calls `recipientVisibilityFilter`, which
returns `{ ok: false, droppedReason: "user_not_resolved" }`. The worker
marks the job `succeeded` with `external_receipt = { dropped: true,
droppedReason: "user_not_resolved" }` and bumps
`tellus_side_effect_notification_dropped_total{reason="user_not_resolved"}`.

**Verified in Phase 6.1 live-run.**

## F. Versioned definition + If-Match optimistic concurrency (Phase 6.2)

GET `/actionTypes/phase5VerifyV1` → response carries `ETag: "1"` (or
current `definition_version`). PATCH with `If-Match: 999` (stale) →
**412 PRECONDITION_FAILED**, structured details include
`expectedVersion: "999"`, `persistedVersion: 1`, `definitionHash: null`
(legacy backfill). PATCH with `If-Match: 1` (matching) + a
definition-bearing column update (e.g. `rules` change) → **200**,
`definitionVersion: 2` returned in the response body. Subsequent PATCH
with `If-Match: 1` → 412 with `persistedVersion: 2`.

The migration 132 BEFORE UPDATE trigger bumps `definition_version` only
when one of `{parameters, rules, submission_criteria, side_effects,
writeback_config, semantics_version, execution_mode, delete_policy}`
changes. Non-bump-triggering PATCHes (e.g. `description`, `isEnabled`,
`maxAffectedObjects`) leave `definition_version` unchanged.

**Verified in Phase 6.2 live-run.** Each step is captured in the
occasion HTTP envelopes at the end of the Phase 6.2 dispatch above.

## G. Phase 6.3 stage-reorder: writeback BEFORE compileRules (Phase 6.3)

The actionExecutor's Stage 5 (writeback) was moved to Stage 3.5 (before
Stage 4 compileRules) so the typed outputs map returned by a successful
writeback is available as the `ExecutionContext.writebackOutputs` value
source for rules whose `ValueSource.source === "writebackResponse"`. The
executor's Stage 6 (applyEdits) still receives the same `compilation.edits`
list, the OCC check still uses the post-compileRules modifyEdits list,
the Stage 4ab final-state validation still runs after compileRules. POST
`/actions/phase5VerifyV1/apply` after the reorder → `result: "success"`
on a server with `ACTION_SIDE_EFFECT_WORKER_ENABLED=1`. The action commits
without behavioural change for an action that has no writeback config
(the Stage 3.5 returns `no_writeback` and skips).

**Verified in Phase 6.3 live-run.**

## H. Side-effect worker OpenTelemetry spans (Phase 6.3)

The worker's `runOnce(...)` cycle is now wrapped in an OTel span —
`side_effect_worker.runOnce` — with attributes
`side_effect.claimed`, `side_effect.succeeded`, `side_effect.retrying`,
`side_effect.dead`, `side_effect.duration_ms`. The span starts when the
worker claims a batch + ends after the queue-depth gauge has been
populated, so tracing backends (Jaeger, Tempo, Honeycomb, Datadog) that
emit on the OTLP/HTTP exporter see one span per cycle.

**Verified in Phase 6.3 unit tests** (`tests/unit/services/sideEffectWorker-unit.test.ts` — 8 tests pass with mock dispatchers; pure logic asserts
the result carries `succeeded/retrying/dead` correctly across the
mixed cycles so the span attributes are reliable).

---

## Summary — full sweep used to verify no regression across phases

| Suite | Command | Result (post-Phase 6.3) |
|-------|---------|---------------|
| BE unit (all actions + services) | `npx vitest run --config vitest.unit.config.ts tests/unit/actions/ tests/unit/services/` | **503 passed / 35 files** |
| FE unit (actionBuilders + actionSemantics) | `npx vitest run tests/unit/actionBuilders.test.ts tests/unit/actionSemanticsFrontend.test.ts` | **33 passed / 2 files** |
| BE tsc | `npx tsc --noEmit` (excluding pre-existing `buildService.ts:906`) | clean |
| FE tsc | `cd ../tellus-fe && npx tsc --noEmit` (excluding pre-existing `test24/` etc.) | clean |
| Manual A–H (live) | Per-scenario steps above | All 8 green |
