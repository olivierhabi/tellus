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

## Phase 6.6 — webhook binding wired to the REAL data-connection webhooks

The Action Type webhook tab no longer reads the Phase-3 ontology webhook registry (`webhook_definition`); it lists and binds REAL data-connection webhooks (connectivity engine) end-to-end.

- Binding model: `writeback_config.webhookId` is dual-typed. `ri.magritte.main.webhook.<uuid>` → resolved against the connectivity webhook store (canonical); anything else → legacy `webhook_definition` name (backward compat). `CONNECTIVITY_WEBHOOK_RID_PREFIX` / `isConnectivityWebhookRef` live in `src/actions/writebackExecutor.ts`.
- FE data source: `hooks/useConnectionWebhooks.ts` — pages all connections (200/page), keeps `rest-api` sources, fans out `webhooksApi.list` per source, flattens into the `BindableWebhook` view-model (`lib/data-connection/webhooks.ts#toBindableWebhook`). Registry client REMOVED from FE (`useWebhooks`, `listWebhooks`/`getWebhookLatest`/`createWebhook` + registry `WebhookDefinition` types in `lib/ontologyApi.ts`).
- FE picker/dialog: `WebhookPicker` is rid-keyed with the 7-state connectivity lifecycle; `WebhookActionBuilderState.webhookName` → `webhookRid`; adapter serialises `writebackConfig.webhookId = <rid>`.
- BE save-time: `validateWritebackConfig(wb, ontologyId, paramNames, tenant)` — connectivity refs resolve the pinned version via `webhooks/repository.getByRid`, reject `disabled`/`archived`/`failed`, and validate input mappings against the webhook's DECLARED inputs (replaces the registry-era "≥1 input" rule for connectivity refs; zero-input webhooks are valid).
- BE execution: `executeWriteback` branches on the RID prefix → `executeConnectivityWriteback` resolves pinned webhook + parent connection and delegates to the connectivity engine `executeWebhook(kind: "production")` (vault secrets, SSRF/DNS pinning, retries, idempotency replay, recorded executions). Engine-extracted `outputSummary` IS the `writebackResponse` outputs map; registry-era `outputBindings` are ignored on this path. `REQUEST_TIMEOUT` → `WRITEBACK_TIMEOUT`; other non-succeeded → `WRITEBACK_REJECTED`.
- Tenant threading: `utils/requestTenant.ts#resolveRequestTenant` (non-throwing, same fallback chain as connectivity `extractUser`, default "default") → `ExecutionContext.tenant` → `runWritebackStage` → `WritebackExecutionContext.tenant`. Wired in `routes/actions.ts` (3 execute contexts) + `routes/bulkActions.ts`.
- Tests: 7 new connectivity-path tests in `tests/unit/actions/writebackExecutor-unit.test.ts` (27 total in file; 524 BE unit green). FE `actionBuilders.test.ts` webhook ctx switched to rid-based entries.

## Phase 7 — OSS v2 / OSv2 / OMS v2 canonical ObjectSet engine

- Contract source: `@osdk/foundry.ontologies@2.69.0` (api-gateway 1.1709.0). The dead B10 prototype's invented operators (`notIn`/`endsWith`) do NOT exist in v2 and are never exposed on the v2 surface.
- Canonical engine in `src/services/oss/`: `objectSetDefinition.ts` (zod; 14 verified ObjectSet nodes + 27 SearchJsonQueryV2 ops + AggregationV2/GroupByV2 + limits), `objectSetCompiler.ts` (set algebra → typed per-objectType plans; same-type folds via and/or/not; cross-type fans out; `relativeDateRange` compiles to ABSOLUTE bounds at compile time), `objectSetExecutor.ts` (injected deps; cross-type deterministic merge; derived properties), `aggregationV2.ts` (accuracy gate: REQUIRE_ACCURATE + truncation → `AggregationAccuracyNotSupported`), `pageTokenV2.ts` (HMAC-signed, binds ontology+branch+fingerprint; secret `TELLUS_PAGE_TOKEN_SECRET`), `objectSetStore.ts` (saved = `ri.object-set.main.versioned-object-set.<uuid>` via Compass resources; temporary = Redis overlay store, TTL 1h, tenant+ontology scoped), `subscriptionRegistry.ts` (object_set.changed → per-subscription in-memory re-evaluation; `TELLUS_MAX_OBJECTSET_SUBSCRIPTIONS` default 100), `omsV2Mapper.ts`, `productionDeps.ts`, `v2Errors.ts`.
- Object identity: migration `138_object_rids.sql` adds `object_instances.rid` (`ri.tellus.main.object.<uuid>` — Palantir object-rid prefix is not publicly documented, Tellus namespace by contract); `__rid` stamped in indexer/reindexService/editApplicator/writebackOverlay UPSERT; `__apiName` + `excludeRid` in `objectResponseFormatter.ts`.
- v2 routes (thin adapters, mounted in server.ts): `routes/v2/objectSetsV2.ts` (loadObjects, loadMultipleObjectTypes, aggregate, createTemporary), `objectsV2.ts` (list/search/get), `linksV2.ts`, `actionsV2.ts` (apply/applyBatch + `options.mode=VALIDATE_ONLY` executor short-circuit after Stage 3 + `returnEdits`), `omsV2.ts` (objectTypes/linkTypes/actionTypes/interfaceTypes).
- Security: all v2 reads pass through the ONE choke point (`injectSecurityFilter` in `productionDeps.search`); get-object stays fail-closed via `executeGetObject`.
- Filters: Phase 6 extended the ONE internal language (`queryTranslator.ts`/`queryValidator.ts`/`constants.ts`) with containsAllTerms/containsAnyTerm/containsAllTermsInOrder(+PrefixLastTerm)/wildcard/regex/interval/geo-six. `nearestNeighbors` is an ObjectSet node, never a filter; text-embedding queries fail typed (`NearestNeighborsTextNotConfigured`).
- OSDK generator emits additive `clientV2.ts` (object-set-based calls); v1 files unchanged.
- Tests: `tests/unit/services/oss-*-unit.test.ts` (64 tests). Scoped unit suite 601 green; `npx tsc --noEmit` clean.

## Phase 6.5+ follow-on — outgoing work

- FE side-effect binding mode serialiser (emits `side_effects: { webhooks, notifications }` shape that the BE already persists). Picker preserves the selection; the follow-on flips the side-effect gate off.
- ~~FE webhook input-mapping authoring UI~~ — SHIPPED: `WebhookInputsSection` in `WebhookActionTypeTab.tsx` maps every declared webhook input to a `parameter` / `static` value source; `WebhookActionBuilderState.inputMappings` persists into `writeback_config.inputs`; static values coerced to the declared scalar kind at serialise time.
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
