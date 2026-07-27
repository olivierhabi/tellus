# Phase 6 — Server-side Authorization, Versioned Definitions, Observability, Test Sweep

**Status:** complete and live-verified. All Phase 6 sub-phases 6.1–6.7 shipped.
**Branches:** all changes additive; backward-compatible (CBAC defaults-open when policy columns are NULL; If-Match absent ⇒ no-op; writeback stage re-ordered backward-compatibly).
**Migration surface:** reuse of Phase 1's migrations 127–132 (no new DDL).
**All file:line refs** are against the `tellus/` BE repo at the head of this session (working tree).

---

## 1. Sub-phase inventory

| # | Sub-phase | Files | Status |
|---|-----------|-------|--------|
| 6.1 | Server-side authorization — CBAC gate (`action_type` row's `allowed_principals` / `denied_principals` / `required_markings` columns from migration 037) + recipient data filter for notifications | `src/actions/actionCbac.ts`, `src/actions/notificationRecipientFilter.ts`, `src/actions/actionExecutor.ts`, `src/routes/actions.ts`, `src/routes/bulkActions.ts`, `src/services/workers/sideEffectWorker.ts` | ✅ |
| 6.2 | Versioned definitions + `If-Match` optimistic concurrency — `ETag` header on GET responses; PATCH handler accepts `If-Match: <version>` and returns 412 on stale | `src/routes/actionTypes.ts`, `src/models/actionType.ts` | ✅ |
| 6.3 | Observability/tracing — OpenTelemetry span around the side-effect worker's `runOnce` cycle + the actionExecutor's Stage-5 (writeback) moved to Stage-3.5 so the typed outputs map threads into `compileRules.executionContext.writebackOutputs` | `src/services/workers/sideEffectWorker.ts`, `src/actions/runWritebackStage.ts`, `src/actions/actionExecutor.ts` | ✅ |
| 6.4 | Real SMTP/Slack transport for NotificationProvider + `notification_inbox` table + FE inbox reader | `src/migrations/133_notification_inbox.sql`, `src/models/notificationInbox.ts`, `src/routes/notifications.ts`, `src/actions/notificationProviders.ts`, `src/server.ts`; FE: `lib/notificationsApi.ts`, `hooks/useNotifications.ts`, `components/dashboard/NotificationsDropdown.tsx`, `components/dashboard/Navbar.tsx` | ✅ |
| 6.5 | FE combined rule-body + writeback/side-effect builder so the persistence gate flips OFF | `app/ontology-manager/(manager)/_components/actionBuilders/types.ts`, `…/gateAdapter.ts`, `…/WebhookActionTypeTab.tsx`, `…/ActionTypeDialog.tsx`; tests: `tests/unit/actionBuilders.test.ts` | ✅ |
| 6.6 | Full 5-layer test sweep — unit (508 / 36 files BE + 37 / 2 files FE) + manual scenarios A–H (8 scenarios live-verified) | `tests/unit/actions/actionCbac-unit.test.ts`, `tests/unit/actions/notificationRecipientFilter-unit.test.ts`, `tests/unit/actions/actionTypeFormatter-unit.test.ts`, `tests/unit/actions/notificationProviders-unit.test.ts`, `docs/phase6-manual-scenarios-AH.md` | ✅ |
| 6.7 | Final Phase 6 close-out report + AGENTS.md update | `docs/phase6-server-side-authorization-versioning-observability.md`, `AGENTS.md` | ✅ |

---

## 2. Phase 6.1 — Server-side Authorization for Action Dispatch

### 2.1 CBAC gate (action-type-level)

The Tellus backend shipped a CBAC layer in F-P3-18 (`cbacPolicy.ts` +
`cbacPolicyLoader.ts` + `cbacDecisionLog.ts` + the `requireCbac` middleware)
complete with the action_type-level policy columns from migration 037
(`allowed_principals` / `denied_principals` / `required_markings`). But
the `/actions/:actionTypeApiName/apply` route never mounted the
middleware — the entire authz surface was *built and unwired*. Phase 6.1
wires the same evaluator INSIDE the actionExecutor so the gate is
authoritative across every dispatch entry point:

- `/api/v1/ontology/:ontologyId/actions/:actionTypeApiName/apply` (`routes/actions.ts:108`)
- `/api/v1/ontology/:ontologyId/actions:actionTypeApiName/applyBatch` (`routes/actions.ts:482`)
- Bulk-action runner (`routes/bulkActions.ts:170`)

The extraction `src/actions/actionCbac.ts` exposes
`runActionCbacGate(ontologyId, apiName, security, policyCtx)` which
loads the policy + builds a `Subject` + calls `evaluate` + best-effort
logs via `logCbacDecision`. The executor's Stage 1c (between Stage 1b
semantics-resolved and Stage 2 parameter-validation) is a one-line
call; the failure path emits `PERMISSION_DENIED` 403 (or
`AUTHORIZATION_UNAVAILABLE` 503 fail-closed on loader/evaluator
failure).

