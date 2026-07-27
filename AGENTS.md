# AGENTS.md — local dev guide for opencode agents on this repo

> Concise, copy-pastable runbook. Keep short. Details in the linked docs.

## Repo layout

- BE: `/Users/olivierhabimana/Desktop/projects/tellus` — TypeScript Express server, Postgres + Temporal + Kafka + OpenSearch.
- FE: `/Users/olivierhabimana/Desktop/projects/tellus-fe` — Next.js app.

## Booting

- BE: `lsof -ti:3000 | xargs kill -9; nohup npx tsx src/server.ts > /tmp/tellus-server.log 2>&1 &` then `sleep 12` — startup is slow through otel/temporal/kafka/webpack/overlay/lakekeeper. Log starts with `[otel] NodeSDK started`.
- FE: `npm run dev` (port 3001).
- Postgres: `tellus-postgres-1` container, `tellus` user, `tellus_db` DB. CLI: `docker exec tellus-postgres-1 psql -U tellus -d tellus_db -c "…"`.
- Keycloak: `http://localhost:8086/realms/tellus` — admin user `cypress-admin@tellus.local` / `Password123!`, confidential client `tellus-confidential` / `tellus-confidential-secret-change-me`.

## Auth (dev token)

```
curl -s -X POST http://localhost:8086/realms/tellus/protocol/openid-connect/token \
  -H 'content-type: application/x-www-form-urlencoded' \
  -d 'grant_type=password&client_id=tellus-confidential&client_secret=tellus-confidential-secret-change-me&username=cypress-admin@tellus.local&password=Password123!'
```

## Tests

- BE unit: `npx vitest run --config vitest.unit.config.ts tests/unit/actions/ tests/unit/services/`. No Docker required. ~7s.
- FE unit: `cd /Users/olivierhabimana/Desktop/projects/tellus-fe && npx vitest run tests/unit/actionBuilders.test.ts tests/unit/actionSemanticsFrontend.test.ts`.

## Type-check

- BE: `npx tsc --noEmit` (clean for all current Phase 1-5 additions; one pre-existing unrelated error in `src/services/codeRepository/transforms/buildService.ts:906`).
- FE: `cd /Users/olivierhabimana/Desktop/projects/tellus-fe && npx tsc --noEmit` (Phase 1-5 additions clean; pre-existing unrelated `test24/`/`workshop/`/`projects/` errors unchanged).

## Phase 6 — server-side authz, versioning, observability

- CBAC gate for action dispatch: actionExecutor Stage 1c — `subjectKind=undefined ⇒ backward-compat skip` (test hopper). Routes (`routes/actions.ts`, `routes/bulkActions.ts`) thread `req.security.markings/cbac/markingBypass` into the executor's `ExecutionContext`. Default-row policy (NULL columns) ⇒ ALLOW for any authenticated non-anonymous subject (backward-compat).
- If-Match optimistic concurrency: `GET /actionTypes/:apiName` sets `ETag: "<version>"`; `PATCH /actionTypes/:apiName` accepts `If-Match: <version>` and returns 412 on stale. The migration 132 trigger bumps `definition_version` only on definition-bearing columns (`parameters/rules/submission_criteria/side_effects/writeback_config/semantics_*`); non-bump-triggering edits (`description/isEnabled/maxAffectedObjects`) keep the version.
- Writeback stage re-ordered Stage 5 → Stage 3.5 (BEFORE compileRules) so `writebackResponse` ValueSources resolve against the live webhook outputs via `localJsonPointer` in `ruleCompiler.ts`. Phase 4's abort-on-failure contract preserved.
- Worker `runOnce` cycle wrapped in `side_effect_worker.runOnce` OTel span with attributes `claimed/succeeded/retrying/dead/duration_ms`.
- Recipient data filter for notifications in `notificationRecipientFilter.ts`; drops recipients the resolver can't map (`user_not_resolved`), or whose `user_markings` don't cover the affected objects' union (`insufficient_visibility`). Recorded in `external_receipt` + the `tellus_side_effect_notification_dropped_total{reason}` counter.
- Manual scenarios A–H live-verified in `docs/phase6-manual-scenarios-AH.md`.

## Phase 6.4 — notification inbox + real SMTP/Slack transport

