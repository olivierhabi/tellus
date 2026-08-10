# ADR — Deprecate the legacy (ontology-registry) webhook engine; consolidate on connectivity

Date: 2026-08-07
Status: **Draft — not for commit, pending prod audit + owner review.**

Scope: backend. Legacy route, executor branch, and `webhook_definitions` table
live in `tellus`; FE rollout is a downstream consequence, not a separate decision.

## Context

Two webhook engines coexist; `writebackExecutor.ts` branches on the webhook id
prefix. **Legacy / ontology-registry ("Phase 4")** — `POST /api/v1/ontology/:ont/webhooks`
(`webhooks.ts`), name-keyed + explicit `webhookVersion`, `webhook_definitions`
table, executed by the registry-era branch of `executeWriteback`. **Connectivity
/ data-connection** — `POST /api/v1/connectivity/connections/:rid/webhooks`,
RID-keyed (`ri.magritte.main.webhook.…`), executed by `executeConnectivityWriteback`
→ the connectivity engine. The code self-documents the latter as "the REAL
webhook implementation."

They have already diverged in five load-bearing ways (each observed during the
Webhook Action Enablement work, `playwright/data-connection/webhook-action-enablement.spec.ts`):
(1) **Secrets aren't real on legacy** — `writebackExecutor.ts:319` sends
`Authorization: Bearer <secret:<kind>/<ref>>`, the secret NAME placeholder, not
the value (see `docs/secret-name-leak-legacy-writeback-draft.md`); connectivity
resolves via the vault (`resolveSourceSecrets`). (2) **No audit/retry/idempotency/signing
on legacy** — connectivity records `…_execution`/`_delivery_attempt`, dedupes,
HMAC-signs, retries. (3) **Two lifecycle enums / two refusal rules** — legacy
`{draft,active,disabled}` refuses only `disabled`; connectivity refuses
anything `!== "active"`. (4) **Two egress surfaces** — legacy env-driven
`buildEgressPolicy()`; connectivity hardcodes `httpsRequired` + resolves URL
from the connection's rest domain. (5) **Two authoring surfaces**.

Dev-DB audit (2026-08-07, de-noised for e2e fixtures): 357 action types; 333 no
writeback; 9 connectivity-bound; **1 real legacy binding** (`wbActionGood →
NotifySlackR3`, active). Dev DB is not authoritative.

## Decisions (numbers TBD at acceptance)

- **Connectivity is the single first-class engine.** No new feature work on
  legacy; legacy bug fixes limited to security/data-loss and mirrored to
  connectivity where the same defect exists.
- **Block new legacy creates** behind `TELLUS_BLOCK_LEGACY_WEBHOOK_CREATE=1`
  (default off): `POST …/webhooks` returns 410 `WEBHOOK_REGISTRY_DEPRECATED`;
  `validateWritebackConfig` rejects new action-type creates whose
  `writebackConfig.webhookId` is a non-`ri.magritte.main.webhook.` reference.
  Reads + status-only PATCH remain for the window.
- **One-shot migrator** `src/migrations/webhookRegistryToConnectivity.ts`
  (idempotent, `--dry-run`/`--apply`): for each `webhook_definitions` row,
  materialize a connection (from `endpoint_config.url`'s host) + connectivity
  webhook (status mapped), then rebind `action_types.writeback_config` name→RID.
  Persist `legacy_webhook_migration` for rollback.
- **Delete legacy after a release cycle at zero bindings**, CI-guarded by
  `scripts/check-no-legacy-bindings.ts`: drop `webhooks.ts` route, the legacy
  branch of `executeWriteback`, the `webhook_definitions` table, the legacy
  branch of `validateWritebackConfig`. Each step a separate revertible PR.

## Consequences

(+) Single execution path with real secrets, retry, idempotency, signing,
per-attempt audit; closes the secret-name leak; one egress/SSRF surface; one
lifecycle enum; Foundry parity. (−) Migration cost (the 1 dev binding is
small; prod may be larger — see Blocked on). (−) `writeback_config.outputBindings`
(JSONPointer) is legacy-only and cannot auto-convert — connectivity uses
`configuration.outputs` selectors; any binding using `outputBindings` blocks the
migrator's `--apply` until its outputs are redeclared. FE: the Workshop +
Ontology-Manager "Logic" pickers stop offering the legacy registry once the
flag is on; the apply path is webhook-system-agnostic (no FE change).

## Alternatives considered

Keep both indefinitely (rejected: placeholder-auth + missing audit are
liability, not a feature; 5 divergences are load-bearing maintenance). Big-bang
delete (rejected: breaks existing bindings at apply time). Internally reroute
the legacy branch to the connectivity engine (rejected: keeps divergent
storage/lifecycle, only hides it). Reverse direction (rejected: connectivity
has every production semantic the registry lacks).

## Blocked on

- [ ] **Staging/prod binding audit.** Dev shows 1 real legacy binding
      (`wbActionGood → NotifySlackR3`); staging/prod may have more. The
      migrator size and the Phase-1 flag flip both depend on this count.
- [ ] **`outputBindings` usage audit on prod legacy bindings.** Any binding
      using the legacy-only JSONPointer `outputBindings` blocks the migrator's
      `--apply` until its outputs are redeclared as connectivity
      `configuration.outputs`. `wbActionGood`/`NotifySlackR3` has none; a prod
      binding that does would block.
- [ ] **Webhook/ontology contract-owner sign-off.** This crosses the
      action-type binding contract (user-authored data) and the
      `writeback_config` shape; not a unilateral call. Sign-off should also
      confirm ownership of the legacy-branch secret resolver (currently an
      unowned aspiration — see `docs/secret-name-leak-legacy-writeback-draft.md`).