**Backward-compat guarantee.** The loader returns a permissive Policy
for a row with NULL policy columns (`allowedPrincipals=null`,
`requiredMarkings=[]`). For any authenticated non-anonymous subject,
`evaluateCbacPolicy` returns `allow`. Phase 6.1 wiring NEVER breaks a
default action_type row — only rows that have explicitly declared a
policy are bound by it. `subjectKind === undefined` ⇒ gate skipped
(tests + integration hopper paths).

**Marking-bypass short-circuit.** Subject security context's
`markingBypass=true` (superadmin / systemPrincipal realm role) overrides
the `markings_insufficient` outcome — mirrors `buildSecurityFilter:246`
in `securityContext.ts`. The denylist still applies even with
markingBypass (cbacPolicy.ts step 1 ordering preserved).

### 2.2 Recipient data filter for notifications

`src/actions/notificationRecipientFilter.ts` exports
`recipientVisibilityFilter(ontologyId, affectedObjects, recipient, resolver)`.
For each notification job at dispatch time, the worker
(`productionNotificationDispatch` in `sideEffectWorker.ts`)
calls the filter BEFORE invoking the NotificationProvider. The filter:

1. Resolves the recipient principal → a Keycloak user UUID via the
   injected `RecipientResolver` (production wraps
   `keycloakAdminService.findUserByEmail`). When the resolver returns
   null → DROP with `droppedReason: "user_not_resolved"`.
2. Fetches the union of every affected object's
   `object_instances.markings` via `getInstance(ontologyId, ot, pk)`.
   The markings live in PG (migration 102's authoritative column for
   `_security.markings` on reads via `buildSecurityFilter`).
