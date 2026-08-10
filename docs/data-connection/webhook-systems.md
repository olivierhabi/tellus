# Webhook Systems — Architecture & Consolidation Plan (F9)

> Status: **living doc**. This is the single source of truth for the three
> webhook / notification systems that coexist in Tellus and the plan to
> consolidate them on the canonical connectivity engine.

## TL;DR

There are **three** webhook / writeback systems in the codebase today. Two are
legacy and **deprecated**; new bindings MUST use System A. The routing layer
in `src/services/connectivity/webhooks/router.ts` is the single classification
seam that directs every webhook execution through System A when the ref is a
connectivity RID, and emits a deprecation warning before falling back to the
legacy paths (B/C) for bindings authored before the connectivity wiring.

| ID | System | Scope | Transport | Status |
|----|--------|-------|-----------|--------|
| A  | Connectivity webhooks | source-scoped (REST API) | `executeWebhook` (`webhooks/executor.ts`) — vault-resolved secrets, SSRF/DNS-pinned egress, retries, idempotency, recorded executions, audit trail | **Canonical** |
| B  | Ontology-scoped registry | ontology action side-effects | `actionSideEffectJob` + `sideEffectWorker.ts` → `deliverOneWebhook` (legacy `webhook_definition` registry) | **Deprecated** (F9) |
| C  | Inline-URL writeback | action pre-commit writeback | `writebackExecutor.ts` Phase-4 direct-HTTP path (legacy `webhook_definition` name) | **Deprecated** (F9) |

## System A — Canonical connectivity webhooks

- **Contracts:** `src/services/connectivity/webhooks/contracts.ts`
- **Executor:** `src/services/connectivity/webhooks/executor.ts` (`executeWebhook`)
- **Repository:** `src/services/connectivity/webhooks/repository.ts`
- **Handlers:** `src/services/connectivity/webhooks/handlers.ts`
- **Router mount:** `src/services/connectivity/index.ts` (lines 155–186)
- **DB:** `migrations/135_connectivity_webhooks.sql`

A connectivity webhook is a source-scoped resource (`ri.magritte.main.webhook.<uuid>`)
bound to a REST-API connection. It inherits the connection's domains, egress
policy, and credential vault; retains an immutable version history; and has
an independently managed activation lifecycle
(`draft → ready → active → disabled → archived`).

Execution (`POST /webhooks/:rid/execute` and the side-effect outbox) runs
`executeWebhook`, which: resolves source secrets from the vault → for each
call: egress allowlist + DNS pin + SSRF guards → renders templates → optional
HMAC-SHA256 signing → send with retries → record redacted
`connectivity_webhook_delivery_attempt` → extract outputs →
`completeExecution`. Every direct egress is recorded to
`connectivity_egress_audit_log` (F7).

## System B — Ontology-scoped registry (DEPRECATED)

- **Model:** `src/models/webhookDefinition.ts`
- **Routes:** `src/routes/webhooks.ts`
- **Mount:** `src/server.ts`
- **DB:** `migrations/129_webhook_definition.sql`
- **Consumers:** `writebackExecutor.ts` (fallback branch), `actionTypes.ts`
  (save-time validation), `sideEffectWorker.ts` (legacy `deliverOneWebhook`)

System B is the legacy ontology-scoped webhook registry. A binding authored
with a non-RID `webhookId` (anything not starting with
`ri.magritte.main.webhook.`) silently falls into this path with placeholder
`Authorization: Bearer <secret:...>` and would never authenticate against a
real external system.

**Deprecation:** `sideEffectWorker.ts`'s non-connectivity branch and
`writebackExecutor.ts`'s Phase-4 direct-HTTP path emit a runtime deprecation
warning on every dispatch. New bindings MUST use a connectivity webhook RID.
System B is slated for removal once all bindings are migrated to System A.

## System C — Inline-URL writeback (DEPRECATED)

- **Parser:** `src/actions/actionWebhooks.ts`
- **Sync delivery:** `src/actions/actionWebhooks.ts` (`deliverOneWebhook`)
- **Caller:** `src/actions/actionExecutor.ts` (Stage 7 fire-and-forget)
- **Outbox dispatch:** `src/services/workers/sideEffectWorker.ts`
- **Persistence:** `src/models/actionSideEffectJob.ts` +
  `migrations/131_side_effect_outbox.sql`

System C is the legacy inline-URL action side-effect path: an action type
carries a raw `{ url, method, headers }` spec and the side-effect worker
fire-and-forgets an HTTP POST. It shares the egress guard with System A
(`webhookSafeTransport`) but has none of System A's vault-resolved secrets,
immutable versioning, idempotency, or recorded-execution semantics.

**Deprecation:** the inline-URL branch in `sideEffectWorker.ts` emits a
runtime deprecation warning. New action side-effects MUST bind a connectivity
webhook RID (`payload.spec.kind === "connectivity"`).

## Shared transport

`src/services/webhookSafeTransport.ts` is the shared SSRF + body-cap +
content-type guard used by both System A (`executor.ts`) and the legacy
System B/C paths (`writebackExecutor.ts`, `actionWebhooks.ts`).

## Bridges

- **A ↔ B:** `isConnectivityWebhookRef` (prefix check on
  `ri.magritte.main.webhook.`) in `writebackExecutor.ts` — a connectivity RID
  dispatches to `executeConnectivityWriteback` (System A); anything else falls
  to the legacy registry (System B).
- **A ↔ C:** `payload.spec.kind === "connectivity"` in
  `sideEffectWorker.ts` — a side-effect job whose spec is `connectivity`
  dispatches to `executeWebhook` (System A); anything else falls to
  `deliverOneWebhook` (System C).

## Routing layer (F9)

`src/services/connectivity/webhooks/router.ts` is the single classification
seam. `dispatchWebhookRef()`:

1. If the ref is a connectivity RID → execute via System A (`executeWebhook`).
2. Else → emit a deprecation warning and delegate to the legacy path (System
   B/C). The legacy path is the existing `writebackExecutor` /
   `sideEffectWorker` branch — the router does NOT silently rewrite a legacy
   binding into a connectivity binding (that would change authentication);
   it only documents + warns.

The router is the place future consolidation work centralizes: once System
B/C are removed, the router collapses to a direct `executeWebhook` call.

## Migration plan (out of this engagement)

1. Add the routing layer + deprecation warnings (this change).
2. Surface the deprecation warnings in operator dashboards; track the count
   of legacy dispatches per tenant.
3. Provide a one-shot migration tool that converts a System B `webhook_definition`
   row into a System A connectivity webhook + rewrites the binding's
   `webhookId` to the new RID.
4. Remove System B (`webhookDefinition.ts`, `routes/webhooks.ts`) and the
   System C inline-URL branch once the legacy dispatch count is zero.