- BE migration: `133_notification_inbox.sql` — `notification_inbox` per-user table (recipient_user_id UUID FK + template_id + provenance); 3 indexes (user+created, unread partial, execution cross-link). Applied live.
- BE model: `src/models/notificationInbox.ts` — `insertNotification` / `listNotificationsForUser` / `countUnreadForUser` / `markNotificationRead` (IDOR-safe 404) / `markAllNotificationsRead`.
- BE provider: `src/actions/notificationProviders.ts` `inAppNotificationProvider.send` calls `insertNotification` when `recipient.userUuid` is populated by the Phase 6.1 recipient data filter. The Email + Slack providers do real `https.request` POSTs through `webhookSafeTransport.assertEgressUrl` — SMTP URLs detected + throw a structured "needs nodemailer" error (the dep isn't installed today; trivial additive to wire).
- BE route: `src/routes/notifications.ts` mounted at `/api/v1/notifications` — `GET /` (list), `GET /unread/count` (badge), `POST /:id/read` (mark-one, IDOR-safe 404), `POST /read/all` (mark.all). AuthN-scoped to `req.user.id`.
- FE: `lib/notificationsApi.ts` typed client; `hooks/useNotifications.ts` React Query hooks (badge poller 30s, list refetch only when dropdown open, optimistic mark-read); `components/dashboard/NotificationsDropdown.tsx` mounted into `Navbar.tsx`.
- Live-verify: SQL-insert row → `GET /unread/count` reads the new row; POST `:id/read` flips read_at; `mark-all` zeros the badge. Worker-dispatched action — InApp provider persisted a real `notification_inbox` row, `external_receipt: {"receiptId":"inapp:<uuid>"}`.

## Phase 6.5 — FE combined rule-body + writeback/side-effect builder

- FE state: `WebhookActionBuilderState` gains `embeddedRuleBody: ObjectActionBuilderState | undefined` so the same dialog state captures BOTH the webhook binding AND a writeback-side object rule body.
- FE adapter: `app/ontology-manager/(manager)/_components/actionBuilders/gateAdapter.ts` — `validate` removed the Phase-4/Phase-5 persistence gate; serialiser delegates `parameters + rules` to the inner object adapter via `serializeActionBuilderState(embeddedRuleBody, ...)` + adds `writebackConfig`. One save → both halves persisted via POST /actionTypes. Side-effect binding mode stays gated with a clear FE-serialiser-follow-on message.
- FE UI: `WebhookActionTypeTab.tsx` adds `EmbeddedObjectRuleBodyPicker` (object-type HTMLSelect + action RadioGroup) under the webhook card preview; `ActionTypeDialog.tsx`'s `webhookTabNode` threads the existing `objectTypes` list into the new tab props.
- FE tests: 4 new `actionBuilders.test.ts` tests cover the gate-removed writeback path + the still-gated side-effect path + the serialise path's reachability. Total FE unit: 37 / 2 files.

## Phase 6.5+ follow-on — outgoing work

- FE side-effect binding mode serialiser (emits `side_effects: { webhooks, notifications }` shape that the BE already persists). Picker preserves the selection; the follow-on flips the side-effect gate off.
- Native SMTP transport via nodemailer (one-file additive after `npm install nodemailer`).
- OpenTelemetry spans around the actionExecutor stages 1-9 (Phase 6.3 ships the worker's `runOnce` span).
- Operator UI for the side-effect outbox dead-letter queue + manual `requeueDeadSideEffectJob` button.
- Per-rule server-side authorization for the actor's "CRUD on every modified object type" derived from the rule body — requires the `object_type → dataset_id` model-layer migration first.

## Phase 5 + 6 close-out reports

- Phase 5: `docs/phase5-durable-side-effect-outbox.md`
- Phase 6: `docs/phase6-server-side-authorization-versioning-observability.md` + `docs/phase6-manual-scenarios-AH.md`

## What NOT to touch (without talking to the human first)

- `src/server.ts` — boot orchestration is fragile; the order of worker spawn / Temporal / Kafka / overlay / Iceberg matters.
- `src/services/codeRepository/transforms/buildService.ts` — known pre-existing error unrelated to the action-type work.
- Migrations 127–132 are live and applied; their `.down.sql` siblings exist but DO NOT run as part of the action-type work.