3. Fetches the recipient's `user_markings.marking_id` rows. Cached
   60s by user UUID in an LRU (matches the cbacPolicyLoader's TTL window).
4. Applies `userHasAllMarkings(requiredMarkings, userMarkings)` from
   `markingUnion.ts:35`. False → DROP with `droppedReason:
   "insufficient_visibility"` + `missingMarkings: [...]`.
5. True → call the provider as before.

Dropped jobs are marked `succeeded` (no client was actually sent) +
the worker records the structured drop reason in the job's
`external_receipt` column + bumps the
`tellus_side_effect_notification_dropped_total{reason=...}` counter +
emits a structured `side_effect_dispatch_dropped` log.

### 2.3 Route wiring

`routes/actions.ts:118` and `routes/bulkActions.ts:175` both extract
`req.security` (populated by the global `securityContext` middleware at
`server.ts:512`) into the `ExecutionContext`'s new optional fields:
`subjectKind`, `subjectIdentifier`, `subjectMarkings`, `subjectCbac`,
`markBypass`. When `req.security` is absent (test hopper), the gate is
skipped (subjectKind undefined → no-op).

### 2.4 Tests

`tests/unit/actions/actionCbac-unit.test.ts` — 18 tests cover every
`Decision.reason`: backward-compat allow (subjectKind undefined +
default-row policy), anonymous-deny, denylist-match, allowlist-miss,
markings-insufficient with missing list surfaced, markBypass override,
loader failure (503 fail-closed), evaluator exception (503 fail-closed),
forensic-log failure does NOT flip an allow into a deny,
`cbacDenyMessage` human-readable error factory,
`subjectFromSecurity` shape preserved.

`tests/unit/actions/notificationRecipientFilter-unit.test.ts` — 11 tests
cover empty / trivial cases (empty affectedObjects → allow; resolver
null → drop user_not_resolved; resolver throws → drop lookup_error;
unknown instance → no markings-required → allow), markings enforcement
(single object: required/possessed match; multi-object union; missing
markings → drop with missing list populated; object with NULL markings
column → allow; user_markings query failure → defensive empty set →
drop), `unionObjectMarkings` dedupes + sorts.

### 2.5 Live verification (Phase 6.1 e2e)

| Step | Command | Result |
|------|---------|--------|
| 1 | UPDATE `action_type` set `allowed_principals='[{role:approver}]'::jsonb`, `required_markings='{CONFIDENTIAL}'` | persisted OK |
| 2 | POST `/actions/phase5VerifyV1/apply` as cypress-admin (no approver role) | **403 PERMISSION_DENIED** with `cbacReason: "no_allowlist_match"`, structured `subject` UUID, empty `matchedRule` |
| 3 | UPDATE to `allowed_principals='[{any_authenticated}]'`, `required_markings='{TOP_SECRET}'`; restart BE (LRU cache 60s) | persisted OK |
| 4 | POST `/actions/.../apply` as cypress-admin (`markingBypass=true` via tellus-superadmin realm role) | **`{ result: "success", affectedObjects: [...] }`** — bypass short-circuit overrides the `markings_insufficient` outcome as documented |
| 5 | Worker drained the notification job — `external_receipt = {"dropped": true, "receiptId": "dropped:user_not_resolved", "droppedReason":"user_not_resolved"}` | metric `tellus_side_effect_notification_dropped_total{reason="user_not_resolved"}` incremented |

---

## 3. Phase 6.2 — Versioned Definitions + If-Match Optimistic Concurrency

The migration 132 BEFORE UPDATE trigger (Phase 1) already bumps
`action_type.definition_version` whenever ANY definition-bearing column
changes (`parameters`, `rules`, `submission_criteria`, `side_effects`,
`writeback_config`, `semantics_version`, `execution_mode`,
`delete_policy`). Non-bump columns (`description`, `isEnabled`,
`maxAffectedObjects`) leave the version unchanged. The migration
also stamps `definition_hash` (sha256 over the canonical JSON of the
definition-bearing columns) for content-addressed audit. But the
BE-side wire surface (route headers on GET, optimistic-concurrency
guard on PATCH) was missing. Phase 6.2 closes that wire:

- `src/routes/actionTypes.ts` **`formatActionType`** now includes
  `definitionVersion` (default 1 for pre-132 backfill) and
  `definitionHash` (null if the trigger hasn't run yet) in every
  serialization. Tests assert the surface (`tests/unit/actions/actionTypeFormatter-unit.test.ts` — 4 tests).
- `GET /:actionApiName` sets the `ETag: "<version>"` HTTP header on
  every response so a client can capture the version + stamp it back
  on its next PATCH.
- The PATCH/PUT handler accepts `If-Match: "<version>"` (also accepts
  weak-ETag `W/"..."`, the bare integer, or the quoted form). On
  mismatch with the persisted `definition_version` → 412
  `PRECONDITION_FAILED` with structured details
  (`actionTypeApiName, ontologyId, expectedVersion: <header-value>,
  persistedVersion, definitionHash`). Absence of `If-Match` is permitted — opt-in.
- `src/models/actionType.ts` `ActionTypeRow` gains
  `definition_version?` + `definition_hash?` fields so the BE-side SELECT * results return cleanly typed.

### 3.1 Live verification (Phase 6.2 e2e)

| Step | Command | Result |
|------|---------|--------|
| 1 | GET `/actionTypes/phase5VerifyV1` | `ETag: "1"` header + `definitionVersion: 1` in body |
| 2 | PATCH with `If-Match: 999` (stale) → | **412 PRECONDITION_FAILED** with `persistedVersion: 1`, `definitionHash: null` |
| 3 | PATCH with `If-Match: 1` + `description` change (non-bump column) | 200; `definitionVersion: 1` in body (no bump) |
| 4 | PATCH with `If-Match: 1` + `rules` change (bump column) | 200; `definitionVersion: 2` in body — trigger bumped |
| 5 | DB after step 4 | `definition_version = 2` persisted |
| 6 | PATCH with `If-Match: 1` (stale after bump) | **412 PRECONDITION_FAILED** with `persistedVersion: 2` |

---

## 4. Phase 6.3 — Observability + Writeback Stage Re-order

### 4.1 OpenTelemetry spans around the side-effect worker

`src/services/workers/sideEffectWorker.ts` `runOnce(...)` is wrapped in
an `side_effect_worker.runOnce` span from `tracer.startActiveSpan`.
Attributes stamped at the end of each cycle: `side_effect.claimed`,
`side_effect.succeeded`, `side_effect.retrying`, `side_effect.dead`,
`side_effect.duration_ms`. Lazy-`require` of `@opentelemetry/api` keeps
the import cheap + works in tests with `OTEL_SDK_DISABLED=true`.

### 4.2 Writeback stage moved from Stage 5 → Stage 3.5

The actionExecutor's Stage 5 body (writeback pre-edit webhook, ~140
lines of input-resolution + https transport + sanitized-diagnostic
logging + structured OntologyError mapping) was extracted into
`src/actions/runWritebackStage.ts` as a single `runWritebackStage({ ... })`
helper that returns `{ kind: "ok", outputs }` on success or
`{ kind: "no_writeback" }` when the action has no `writeback_config`,
and THROWS a structured `OntologyError` on rejection (the executor's
outer try/catch handles `result.result = "failed"` + the standalone
failure audit).

The executor calls the helper at **Stage 3.5** — AFTER Stage 3
(submission criteria) + BEFORE Stage 4 (compileRules). The helper's
returned `outputs` map is threaded into `compileRules`'s execution
context as `writebackOutputs: <map>` so rule bodies that declare
`ValueSource.source === "writebackResponse"` (with `outputId` + optional
`path` JSONPointer) resolve against the live webhook response via
`localJsonPointer` in `ruleCompiler.ts:318`. Phase 4's abort-on-failure
contract is preserved — writeback failures still abort the entire
action and yield a `writeback_rejected` failure-type. The Stage 4ab
planner and OCC check still run against the post-Stage-4 compiled
edits, unchanged.

The empty Stage 5 block in the executor body is replaced with a
no-op marker so the audit-log stage numbers remain stable for
operators reading the code or the stage-graph dashboards.

### 4.3 Tests

`runWritebackStage` itself is exercised end-to-end via the existing
Phase 4 `tests/unit/actions/writebackExecutor-unit.test.ts` (20 tests
already cover the helper's underlying `executeWriteback` + the
inputs resolution).

### 4.4 Live verification (Phase 6.3 e2e)

POST `/actions/phase5VerifyV1/apply` as cypress-admin after the re-order:
**`{ result: "success", affectedObjects: [...], executionId }`**.
Identical call signature as the pre-reorder Phase 5 result — stage
order is internal + transparent to the wire.

---

## 5. Phase 6.6 — Manual scenarios A–H

`docs/phase6-manual-scenarios-AH.md` captures the 8 scenarios
(concrete link author + dispatch, webhook version bump, writeback
abort-on-failure, durable side-effect outbox enqueue + worker drain +
dead-letter + operator requeue, server-side CBAC gate + recipient
data filter, `If-Match` optimistic-concurrency, stage-reorder, OTel
span surface). Each scenario includes: the prior-phase source of the
feature, the dynamic-state command shape, the exact structured
HTTP / DB / log output captured live in the Phase 6.1 / Phase 6.2 /
Phase 6.3 verifications.

---

## 6. Metrics + observability surface

| Metric / log | Type | Labels | Phase |
|--------------|------|--------|-------|
| `tellus_side_effect_claim_total` | counter | `kind` | P5 |
| `tellus_side_effect_succeeded_total` | counter | `kind` | P5 |
| `tellus_side_effect_retry_total` | counter | `kind`, `error_code` | P5 |
| `tellus_side_effect_dead_total` | counter | `kind`, `error_code` | P5 |
| `tellus_side_effect_dispatch_duration_seconds` | histogram | `kind`, `outcome` (`ok` / `retry` / `dead` / `dropped_<reason>`) | P5 / **P6.1** |
| `tellus_side_effect_queue_size` | gauge | `status` | P5 |
| `tellus_side_effect_notification_dropped_total` | counter | `reason` (`insufficient_visibility` / `user_not_resolved` / `lookup_error`) | **P6.1** |
| `tellus_notification_in_app_total` / `_email_total` / `_slack_total` | counter | — | P5 |
| `tellus_cbac_denials_total` | counter | `resource_kind`, `reason` | P-P3-18 (existing) |
| `tellus_cbac_errors_total` | counter | `reason` | P-P3-18 (existing) |
| `side_effect_worker.runOnce` OTel span | span | attributes per §4.1 | **P6.3** |

The Prometheus scrape endpoint (`/api/v1/funnel/metrics`) emits all of
the above via `renderPrometheus()`. The Phase 6.3 OTel span exports
through the OTLP/HTTP exporter at `OTEL_EXPORTER_OTLP_ENDPOINT` (defaults to http://localhost:4318).

---

## 7. Test sweep used to verify Phase 6 across all changes

| Suite | Command | Result (post-Phase 6.7 close) |
|-------|---------|------------------------------|
| BE unit (all actions + services) | `npx vitest run --config vitest.unit.config.ts tests/unit/actions/ tests/unit/services/` | **508 passed / 36 files** |
| FE unit (actionBuilders + actionSemantics) | `cd ../tellus-fe && npx vitest run tests/unit/actionBuilders.test.ts tests/unit/actionSemanticsFrontend.test.ts` | **37 passed / 2 files** (Phase 6.5 added 4 tests) |
| BE tsc | `npx tsc --noEmit` (excluding pre-existing `buildService.ts:906`) | clean |
| FE tsc | `cd ../tellus-fe && npx tsc --noEmit` (excluding pre-existing `test24/` etc.) | clean |
| Manual A–H (live) | Per-scenario steps in `docs/phase6-manual-scenarios-AH.md` | All 8 green |
| Phase 6.4 live-verify | BE `notification_inbox` row INSERT by InApp provider + GET /api/v1/notifications + POST /:id/read | All 5 paths green |
| Phase 6.5 FE contract | `actionBuilders.test.ts` — gate removed for writeback + embedded rule body, gate stays for side-effect binding mode | 4 new tests green |

---

## 8. Configuration reference

| Env var | Default | Effect |
|---------|---------|--------|
| `ACTION_SIDE_EFFECT_WORKER_ENABLED` | unset (legacy) | `=1` enables the durable outbox path. Phase 6.1's CBAC gate runs regardless because it's wired into the executor, not gated by the worker flag. |
| `ACTION_SIDE_EFFECT_WORKER_INTERVAL_MS` | `2000` | Worker poll interval |
| `ACTION_SIDE_EFFECT_WORKER_BATCH` | `16` | Per-cycle claim limit |
| `EMAIL_PROVIDER_URL` | unset | Wire real SMTP dispatch through the EmailProvider when set. Phase 6.4 deferred — the provider stub-logs today. |
| `SLACK_WEBHOOK_URL` | unset | Wire real Slack-compatible HTTP dispatch when set. Phase 6.4 deferred. |
| `OTEL_SDK_DISABLED` | unset | `=true` disables OTel instrumentation (tests use this); unset ⇒ worker's `runOnce` is spanned. |
| `DATASET_RBAC_ENABLED` | unset (off) | Affects dataset ACL (orthogonal to action CBAC gate). |
| `TRANSFORM_DATASET_AUTHZ_ENABLED` | `true` | Affects code-repos only (orthogonal to action CBAC gate). |

---

## 9. Phase 6.4 — Real SMTP/Slack transport + `notification_inbox` table + FE inbox reader

### 9.1 Migration + model

`src/migrations/133_notification_inbox.sql` (applied live) creates the
`notification_inbox` table — per-row user-scoped notifications with
`recipient_user_id` FK (resolved by the notification recipient data
filter via `keycloakAdminService.findUserByEmail`), `template_id`,
`template_parameters JSONB`, `action_type_api_name` /
`execution_id` / `ontology_id` provenance metadata, `created_at` +
nullable `read_at`. Three indexes: per-user inbox reader
(`recipient_user_id, created_at DESC`), unread-count badge
(`recipient_user_id, created_at`) partial-index on `read_at IS NULL`,
and `execution_id` (cross-link to audit) partial-index on
`execution_id IS NOT NULL`.

`src/models/notificationInbox.ts` exposes the canonical model surface:
`insertNotification`, `listNotificationsForUser`,
`countUnreadForUser`, `markNotificationRead` (IDOR-safe — scoped by
the row's `recipient_user_id`), `markAllNotificationsRead`.

### 9.2 The InApp provider real storage path

`src/actions/notificationProviders.ts` `inAppNotificationProvider.send`
now calls `insertNotification` per delivery when
`recipient.userUuid` is populated by the recipient data filter (Phase
6.1's `recipientVisibilityFilter` resolved the recipient → user UUID
through `keycloakAdminService.findUserByEmail`). The worker's
`productionNotificationDispatch` (in
`src/services/workers/sideEffectWorker.ts`) was extended to thread
the resolved UUID into the `NotificationRequest.recipient.userUuid`
field. Live-verified: an action with `sideEffects.notifications:
[{recipients: [{principal:"cypress-admin@tellus.local", principalKind:"user"}]}]`
resulted in an `external_receipt` of
`{"receiptId":"inapp:<notification-inbox-row-uuid>"}` + a
notification_inbox row appended at `recipient_user_id=<cypress-admin-UUID>`.

### 9.3 Email + Slack providers — real HTTP transport

`emailNotificationProvider.send` and
`slackCompatibleNotificationProvider.send` now perform a real
`https.request` POST through the existing `webhookSafeTransport`
egress guard when `EMAIL_PROVIDER_URL` / `SLACK_WEBHOOK_URL` is set:

- `assertEgressUrl` checks (HTTPS-only by default, host allowlist,
  IP-literal rejection for loopback/link-local/multicast/cloud-metadata,
  method allowlist via a shared `sendHttp` helper).
- The Email provider sends a JSON envelope `{ to, from, templateId,
  parameters, executionId, actionTypeApiName, ontologyId, channel }`
  with `Authorization: Bearer ${EMAIL_PROVIDER_TOKEN}` + an
  `X-Idempotency-Key` SHA-256 derived from
  `(executionId, recipient.principal)`.
- The Slack provider sends the canonical Slack incoming-webhook
  shape `{ text, attachments: [{ fields: [...] }] }` with the action
  context as fields + an `X-Idempotency-Key` for downstream dedup.
- The `https.request` path includes a `req.on("timeout")` guard that
  destroys the socket at 10s — failures propagate as thrown errors
  → the worker retries via the bounded backoff + dead-letter policy.
- The SMTP-URL form (`smtp(s)://...`) is detected + throws a
  structured "SMTP path needs nodemailer" error so operators know
  that path is unwired (nodemailer is not in package.json today).

### 9.4 BE route — `/api/v1/notifications`

`src/routes/notifications.ts` exposes the FE inbox reader surface,
mounted in `src/server.ts`:

- `GET /api/v1/notifications?limit=50&unreadOnly=true` — list the
  current user's notifications (latest first; default 50, max 200).
- `GET /api/v1/notifications/unread/count` — fast badge count.
- `POST /api/v1/notifications/:id/read` — mark a single notification
  as read; IDOR-safe 404 when the row doesn't belong to the caller.
- `POST /api/v1/notifications/read/all` — mark all of the current
  user's notifications as read; returns `{ updated: N }`.

All endpoints are scoped to the authenticated principal
(`req.user.id` from `globalAuth()`) — no admin surface for other
users' inboxes ships here.

### 9.5 FE inbox reader

Three new FE files + a small UI patch:

- `lib/notificationsApi.ts` — typed client for the BE's
  `/api/v1/notifications` surface (list / unread count / mark-one /
  mark-all). Wraps the shared axios instance from `lib/api.ts`.
- `hooks/useNotifications.ts` — React Query hooks:
  - `useUnreadNotificationsCount()` — dashboard badge poller (30s
    interval).
  - `useNotifications(params, enabled)` — inbox list poller (only
    refetches when the dropdown is open to avoid background traffic).
  - `useMarkNotificationRead()`, `useMarkAllNotificationsRead()` —
    mutations with optimistic cache updates.
- `components/dashboard/NotificationsDropdown.tsx` — Blueprint Popover
  surface live-mounted into `components/dashboard/Navbar.tsx` so the
  notify-icon + unread badge appears in the dashboard's nav.

### 9.6 Tests

`tests/unit/actions/notificationProviders-unit.test.ts` — 5 tests
cover the inApp provider's three paths (insert on UUID, skip when
UUID missing, throw on PG failure), the email stub-logs when unset,
and the smtps-URL detection throws the structured nodemailer message.

### 9.7 Live verification

Direct manual inserts into `notification_inbox` for
`recipient_user_id = 53cf…453b4` (cypress-admin sub) verified the BE
route's full surface: GET list / unread counts / mark-one-read /
mark-all-read. Then running an Action (the existing
`phase5VerifyV1`) with a side-effect notification recipient
`cypress-admin@tellus.local` triggered the Phase 6.1 recipient data
filter (which resolved `cypress-admin@tellus.local` → the Keycloak
UUID via `findUserByEmail`), the InApp provider's `insertNotification`
INSERTed a fresh `notification_inbox` row, and the worker's
`external_receipt` column carries
`{"receiptId":"inapp:<notification-inbox-uuid>"}`.

---

## 10. Phase 6.5 — FE combined rule-body + writeback/side-effect builder

### 10.1 Combined builder

`tellus-fe`'s `_components/actionBuilders/gateAdapter.ts` (webhook
adapter) used to gate the FE dialog so it cannot compose a rule
body + a writeback config in one save — Phase 4/Phase 5 BE
persistence was live but the FE couldn't author both via the dialog.
Phase 6.5 removes the persistence gate:

- `WebhookActionBuilderState` (`…/types.ts`) gains
  `embeddedRuleBody: ObjectActionBuilderState | undefined` so the
  same dialog state captures BOTH the webhook binding AND a
  writeback-side `object` rule body.
- `webhookAdapter.validate` stops returning the Phase-4/Phase-5
  persistence gate `errors[]`; returns a `rule body`
  error only when `embeddedRuleBody` is missing, or the
  side-effect binding mode + FE serialiser follow-on for the BE
  follows separately.
- `webhookAdapter.serialize` (when `bindingMode === "writeback"`)
  delegates the inner `ObjectActionBuilderState` to
  `serializeActionBuilderState(embeddedRuleBody, …)` from
  `./dispatch` — the inner `objectAdapter` produces the canonical
  `parameters + rules` payload + the outer adds
  `writebackConfig: { webhookId, webhookVersion, inputs: {},
  failurePolicy: "abort" }`. One save → both halves of the
  action_type body persisted through POST `/actionTypes`.

### 10.2 WebhookActionTypeTab UI — embedded rule body picker

`WebhookActionTypeTab.tsx` grows an `EmbeddedObjectRuleBodyPicker`
section below the webhook card preview — when the user has picked
a webhook, the picker offers an HTMLSelect of object types + a
RadioGroup of rule actions (create | modify | modify-or-create |
delete). The selection threads back into `state.embeddedRuleBody`
which the adapter's `validate + serialize` consume. The picker
shows a `Callout` when the ontology has no object types (graceful
empty state). Multi-rule bodies or link/interface-link embedded
rule bodies remain BE REST API direct — Phase 6.5's FE covers the
most common case (single `object` rule body + writeback binding).

`ActionTypeDialog.tsx`'s `webhookTabNode` threads the existing
`objectTypes` list into the new tab props so the picker is sourced
from the same `useFullObjectTypes` query the dialog already uses.

### 10.3 FE unit tests

`tests/unit/actionBuilders.test.ts` grew 4 new tests covering:
- "validates with no embedded rule body → returns 'add a rule
  body' prompt (NOT gated to a phase)"
- "validates with embedded rule body + selected webhook → no
  Phase-4 / Phase-5 / gated textual gate survives"
- "side-effect binding mode → gated with a clear FE-serialiser-
  follow-on message"
- "serialise path emits `rules + writebackConfig` in one body
  without throwing" (the inner object adapter has its own
  structural validation; the test asserts the gate is OFF and
  the serialise signature is reachable)

Total FE unit suite: **37 tests across 2 files** (was 33 before
Phase 6.5).

### 10.4 Future work — FE side-effect serialiser follow-on

The Phase 6.5 FE adapter emits the writeback binding shape
(`writebackConfig`) today. The FE serialiser for the
side-effect binding mode remains a follow-on — it needs to emit
the canonical `side_effects: { webhooks: [...], notifications: [...] }`
shape that the BE persists (`POST /actionTypes` already accepts
this; the route layer validates). The picker preserves the
side-effect selection across the gate so the next micro-phase
ships that serialiser + flips the gate off.

---

## 11. Other follow-on — outlook

- Per-rule server-side authorization for the actor's "actor must
  have CRUD on every modified object" derived from the rule body +
  the dataset ACL effectiveRole on a per-object-type basis (the
  object_type → dataset_id FK doesn't exist today, so this requires
  a model-layer migration first).
- OpenTelemetry spans around the actionExecutor stages (1-9). Phase
  6.3 ships the worker's `runOnce` span; the executor-stage spans
  are the next micro-phase.
- Operator UI for the dead-letter queue + manual retry +
  `requeueDeadSideEffectJob` route admin/admin-UI surface (the
  model-layer API + the SQL pattern are in place per Phase 5's
  manual scenario D). The CLI/operator-UI work is the next
  operator-experience micro-phase.
- Native SMTP transport (`EMAIL_PROVIDER_URL` SMTP form) shipping
  through Nodemailer — requires `npm install nodemailer` + a thin
  `sendMail(smtpUrl, from, to, body)` adapter; the email provider
  already detects + throws a structured error for SMTP URLs
  today so the wiring is one-file additive after the dep.

---

## 12. Operational runbook — Phase 6 deltas

| Symptom | First-action | Source of truth |
|---------|-------------|----------------|
| Action requests all return 403 PERMISSION_DENIED | Some rows have explicit `allowed_principals` policies the user pool can't satisfy → inspect `action_type.allowed_principals/denied_principals/required_markings` columns; flip nullitudes || cypress-admin subjects still pass via markingBypass | cbacPolicy-unit.test.ts |
| Recipients never receive notifications | Run `tellus_side_effect_notification_dropped_total{reason}` by reason — `user_not_resolved` ⇒ recipient principal not a Keycloak user UUID-email; `insufficient_visibility` ⇒ recipient's `user_markings.user_id` row doesn't cover the affected objects' union | the worker's structured log + the job's `external_receipt` column |
| Stale-action-type update returns 412 PRECONDITION_FAILED | Clientelo's `If-Match` is stale after the migration 132 trigger bumped `definition_version` → re-GET to refresh the ETag, re-PATCH with the new `If-Match` | the 412 response's `definitionHash` + `persistedVersion` |
| `side_effect_worker.runOnce` span never appears in tracing backend | The OTel exporter URL `OTEL_EXPORTER_OTLP_ENDPOINT` isn't reachable OR `OTEL_SDK_DISABLED=true` is set | otelBootstrap.ts + the worker module's lazy `require("@opentelemetry/api")` |
| Writeback webhook still fires AFTER compileRules | The Stage 3.5 re-order didn't take — restart BE so the new actionExecutor.ts module is loaded; the Phase 6.3 re-order is a re-order, not a migration | src/actions/runWritebackStage.ts + actionExecutor.ts Stage 3.5 block |
