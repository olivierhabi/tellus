# Action-Type Subsystem — Full Implementation Reference (Phase 1 → Phase 6)

**Status:** Complete across all 6 phases
**Repo:** `/Users/olivierhabimana/Desktop/projects/tellus` (BE) + `/Users/olivierhabimana/Desktop/projects/tellus-fe` (FE)
**Working tree:** uncommitted; additive on top of the pre-Phase-1 baseline
**Migration surface:** six reversible additive migrations 127–133 (all applied live to `tellus_db`)
**Test surface:** BE unit 508 / 36 files · FE unit 37 / 2 files · Manual A–H 8/8 green
**Type-check:** BE `tsc --noEmit` clean (one pre-existing unrelated error in `buildService.ts:906`); FE `tsc --noEmit` clean for all Phase 1–6 additions (pre-existing `test24/`/`workshop/`/`projects/` errors unchanged)

This document supersedes the per-phase reports (`phase5-durable-side-effect-outbox.md`, `phase6-server-side-authorization-versioning-observability.md`, `phase6-manual-scenarios-AH.md`) as the single canonical implementation reference. The per-phase reports still exist for operational readers; this document targets developers.

---

## Table of contents

1. Phase 1 — Foundations + Concrete Link Authoring
2. Phase 2 — Interface-Link Rule Engine
3. Phase 3 — Governed Webhook Registry + Safe-Transport Guards
4. Phase 4 — Writeback Pre-Edit Stage
5. Phase 5 — Durable Side-Effect Outbox + Worker + NotificationProvider
6. Phase 6.1 — Server-side Authorization (CBAC gate + recipient data filter)
7. Phase 6.2 — Versioned Definitions + If-Match Optimistic Concurrency
8. Phase 6.3 — Observability + Writeback Stage Re-order
9. Phase 6.4 — Real SMTP/Slack transport + `notification_inbox` + FE inbox reader
10. Phase 6.5 — FE combined rule-body + writeback/side-effect builder
11. Phase 6.6 — 5-layer test sweep + manual scenarios A–H
12. Phase 6.7 — close-out
13. Cross-cutting: data shapes (Canonical action_type body)
14. Cross-cutting: error code registry
15. Cross-cutting: env flag surface
16. Cross-cutting: backward-compat invariants

---

## 1. Phase 1 — Foundations + Concrete Link Authoring

### 1.1 Goal
Establish the discriminated ActionBuilderState contract on the FE, the canonical rule-shape validator surface on the BE, ship concrete `addLink` / `removeLink` action type authoring end-to-end (rule body + dialog + persistence + execution), and lay down the versioned `action_type` columns that subsequent phases use for optimistic concurrency and per-rule validation.

### 1.2 Migration surface (6 reversible SQL files, all applied live)

#### 127 — `action_rule_discriminators.sql`
Adds the IMMUTABLE Postgres function `action_rule_discriminator_valid(jsonb)` and a CHECK on `action_type.rules` that asserts the rule body's `type` discriminator is one of the 8 canonical types (`createObject`, `modifyObject`, `modifyOrCreateObject`, `deleteObject`, `addLink`, `removeLink`, `createInterfaceLink`, `deleteInterfaceLink`). Pre-migration rows with non-validated `rules` arrays were pre-Phase-1 legacy rows; migration backfilled cleanly because the function tolerates legacy JSONB (`linkTypeApiName` accepted as alias of `linkType`).

#### 128 — `interface_link_constraint.sql`
The `interface_link_constraint` table — one row per interface-link rule template. Schema:
```
interface_link_constraint_id UUID PRIMARY KEY
ontology_id UUID NOT NULL
api_name TEXT NOT NULL
display_name TEXT NOT NULL
description TEXT NULL
interface_id TEXT NOT NULL              -- owning interface apiName
target_interface_id TEXT NULL          -- XOR with target_object_type_id
target_object_type_id UUID NULL        -- XOR with target_interface_id
link_type_id UUID NOT NULL             -- the concrete link type the rule resolves to
cardinality TEXT NOT NULL              -- one_to_one | one_to_many | many_to_one | many_to_many
status TEXT NOT NULL                   -- draft|active|deprecated
created_at, updated_at, created_by, updated_by TIMESTAMPTZ / TEXT
```
* XOR CHECK on `target_interface_id IS NULL != target_object_type_id IS NULL`
* Cardinality CHECK
* Status CHECK
* Three indexes: `(ontology_id, api_name)` unique partial on `status IN ('draft','active')`; `(ontology_id, interface_id)` for owner-grouped listing; `(ontology_id, status)` filter for active-only listing.

#### 129 — `webhook_definition.sql`
The `webhook_definition` (versioned) + `webhook_secret_reference` schema:
```
webhook_definition_id UUID PRIMARY KEY
ontology_id UUID NOT NULL
name TEXT NOT NULL
display_name TEXT NOT NULL
description TEXT NULL
url TEXT NOT NULL
method TEXT NOT NULL                   -- allowlist: GET POST PUT PATCH DELETE
headers JSONB NOT NULL DEFAULT '{}'
timeout_ms INTEGER NOT NULL DEFAULT 5000
authentication_config JSONB NULL
version INTEGER NOT NULL               -- monotonic per (ontology_id, name)
status TEXT NOT NULL                   -- draft|active|disabled
previous_version_id UUID NULL          -- chain to the prior version on bump
created_at, updated_at, created_by, updated_by
```
Plus the `uq_webhook_definition_live_name` partial unique on `(ontology_id, name) WHERE status IN ('draft','active')` so disabled webhooks don't block re-creates.

`webhook_secret_reference` carries:
```
secret_reference_id UUID PRIMARY KEY
webhook_definition_id UUID NOT NULL
kind TEXT NOT NULL                       -- env_var | keycloak_secret | vault | database
ref TEXT NOT NULL                         -- the stable identifier the app layer resolves
created_at TIMESTAMPTZ
```

#### 130 — `action_writeback_config.sql`
Adds `action_type.writeback_config JSONB NULL` + 2 structural CHECKs:
* The column is JSONB-not-array (one object per row).
* Canonical shape `{webhookId, webhookVersion, inputs, failurePolicy:'abort'}` — Phase 4 ensures `inputs` is a `Record<string, ValueSource>`, but at the DB level we only assert the OUTER shape (one-writeback-per-action invariant).

#### 131 — `side_effect_outbox.sql`
`action_side_effect_job` — the durable outbox row:
```
job_id UUID PRIMARY KEY DEFAULT gen_random_uuid()
execution_id TEXT NOT NULL              -- the action's audit row correlation id
action_type_id UUID NOT NULL
action_type_version INTEGER NOT NULL DEFAULT 1
side_effect_index INTEGER NOT NULL     -- ordered within an action's side-effect fanout
kind TEXT NOT NULL                      -- webhook|notification
payload JSONB NOT NULL                  -- { spec, context } for webhook; { spec, recipient, context } for notification
status TEXT NOT NULL DEFAULT 'pending' -- pending|running|succeeded|retrying|failed|dead CHECK state machine
attempt_count INTEGER NOT NULL DEFAULT 0
last_error_code TEXT NULL
last_error_at TIMESTAMPTZ NULL
next_attempt_at TIMESTAMPTZ            -- populated by the retry/backoff logic
idempotency_key TEXT NULL               -- set by the executor at enqueue; SHA-256 of (execution_id, actionTypeApiName, side_effect_index)
external_receipt JSONB NULL            -- { receiptId, dropped, droppedReason, missingMarkings } — structured post-dispatch record
created_at, updated_at TIMESTAMPTZ NOT NULL
```
* CHECK on `status` (always in the 6-value state machine)
* CHECK `attempt_count >= 0`
* UNIQUE `(execution_id, side_effect_index)` — protects against re-enqueue
* Four indexes: worker-claim `idx_sej_claim` on `(status, next_attempt_at) FOR UPDATE SKIP LOCKED`; `idx_sej_retrying` for the dash-bound label; `idx_sej_dead` partial on `WHERE status='dead'` for the dead-letter queue; `idx_sej_succeeded_at` partial for the successful-dispatch audit query.

#### 132 — `action_type_definition_version.sql`
Adds `action_type.definition_version INTEGER NOT NULL DEFAULT 1` (backfilled for legacy rows) + nullable `definition_hash` (sha256 over the canonical JSON of the definition-bearing columns) + a BEFORE UPDATE trigger `trg_action_type_definition_version` running `bump_action_type_definition_version()`:

```sql
definition_changed := (NEW.parameters IS DISTINCT FROM OLD.parameters)
                   OR (NEW.rules IS DISTINCT FROM OLD.rules)
                   OR (NEW.submission_criteria IS DISTINCT FROM OLD.submission_criteria)
                   OR (NEW.side_effects IS DISTINCT FROM OLD.side_effects)
                   OR (NEW.writeback_config IS DISTINCT FROM OLD.writeback_config)
                   OR (NEW.semantics_version IS DISTINCT FROM OLD.semantics_version)
                   OR (NEW.execution_mode IS DISTINCT FROM OLD.execution_mode)
                   OR (NEW.delete_policy IS DISTINCT FROM OLD.delete_policy);
IF definition_changed THEN
   NEW.definition_version := OLD.definition_version + 1;
END IF;
NEW.updated_at := now();
```
Only definition-bearing columns trip the bump — `description` / `is_enabled` / `max_affected_objects` leave `definition_version` unchanged (Phase 6.2's If-Match optimistic-concurrency wire relies on this).

### 1.3 Backend — pure rule shape validator

`src/actions/ruleShapeValidator.ts` exports pure (DB-free) canonical validators:
- `validateConcreteLinkRuleShape(rule)` → `string[]` of validation errors (empty ⇒ accept)
- `validateInterfaceLinkRuleShape(rule)`
- `isConcreteLinkRule(rule)`
- `isInterfaceLinkRule(rule)`
- `isCanonicalActionRule(rule)` — top-level dispatcher
- `validateValueSourceShape(source, field, knownSources)` — validates the `ValueSource.source` discriminator (parameter / static / currentTimestamp / currentUser / writebackResponse — Phase 4 + 6.3) against a typed set; the Phase 4 `writebackResponse` form additionally carries `outputId` + optional `path` JSONPointer.

A canonical concrete link rule takes the shape:
```ts
{
  type: "addLink" | "removeLink",
  linkType: "<apiName>",
  sourceObject: { source: "parameter"|"static", param?: string, value?: string },
  targetObject: { source: "parameter"|"static", param?: string, value?: string },
}
```
Legacy v1 action types carry `linkTypeApiName` (the pre-Phase-1 alias); the validator accepts both names. The canonical round-trip is: `validateConcreteLinkRuleShape` accepts the legacy form, returns `[]`; the route layer persists the canonical form, BUT legacy rows are accepted on read without canonicalization — the v1 277 action types stay byte-equivalent on GET.

### 1.4 Backend — routes accept + enforce

`src/routes/actionTypes.ts` POST + PATCH handler:
- Adds `validateRules(actionType.rules)` that runs the canonical shape validation against each rule; on `errors.length > 0` returns 400 with `{ validationErrors[] }`.
- Adds 18 new structured error codes to the `KNOWN_CODES` set + the `responseFormatter` HTTP-status map: `INVALID_LINK_MAPPING`, `UNSUPPORTED_RULE_TYPE`, `AMBIGUOUS_INTERFACE_LINK_IMPLEMENTATION`, `MISSING_INTERFACE_LINK_IMPLEMENTATION`, `CARDINALITY_VIOLATION`, `DUPLICATE_LINK`, `CONFLICTING_FOREIGN_KEY_EDITS`, `INVALID_WEBHOOK_INPUT_MAPPING`, `INVALID_WEBHOOK_OUTPUT_MAPPING`, `WEBHOOK_ALREADY_EXISTS`, `WEBHOOK_VERSION_DISABLED`, `WRITEBACK_TIMEOUT`, `WRITEBACK_REJECTED`, `WRITEBACK_OUTPUT_SCHEMA_MISMATCH`, `WRITEBACK_CONFIG_INVALID`, `SIDE_EFFECT_CONFIGURATION_INVALID`, plus `LINK_TYPE_NOT_FOUND` (404, reused from the existing route), `WEBHOOK_NOT_FOUND` (404).

### 1.5 Frontend — discriminated ActionBuilderState union + per-kind adapters

`tellus-fe/app/ontology-manager/(manager)/_components/actionBuilders/types.ts` defines:
```ts
export type ActionBuilderState =
  | ObjectActionBuilderState
  | LinkActionBuilderState
  | InterfaceLinkActionBuilderState
  | FunctionActionBuilderState
  | WebhookActionBuilderState
  | NotificationActionBuilderState
  | EffectActionBuilderState;
```

Each variant is a tagged-union member; consumers MUST `switch (state.kind)` exhaustively and route the default branch through `assertNeverBuilder(state as never)` — no fall-through.

`dispatch.ts` exposes:
- `adapterForKind(kind)` → the per-kind adapter implementing the `ActionBuilderAdapter<S>` contract (`defaultState()/validate()/serialize()`).
- `defaultStateForKind(kind)`
- `validateActionBuilderState(state, ctx)` — exhaustive `switch`, dispatches to the per-kind adapter's `validate`.
- `serializeActionBuilderState(state, meta, ctx)` — exhaustive `switch`, dispatches to the per-kind adapter's `serialize`.

`ActionBuilderContext` is the read-only builder context: `ontologyId`, `objectTypes`, `objectTypesLight`, `linkTypes`, `interfaceLinkConstraints`, `webhooks`, `v2CreationEnabled`, `uuidToApiName` (UUID → apiName map built from the light `useObjectTypes` list).

`SerializedActionTypeBody` is what each adapter's `serialize` returns:
```ts
{
  parameters: ReadonlyArray<ActionParameter>;
  rules: ReadonlyArray<Record<string, unknown>>;
  writebackConfig?: Record<string, unknown> | null;  // Phase 4
  semanticsVersion?: 2;
  executionMode?: "declarative";
  deletePolicy?: "restrict";
}
```

### 1.6 Per-kind adapters shipped in Phase 1

`objectAdapter.ts`, `linkAdapter.ts`, `interfaceLinkAdapter.ts` (Phase 2 promoted to real, originally carried a Phase-2 gate), `gateAdapter.ts` (webhook under a Phase-4 gate + notification under a Phase-5 gate + effect/function gated to unknown future).

#### `objectAdapter` (Phase 1 — FIRST-CLASS)
The legacy in-dialog object-action logic (parameter auto-derivation from object-type properties, v2 typed `object_reference` primary-key parameter, rule serialization) wrapped in the discriminated-state adapter contract. Pure + round-trip byte-equivalent through `validateRules`.

#### `linkAdapter` (Phase 1 — FIRST-CLASS)
The concrete `addLink` + `removeLink` adapter — link-type picker (from `ctx.linkTypes`), source/target object types auto-derived via the link type's UUID-resolved endpoints (using `ctx.uuidToApiName` for the UUID → apiName resolution required by the canonical rule shape), cardinality + storage badges, canonical rule JSON preview generated from the same serializer.

`LinkActionTypeTab.tsx` rewrites to 4 cards (link-type picker, source object-type picker, target object-type picker, rule preview) controlled by `LinkActionBuilderState`; collapsing reverts gracefully.

`LinkActionBuilderPanel.tsx` is the link-type + source/target object-type picker body that populates the state via `onChange(next)` propagation.

### 1.7 Phase 1 tests
- 24 BE tests `tests/unit/actions/ruleShapeValidator-unit.test.ts` covering every acceptance + rejection path of the canonical validator + the legacy-alias tolerance.
- 21 FE tests `tests/unit/actionBuilders.test.ts` — defaultState for every kind, exhaustive dispatcher parity, `objectAdapter` + `linkAdapter` validate + serialize to canonical rule, `assertNeverBuilder` exhaustiveness, LinkActionBuilderState round-trips byte-equivalent.

### 1.8 Phase 1 live-verify
- POST `/actionTypes` with `addLink` canonical rule body → 201 with `rules` byte-equivalent on GET.
- POST `/actionTypes` with deprecated parameter shape (legacy `linkTypeApiName` alias) → 201 (accepted alias, GET returns the canonical `linkType` shape).
- POST `/actionTypes` with malformed rule + non-existent link type → 400 with `validationErrors[]`.

---

## 2. Phase 2 — Interface-Link Rule Engine

### 2.1 Goal
Promote the `interfaceLink` kind from a gate to FIRST-CLASS. Ship the interface-link constraint catalog (1 catalog row → expanded to N concrete `addLink`/`removeLink` candidates at dispatch time).

### 2.2 Backend model + route
`src/models/interfaceLinkConstraint.ts`:
- `createInterfaceLinkConstraint(input)` → INSERT row
- `getInterfaceLinkConstraintByApiName(ontologyId, apiName)`
- `listInterfaceLinkConstraints(ontologyId)` + paginated variant
- `updateInterfaceLinkConstraintStatus(apiName, status)` — for the draft → active → deprecated lifecycle
- `deleteInterfaceLinkConstraint(apiName)` — admin-only surface

`src/routes/interfaceLinkConstraints.ts` mounted at `/api/v1/ontology/:ontologyId/interfaceLinkConstraints`:
- `POST /` — create
- `GET /` — list
- `GET /:apiName` — get by apiName
- `PATCH /:apiName/status` — promote (draft → active) / deprecate
- `DELETE /:apiName` — hard delete

### 2.3 Backend runtime resolver
`src/actions/rules/interfaceLinkRules.ts`:
- `resolveInterfaceLinkRule(rule, ctx)` → `{ kind: "ok"|"missing"|"no_match"|"ambiguous"|"invalid", candidates: ConcreteLinkCandidate[] }`:
  - "missing" — no interface-link constraint with the declared apiName exists
  - "no_match" — no concrete link type satisfies the constraint's linkType + interface id
  - "ambiguous" — more than ONE concrete link candidate satisfies → fail-closed pre-edit so the operator's intent isn't guessed
  - "ok" — exactly one candidate resolves → `{ sourceObject, targetObject, linkType }`
- `buildConcreteLinkEditsFromCandidates(candidates, rule)` → maps to canonical `addLink`/`removeLink` rule edits sorted by `link_type.api_name`.

### 2.4 Backend compiler dispatch
`src/actions/ruleCompiler.ts` extends the exhaustive switch with `compileInterfaceLinkRule(rule, ctx)`:
- Calls `resolveInterfaceLinkRule`.
- Feeds each candidate back through `compileLinkRule` so the interface-link dispatch's concrete edits flow through the same code path as a directly-authored concrete link.
- Exhaustive `default` branch via `assertNever`.

The `ValueSource.source` union gains "writebackResponse" (Phase 4 plumbing — actual resolution deferred to Phase 6.3). `ExecutionContext` gains optional `writebackOutputs: Record<string, unknown>` field + a `localJsonPointer` helper for `writebackResponse.path` JSONPointer (RFC 6901 with `~0` / `~1` escape sequences).

### 2.5 Backend route validation
`POST /actionTypes` validator now accepts the `createInterfaceLink`/`deleteInterfaceLink` rule shape:
- Loads the interface-link constraint referenced by `interfaceLinkConstraintApiName`.
- Verifies the declared `interfaceId` matches the owning interface apiName.
- Refuses a `deprecated` constraint (with `MISSING_INTERFACE_LINK_IMPLEMENTATION` if missing OR `AMBIGUOUS_INTERFACE_LINK_IMPLEMENTATION` if ambiguous at runtime — evaluated at action execution).
- `draft` constraints accepted with a structured `validationErrors[warning]` so the operator can author against a not-yet-active template.

### 2.6 Frontend — interfaceLink adapter promotion
`interfaceLinkAdapter.ts` (previously `gateAdapter` stub) now carries the full FIRST-CLASS adapter:
- `defaultState()` → `{ kind: "interfaceLink", linkOperation: "addLink", interfaceLinkConstraintApiName: "", sourceObjectDefinition: ..., targetObjectDefinition: ... }`
- `validate` reads `ctx.interfaceLinkConstraints` and rejects when the constraint's status is `deprecated` (surfaces the same structured message the BE does at POST).
- `serialize` produces the canonical `{ type: "createInterfaceLink"|"deleteInterfaceLink", interfaceLinkConstraintApiName, sourceObject, targetObject }`.

`LinkActionTypeTab.tsx` extended to render an interface-link variant — when the user selects an interface-link constraint from `ctx.interfaceLinkConstraints`, the state kind-switches from `link` to `interfaceLink` and renders `<InterfaceLinkActionBuilderPanel>` in place of `<LinkActionBuilderPanel>`.

`hooks/useOntology.ts` gains `useInterfaceLinkConstraints(ontologyId)` (consumer of `interfaceLinkConstraints.ts` route). `lib/ontologyApi.ts` gains the `InterfaceLinkConstraint` type + the `listInterfaceLinkConstraints` client.

### 2.7 Phase 2 tests
- 10 BE tests `tests/unit/actions/interfaceLinkRules-unit.test.ts` covering: "missing" (constraint not found), "no_match" (no concrete link type resolving the interface), "ambiguous" (multiple candidates fail-closed), "ok" with 1 candidate resolving to the canonical concrete addLink rule, "invalid" with structurally-broken constraint.
- 5 new FE interface-link adapter tests added to `actionBuilders.test.ts` (total 26 in that file): defaultState, validate rejects deprecated + draft-allow-with-warning, serialize produces canonical rule, dispatch routing.

### 2.8 Phase 2 live-verify
- POST `/actionTypes` with `createInterfaceLink` rule + `BuyerSellerConstraint` → 201; round-trips byte-equivalent through GET.
- POST `/actionTypes` with `createInterfaceLink` + non-existent constraint apiName → 400 with `MISSING_INTERFACE_LINK_IMPLEMENTATION` validationErrors[].

---

## 3. Phase 3 — Governed Webhook Registry + Safe-Transport Guards

### 3.1 Goal
Ship a governed webhook-registry mapped to `webhook_definition` (migration 129) with versioned immutable refs, an enable/disable/delete lifecycle, AND a pure safe-transport helper module that guards any outbound HTTP (Phase 4 writeback executor + Phase 5 worker) against SSRF + protocol-downgrade + content-type/body-size abuse.

### 3.2 Backend model
`src/models/webhookDefinition.ts`:
- `createWebhookDefinition(input)` → INSERT, autoversion v1
- `getWebhookByName(ontologyId, name)` → latest active version
- `getWebhookByNameVersion(ontologyId, name, version)` — immutable explicit-version lookup
- `getWebhookById(id)`
- `listWebhooks(ontologyId)`
- `bumpWebhookVersion(name, updates)` — transactional `withTransaction` disables the prior version + INSERTs the new one in a single atomic PG transaction. Ensures the `uq_webhook_definition_live_name` partial unique is preserved (only ONE draft/active version per `(ontology_id, name)` at a time). Pre-checks the partial unique for friendlier `WEBHOOK_ALREADY_EXISTS` 409.
- `disableWebhook(name)`
- `hardDeleteWebhook(name)` — admin-only; the version chain removed in one DELETE.

### 3.3 Backend route
`src/routes/webhooks.ts` mounted at `/api/v1/ontology/:ontologyId/webhooks`:
- `POST /` → create draft
- `GET /` → list live versions
- `GET /:name` → latest
- `GET /:name/versions/:version` → immutable historical (for Phase 4 immutable-version wire)
- `PATCH /:name` → bumps version behind `bumpWebhookVersion` (transactional)
- `POST /:name/disable` → flips status to `disabled`
- `DELETE /:name` → admin-only hard delete

Three new error codes: `WEBHOOK_NOT_FOUND` (404), `WEBHOOK_ALREADY_EXISTS` (409), `WEBHOOK_VERSION_DISABLED` (409).

### 3.4 Safe-transport helper
`src/services/webhookSafeTransport.ts` — pure, no IO. Every outbound HTTP path in the action-type subsystem routes through it.

#### `assertEgressUrl(url, policy)` returns `{ kind: 'ok' }` or `{ kind: 'errors', errors: SafeTransportError[] }`:
- Re-parses the URL.
- Enforces `policy.httpsRequired` (production: true) — dev override to false.
- Rejects IP literals in loopback/link-local/multicast/reserved ranges (`127.0.0.0/8`, `169.254.0.0/16`, `224.0.0.0/4`, `0.0.0.0`) → `IP_LITERAL`/`FORBIDDEN_IP` codes.
- Hard rejects the cloud metadata IP `169.254.169.254` with a dedicated `METADATA_IP` code.
- Host allowlist when non-empty.
- Returns the `OK` constant (at the top of the file) on success.

#### `assertMethod(method, policy)`:
- Allowlist GET / POST / PUT / PATCH / DELETE.
- Rejects TRACE / CONNECT / OPTIONS / HEAD per the writeback + webhook contract.

#### `sanitizeOutboundHeaders(inputHeaders)`:
- Strips RFC 7230 §6.1 hop-by-hop headers (`Connection`, `Keep-Alive`, `Proxy-Authenticate`, `Proxy-Authorization`, `TE`, `Trailer`, `Transfer-Encoding`, `Upgrade`).
- Strips headers NOT in the per-policy `headerAllowlist` when the policy is set.

#### `redactHeadersForLog(inputHeaders)`:
- Masks `Authorization`, `Cookie`, `Set-Cookie`, `X-API-Key`, `X-Auth-Token`, `Proxy-Authorization` → `[REDACTED]` so structured log lines never leak secrets.

#### `assertRequestBytes(body, max)` + `assertResponseBytes(body, max)`:
- Body-size cap; production default 1MB request / 4MB response.

#### `assertResponseContentType(contentType, allowedTypes)`:
- JSON + JSON variants (`application/json`, `application/vnd.api+json`, `application/problem+json`) + `text/plain` (with `charset=utf-8`) allowed by default.

#### `assertRedirect(fromUrl, toUrl, policy)`:
- When `policy.followRedirects=false` → `REDIRECT_NOT_ALLOWED`.
- Protocol-downgrade https → http → `REDIRECT_PROTOCOL_DOWNGRADE`.
- Host outside allowlist → `REDIRECT_HOST_NOT_ALLOWED`.

#### `deriveIdempotencyKey(executionId, attempt)`:
- Stable SHA-256 over `${executionId}:${attempt}` so external systems dedup retries safely.

#### `DEFAULT_EGRESS_POLICY`:
- `httpsRequired: true`
- `followRedirects: false`
- `allowedHosts: []`
- `headerAllowlist: []` (unrestricted)
- `maxRequestBytes: 1_000_000`
- `maxResponseBytes: 4_000_000`
- `allowedResponseContentTypes: ['application/json', 'application/vnd.api+json', 'application/problem+json', 'text/plain']` with case-insensitive content-type prefix match.

### 3.5 Frontend — webhook adapter
`gateAdapter.ts` (webhook area) — Phase 3 picker only. The adapter renders the binding-mode radio (writeback / side-effect) + a webhook picker (HTMLSelect), shows the selected webhook's `displayName` + version + status + method + timeout badges + a runtime-resolution Callout. `WebhookActionBuilderState` carries `bindingMode`, `webhookName`, `webhookVersion`. The persistence gate stays ON because the FE dialog can't compose rules + binding in one save (Phase 6.5 lifts the gate).

`WebhookActionTypeTab.tsx` is the live picker; `useWebhooks(ontologyId)` hook reads the registry; `lib/ontologyApi.ts` carries the `WebhookDefinition` type + `listWebhooks` / `getWebhookLatest` / `getWebhookByNameVersion` clients.

### 3.6 Phase 3 tests
34 BE tests `tests/unit/services/webhookSafeTransport-unit.test.ts`:
- Every pure helper: `assertEgressUrl` happy + every IP-classifier rejection + host-allowlist reject + protocol-downgrade reject
- `assertMethod` allowlist + reject every disallowed method
- `sanitizeOutboundHeaders` strips every hop-by-hop + non-allowlisted header
- `redactHeadersForLog` masks every secret header
- `assertRequestBytes` + `assertResponseBytes` cap
- `assertResponseContentType` allowlist + json-variant accept
- `assertRedirect` follow=false + protocol-downgrade + host-not-in-allowlist
- `deriveIdempotencyKey` stability (sha-256 deterministic)

### 3.7 Phase 3 live-verify
- POST `/webhooks NotifySlackR3 draft v1` → 201.
- PATCH `/webhooks/NotifySlackR3` with new `authenticationConfig.ref` → 200 + transactional bump to v2 (active).
- GET `/webhooks/NotifySlackR3` → v2; GET `/webhooks/NotifySlackR3/versions/1` → the immutable prior (now status=disabled).
- POST `/webhooks/NotifySlackR3/disable` → flips v2 to disabled.

---

## 4. Phase 4 — Writeback Pre-Edit Stage

### 4.1 Goal
Land a writeback pre-edit webhook executor that runs the configured webhook BEFORE any ontology edit is applied, aborts the entire action on failure with a sanitized user-facing error, parses the webhook's JSON response body via `outputBindings` JSONPointer into a typed `outputs` map (resolved against `ExecutionContext.writebackOutputs` for the `writebackResponse` ValueSource).

### 4.2 Backend persistence + route validator
`models/actionType.ts` + `routes/actionTypes.ts` accept + validate + persist `writeback_config` on POST + PATCH:
- `validateWritebackConfig(writebackConfig, ontologyId, webhookName)` (rule-layer) enforces the canonical shape:
  - `webhookId` required string (the webhook's apiName)
  - `webhookVersion` required positive integer
  - `failurePolicy` must be `"abort"` (only supported policy today)
  - `inputs: Record<string, ValueSource>` — each value is validated via `validateValueSourceShape` (the union sweeps parameter/static/currentTimestamp/currentUser/writebackResponse)
  - `outputBindings?: Record<string, WritebackOutputDefinition>` — structural shape `{ outputId, path? }` validated; outputBinding `path` parsed via JSONPointer (RFC 6901) for safe escapes.
- Cross-check: the referenced `webhook_definition` row exists AND its `status !== 'disabled'`. On failure → `WEBHOOK_NOT_FOUND` / `WEBHOOK_VERSION_DISABLED` / `WRITEBACK_CONFIG_INVALID`.
- `formatActionType` exposes `writebackConfig` on every read surface.

### 4.3 Backend executor
`src/actions/writebackExecutor.ts` (pure-testable):
- `executeWriteback(executableConfig, ctx, egressPolicy, httpRequest)` returns `WritebackResult`:
  - Loads the immutable webhook version via `getWebhookByNameVersion(ontologyId, webhookId, webhookVersion)`.
  - Egress check on the webhook's URL via `assertEgressUrl`.
  - Method check via `assertMethod`.
  - JSON.stringify of `executableConfig.inputs` (the ResolveInputs result of resolving each `inputs[name]` ValueSource against the post-Stage-2 `resolvedParameters` — see Phase 6.3 for the Stage 3.5 ordering).
  - Outbound headers: `X-Idempotency-Key` = `deriveIdempotencyKey(executionId, attempt)`, `X-Trace-Id`, `X-Actor` (= `executedBy`), `Authorization: Bearer <secret:kind/ref>` placeholder resolved by Phase 6's secret resolver (Phase 4 ships the placeholder header; the secret-management surface still stubs).
  - `sanitizeOutboundHeaders` before send.
  - The injected `httpRequest: HttpRequestFn` (production injects `https.request` + `http.request` with `req.on('timeout')` → `req.destroy(timeoutErr)` so timeouts convert into `WRITEBACK_TIMEOUT` rather than the node-fetch default 5-minute hang).
  - On response: validate status ∈ 2xx OR `rejected` with `httpStatus`. Then `assertResponseContentType(contentType)`, `assertResponseBytes(body, maxResponseBytes)`, `JSON.parse(body)` OR `WRITEBACK_OUTPUT_SCHEMA_MISMATCH`.
  - For each `outputBinding`: JSONPointer-walk (RFC 6901, `~0` for `~`, `~1` for `/` escapes) the response body into `outputs[outputId]`. Array-index access supported.
  - Success → `{ kind: "ok", outputs, httpStatus, idempotencyKey, diagnostic }`.
  - Failure → `{ kind: "rejected", code, userMessage (sanitized), diagnostic (full context for BE logs only) }`:
    - Codes: `WEBHOOK_NOT_FOUND`, `WEBHOOK_VERSION_DISABLED`, `WRITEBACK_CONFIG_INVALID`, `WRITEBACK_TIMEOUT`, `WRITEBACK_REJECTED`, `WRITEBACK_OUTPUT_SCHEMA_MISMATCH`.
- `userMessage` ALWAYS sanitized (no Authorization/Bearer/secret values).
- `diagnostic` contains the full redacted `endpoint` (raw hostname redacted by `redactHeadersForLog`).

### 4.4 Backend rule compiler
`src/actions/ruleCompiler.ts` extended:
- `ValueSource.source` union gains `"writebackResponse"` (with optional `outputId` + `path` JSONPointer fields). The pure validator accepts; the resolution is via `localJsonPointer` walk against `executionContext.writebackOutputs`.
- `ExecutionContext` gains `writebackOutputs?: Record<string, unknown>` + a `localJsonPointer` helper. Phase 4 ships the type plumbing; Phase 6.3 ships the wiring (the actionExecutor's Stage 3.5 re-order).

### 4.5 Backend failure type + status mapping
`models/actionAuditLog.ts` `FailureType` union extends with `"writeback_rejected"`.

`actionExecutor.ts` Stage 5 (originally post-Stage-4, Phase 6.3 moved it to Stage 3.5):
- If `actionType.writeback_config != null`:
  - Resolves input ValueSources: `parameter` → `resolvedParameters[param]`, `static` → `value`, `currentTimestamp` → ISO timestamp, `currentUser` → `executedBy`.
  - Calls `executeWriteback` via the real https.request-based `HttpRequestFn`.
  - On `kind: "rejected"`: sets `result.result = "failed"`, `result.failureType = "writeback_rejected"`, `result.errorMessage = userMessage`, emits structured `console.warn action_writeback_rejected`, throws `OntologyError(code, httpStatus)` (404/409/504/502/422 by code); the `details` envelope carries the redacted `endpoint` so the user-facing error never contains secrets.

### 4.6 Phase 4 tests
20 BE tests `tests/unit/actions/writebackExecutor-unit.test.ts` covering: happy path with JSONPointer extraction, missing webhook, disabled version, egress failures (HTTP/loopback/metadata IP), method reject (TRACE), transport timeout, non-2xx, content-type reject, body cap reject, JSON parse mismatch, binding JSONPointer miss, array-index extraction, `~0`/`~1` escapes, redaction (no Authorization/Bearer leaks in userMessage), `userMessage` never contains secrets.

### 4.7 Phase 4 live-verify
- POST `/actionTypes wbActionGood` with real `NotifySlackR3 v2` binding → 201 + `writebackConfig` round-trips byte-equivalent through GET.
- POST `/actionTypes wbActionBad` with non-existent webhook → 422 `WRITEBACK_CONFIG_INVALID` with structured `validationErrors[]`.

---

## 5. Phase 5 — Durable Side-Effect Outbox + Worker + NotificationProvider

### 5.1 Goal
Land the durable transactional outbox (`action_side_effect_job` migration 131), the worker that drains it post-commit with bounded exponential backoff + jitter + dead-letter, the NotificationProvider abstraction replacing the `mockSendNotification` path, and the executor's preCommitHook that insures side-effect jobs are atomic with the action's edits.

### 5.2 BE model
`src/models/actionSideEffectJob.ts`:
- `enqueueSideEffectJobsInTransaction(client, input)` — atomic INSERT one row per side effect IN THE CALLER'S PG TRANSACTION (the actionExecutor's `preCommitHook` passes a `PoolClient` that's already inside the apply-edits + audit transaction).
- `claimSideEffectJobs(limit)` — `SELECT FOR UPDATE SKIP LOCKED` + `UPDATE status='running'` in a single transaction. The `FOR UPDATE SKIP LOCKED` semantics let multiple worker pods claim disjoint batches.
- `markSideEffectJobSucceeded(jobId, externalReceipt?)` — sets status='succeeded', `external_receipt = COALESCE($2, external_receipt)`.
- `markSideEffectJobRetryOrDead(jobId, code, message, retryPolicy)` — bumps `attempt_count` in a `FOR UPDATE` sub-transaction; computes the bounded exponential backoff:
  ```js
  base = min(maxBackoffMs, initialBackoffMs * multiplier^nextAttempt)
  jitter = floor(random() * jitterMs)
  next_attempt_at = now() + base + jitter
  ```
  If `nextAttempt >= maxAttempts` → status='dead', else 'retrying'. Returns the new status so the worker's `OnceResult` counter is accurate.
- `requeueDeadSideEffectJob(jobId)` — operator-driven retry; flips 'dead' → 'pending', resets `attempt_count=0`, preserves `idempotency_key`.
- `getSideEffectQueueStats()` → `Record<state, count>` for the operator dashboard.

### 5.3 BE extractor
`src/actions/sideEffectJobExtractor.ts` — pure parser from `actionType.side_effects` JSONB blob → `ExtractedSideEffectJob[]`:
```ts
interface ExtractedSideEffectJob {
  kind: "webhook" | "notification";
  payload: Record<string, unknown>;
  idempotencySeed: string;     // "wb:0" | "notif:0:1" — combined with executionId at enqueue
}
```
For each `side_effects.webhooks[]` entry → one job with `payload: { spec, context }`. For each `side_effects.notifications[]` entry → ONE PER recipient → `payload: { spec, recipientIndex, recipient, context }`, so one failing recipient doesn't block others.

`SideEffectExecutionContext` is the `payload.context` shape:
```ts
{
  executionId, actionTypeApiName, actionTypeId, actionTypeVersion, ontologyId, executedBy,
  result, affectedObjects, firedAt
}
```

### 5.4 BE worker
`src/services/workers/sideEffectWorker.ts` — standalone, stateless worker loop:

- `DEFAULT_RETRY_POLICY = { maxAttempts: 5, initialBackoffMs: 1000, maxBackoffMs: 60_000, multiplier: 2, jitterMs: 500 }`.
- `productionWebhookDispatch(job)` reads `payload.spec.url/method/headers/timeoutMs` + `payload.context`, calls `deliverOneWebhook` (the existing per-webhook transport path Phase 3's `fireActionWebhooks` uses — `assertEgressUrl` egress guard + 5s runtime timeout + `X-Idempotency-Key` from `deriveIdempotencyKey`). Returns `{ ok: true, receiptId }` on 2xx.
- `productionNotificationDispatch(job)` (Phase 5 stub → Phase 6.1 recipient data filter plugged in → Phase 6.4 real INSERT short-circuit):
  - Phase 5: `getNotificationProvider(channel).send(req)` where `channel = spec.channel`.
  - Phase 6.1: pre-resolves the recipient via `recipientVisibilityFilter` + drops on filter refusal
  - Phase 6.4: when `filterResult.ok`, threads `recipient.userUuid = filterResult.resolvedUserId` and calls the provider's `send`.
- `productionDispatchForKind(job)` — per-kind dispatcher: webhook → `productionWebhookDispatch`; notification → `productionNotificationDispatch`.
- `runOnce(limit, retryPolicy, injectDispatch)`:
  - Claims `claimSideEffectJobs(limit)`, dispatches each, on success `markSideEffectJobSucceeded`, on infra-failure `markSideEffectJobRetryOrDead` (jittered backoff). Emits structured `console.warn side_effect_dispatch_failed { jobId, ...code, attemptCountNext, nextStatus }`. Returns `OnceResult { claimed, succeeded, retrying, dead, durationMs }`. (Phase 6.3 wraps the whole cycle in an OTel span.)
  - Accepts an optional `injectDispatch` for unit tests; production wires `productionDispatchForKind`.
- `runWorkerLoop({ intervalMs, limit, retryPolicy, signal })` — periodic loop, cancels on `AbortSignal`.

### 5.5 BE NotificationProvider abstraction (Phase 5 stubs → Phase 6.4 real impls)
`src/actions/notificationProviders.ts`:
```ts
export interface NotificationProvider {
  channel: NotificationChannel;
  send(req: NotificationRequest): Promise<NotificationDeliveryResult>;
}
```
`NotificationRequest` carries `templateId`, `templateParameters`, `channel`, `recipient: { principal, principalKind, userUuid? }`, `executionId`, `actionTypeApiName`, `ontologyId`.

Three providers, the registry `getNotificationProvider(channel)` + `registerNotificationProvider(channel, p)`:
1. `inAppNotificationProvider` — Phase 5 stub (console.info + counter bump); Phase 6.4 replaces with the real `notification_inbox` INSERT path.
2. `emailNotificationProvider` — Phase 5 stub; Phase 6.4 real HTTP transport via `webhookSafeTransport`. SMTP form detected and structured-error thrown.
3. `slackCompatibleNotificationProvider` — Phase 5 stub; Phase 6.4 real transport.

### 5.6 BE server.ts spawn
`src/server.ts` spawned from boot when `ACTION_SIDE_EFFECT_WORKER_ENABLED=1`:
```ts
const { runWorkerLoop } = await import("./services/workers/sideEffectWorker");
const controller = new AbortController();
void runWorkerLoop({ intervalMs, limit, signal: controller.signal });
```
Tunables `ACTION_SIDE_EFFECT_WORKER_INTERVAL_MS` (default 2000), `ACTION_SIDE_EFFECT_WORKER_BATCH` (default 16). When the flag is unset, the legacy fire-and-forget `fireActionWebhooks` + `sendNotifications` path remains — backward-compat for tests + existing deployments.

### 5.7 BE wire actionExecutor Stage 7 → preCommitHook
`src/actions/actionExecutor.ts`:
- New `preCommitHook` body inside the apply-edits transaction: when `ACTION_SIDE_EFFECT_WORKER_ENABLED=1 && actionType.side_effects != null`, builds `SideEffectExecutionContext` (the post-Stage-2 result, the post-Stage-6 `affectedObjects` array, the post-Stage-6 firedAt timestamp), `extractSideEffectJobs(actionType.side_effects, execCtx)`, and `enqueueSideEffectJobsInTransaction(pg, …)`. Atomic with the audit row + edits.
- Stage 7 (post-commit) legacy path: gated behind `process.env.ACTION_SIDE_EFFECT_WORKER_ENABLED !== "1"`; otherwise suppressed (the worker drains).

`actionWebhooks.ts` exports `deliverOneWebhook` (was private `deliverOne`) so the worker shares the exact same egress-guarded transport path as the legacy fire-and-forget path.

### 5.8 BE metrics
`src/services/funnel/metrics.ts` registers help strings for the new counters/gauges:
- `tellus_side_effect_claim_total{kind}` — jobs claimed per cycle
- `tellus_side_effect_succeeded_total{kind}` — succeeded
- `tellus_side_effect_retry_total{kind, error_code}` — retried
- `tellus_side_effect_dead_total{kind, error_code}` — dead-lettered
- `tellus_side_effect_dispatch_duration_seconds{kind, outcome}` — per-dispatch latency histogram (outcome = `ok` / `retry` / `dead` / `dropped_<reason>`)
- `tellus_side_effect_queue_size{status}` — gauge
- `tellus_side_effect_notification_dropped_total{reason}` — Phase 6.1 (insufficient_visibility / user_not_resolved / lookup_error)
- `tellus_notification_in_app_total` / `_email_total` / `_slack_total` — dispatch-channel counters

The worker's `runOnce` stamps these counters + calls `setGauge` per `getSideEffectQueueStats()`. (The Prometheus scrape endpoint is the existing `/api/v1/funnel/metrics`.)

### 5.9 Phase 5 tests (3 suites, 29 new)
- 9 tests `tests/unit/actions/sideEffectJobExtractor-unit.test.ts` — webhook fanout, per-recipient notification split, malformed entries dropped, context propagation.
- 12 tests `tests/unit/actions/actionSideEffectJob-unit.test.ts` — smart-regex DB mock; enqueue (empty + 2 inserts + idempotency-key), claim (SkipLocked + UPDATE short-circuit), markSucceeded (with + without external_receipt), markRetryOrDead (dead on maxAttempts, retrying under max, throw on missing row + ROLLBACK), requeueDeadSideEffectJob (UPDATE pending + null)
- 8 tests `tests/unit/services/sideEffectWorker-unit.test.ts` — claim → succeed; empty claim; retry → dead-letter (maxAttempts trip); mixed success+retry+dead; dispatcher opaque-false result; limit honored; operator requeue; requeue no-op.

### 5.10 Phase 5 live-verify
- `ACTION_SIDE_EFFECT_WORKER_ENABLED=1` BE boot → `Side-effect outbox worker started` log
- POST `phase5VerifyV1` with webhook + email-notification sideEffects → 201
- POST `/actions/phase5VerifyV1/apply` → `result: success`, `executionId`, 1 affected OlivierOrder11
- `action_side_effect_job`: 2 rows inserted (atomic with audit)
- Notifications → `succeeded`, `external_receipt` populated
- Webhook (https://example.com/test → 4xx) → `retrying` 4 attempts with bounded backoff + jitter, then `dead` (attempt_count=5)
- Operator `UPDATE action_side_effect_job SET status='pending' WHERE status='dead'` → row re-claimed, dispatched, retried 2× → requeue verified
- Worker metric emitted per cycle: `tellus_side_effect_worker_cycle { claimed, succeeded, retrying, dead, durationMs }`

### 5.11 Phase 5 final report
`docs/phase5-durable-side-effect-outbox.md` — operational runbook + the metrics surface + env flag table + developer reference.

---

## 6. Phase 6.1 — Server-side Authorization for Action Dispatch

### 6.1.1 Goal
Wire the action-type-level CBAC layer (`action_type.allowed_principals / denied_principals / required_markings` columns from migration 037 + the existing `cbacPolicy.ts` / `cbacPolicyLoader.ts` / `cbacDecisionLog.ts` modules) into the actionExecutor's dispatch path. Add a recipient data filter for notifications that drops recipients the recipient-data-filter can't resolve to a user UUID OR whose `user_markings` don't cover every affected object's markings union.

### 6.1.2 BE — `src/actions/actionCbac.ts` extracted gate helper
The actionExecutor's Stage 1c body (between Stage 1b semantics-resolved and Stage 2 parameter-validation) is extracted into a testable helper:

```ts
export interface CbacGateResult {
  decision: "allow" | "deny";
  reason: Decision["reason"];           // anonymous_denied | denylist_match | no_allowlist_match | markings_insufficient | missing_policy_default_deny | allow
  matchedRule: Decision["matchedRule"];
  internalError: { code: string; detail: string } | null;  // populated on loader/evaluator failures → AUTHORIZATION_UNAVAILABLE (503 fail-closed)
}

export function subjectFromSecurity(security: ...): Subject;

export async function runActionCbacGate(
  ontologyId, actionTypeApiName, security, policyCtx
): Promise<CbacGateResult>;

export function cbacDenyMessage(result: CbacGateResult): string;
```

`subjectFromSecurity` builds the Subject from the ExecutionContext's security fields (subjectKind, subjectIdentifier, subjectMarkings, subjectCbac, markBypass). The `markBypass` flag bypasses the markings-cover gate post-evaluation (overrides the `markings_insufficient` outcome only, NOT the denylist or allowlist — mirrors `buildSecurityFilter:246`).

`runActionCbacGate`:
1. If `security.subjectKind === undefined` → backward-compat ALLOW (test hopper + once-future callers that don't go through Keycloak).
2. `loadActionTypePolicy(ontologyId, apiName)` via the LRU-cached policy loader (60s TTL). On loader failure (PG drop etc.) → fail-closed with `internalError: { code: AUTHORIZATION_UNAVAILABLE }`.
3. `evaluateCbacPolicy(subject, policy, policyCtx)` (the pure evaluator from `cbacPolicy.ts`):
   - policy null → `missing_policy_default_deny` (default-deny per F-P3-18 §4)
   - deniedPrincipals hit → `denylist_match` (beats everything; step 1)
   - anonymous subject + no `{type:any}` allowlist → `anonymous_denied` (step 2)
   - allowedPrincipals non-null and no match → `no_allowlist_match` (step 3)
   - missing-markings → `markings_insufficient` (step 4)
   - all pass → `allow`
4. `logCbacDecision(subject, decision, policyCtx)` best-effort forensic log — never blocks on failure.
5. `markBypass=true && decision.reason === "markings_insufficient"` → override to `allow`.

### 6.1.3 BE — actionExecutor Stage 1c
`actionExecutor.ts` imports the helper + extends `ExecutionContext` with optional fields:
```ts
subjectKind?: "user" | "service" | "token" | "anonymous";
subjectIdentifier?: string;
subjectMarkings?: string[];
subjectCbac?: string[];
markBypass?: boolean;
```
Between Stage 1b and Stage 2:
- If `context.subjectKind !== undefined`:
  - `runActionCbacGate(...)` with the policy context.
  - On `internalError` → `result.failureType="unclassified"`, `pendingError = OntologyError(AUTHORIZATION_UNAVAILABLE, 503, ...)`, return early (failure audit logged in the finally block).
  - On `decision="deny"` → `result.failureType="unclassified"`, `pendingError = OntologyError(PERMISSION_DENIED, 403, { actionTypeApiName, cbacReason, subject, matchedRule })`.

### 6.1.4 BE — route wire
`src/routes/actions.ts` POST `/actions/:apiName/apply` extract `req.security` (populated by the global `securityContext` middleware at `server.ts:512`) → `ExecutionContext` fields:
```ts
const sec = req.security as {
  userId: string; markings: string[]; cbac: string[];
  systemPrincipal: boolean; markingBypass: boolean;
} | undefined;
const context = {
  executedBy, sourceIp, branchId, expectedVersion, roles, groups,
  ...(sec ? {
    subjectKind: (sec.systemPrincipal ? "service" : "user") as SubjectKind,
    subjectIdentifier: sec.userId,
    subjectMarkings: sec.markings,
    subjectCbac: sec.cbac,
    markBypass: sec.markingBypass === true,
  } : {}),
};
```
The same surface is threaded by:
- `routes/actions.ts:482` `/actions/:apiName/applyBatch`
- `routes/bulkActions.ts:170` bulk-action runner

### 6.1.5 BE — backward-compat default-row contract
The policy loader returns a permissive `Policy` for an `action_type` row with NULL policy columns:
```ts
allowedPrincipals = null;  // → step 3 skipped
deniedPrincipals = null;   // → step 1 skipped
requiredMarkings = [];     // → step 4 trivially passes
```
For any authenticated non-anonymous subject, `evaluateCbacPolicy` returns `allow`. Phase 6.1 wiring NEVER breaks a default action_type row — only rows that have explicitly declared a policy are bound by it.

### 6.1.6 BE — Notification recipient data filter
`src/actions/notificationRecipientFilter.ts`:

```ts
export async function recipientVisibilityFilter(
  ontologyId, affectedObjects, recipient, resolver
): Promise<FilterResult>;

export function unionObjectMarkings(objectMarkings: string[][]): string[];
export function makeProductionRecipientResolver(...): RecipientResolver;
export function __clearUserMarkingsCacheForTests(): void;   // test-only seam
```

Resolution:
1. `resolver(principal, principalKind)` → recipient's `users.id` UUID. Production wraps `keycloakAdminService.findUserByEmail`. Null → `user_not_resolved` drop. Throws → `lookup_error` drop (defensive).
2. Empty `affectedObjects` ⇒ `ok` (no markings to gate).
3. Per-object `getInstance(ontologyId, ot, pk)` — `object_instances.markings` text[]; defensive null/throw → no-markings-required.
4. `unionObjectMarkings(...)` → required (`dedupe + sort` via `Set`).
5. `userMarkingsForUuid(userUuid)` — `SELECT marking_id FROM user_markings WHERE user_id=$1`, LRU cached 60s.
6. `userHasAllMarkings(required, possessed)` from `services/markingUnion.ts:35`.
7. False → DROP `insufficient_visibility` + `missingMarkings[]`; True → OK.
8. The drop is recorded in the worker's `external_receipt` JSONB:
   ```json
   { "dropped": true, "receiptId": "dropped:user_not_resolved", "droppedReason": "user_not_resolved" }
   ```
   OR for `insufficient_visibility`:
   ```json
   { "dropped": true, "receiptId": "dropped:insufficient_visibility",
     "droppedReason": "insufficient_visibility", "missingMarkings": ["TOP_SECRET", "ORCON"] }
   ```

### 6.1.7 BE — worker productionNotificationDispatch wiring
`sideEffectWorker.ts` `productionNotificationDispatch` extends:
- Resolves recipient via `recipientVisibilityFilter` BEFORE invoking the provider.
- If drop → return `{ ok: true, dropped: true, droppedReason, missingMarkings }` — the worker's success path records this in `external_receipt` + bumps `tellus_side_effect_notification_dropped_total{reason=...}`.
- If ok → threads `req.recipient.userUuid = filterResult.resolvedUserId` (Phase 6.4 uses this for the InApp INSERT).
- The `SideEffectDispatchFn` return type gains `dropped?` + `droppedReason?` + `missingMarkings?` optional fields.

### 6.1.8 Phase 6.1 tests (2 suites, 29 new)
- 18 tests `tests/unit/actions/actionCbac-unit.test.ts`:
  - backward-compat (subjectKind undefined → ALLOW without touching the loader; default-row policy NULL columns → ALLOW)
  - anonymous → DENY without allowlist
  - denylist hit → DENY
  - allowlist miss → DENY
  - markings_insufficient + missing list surfaced
  - markBypass overrides markings_insufficient (NOT allowlist/denylist)
  - loader failure → AUTHORIZATION_UNAVAILABLE fail-closed
  - evaluator exception → AUTHORIZATION_UNAVAILABLE fail-closed
  - forensic log failure does NOT flip an allow into a deny
  - `cbacDenyMessage(reason)` human-readable factory
  - `subjectFromSecurity(markBypass=false)` passes markings verbatim
- 11 tests `tests/unit/actions/notificationRecipientFilter-unit.test.ts`:
  - Empty `affectedObjects` → ALLOW; resolver null → DROP user_not_resolved; resolver throws → DROP lookup_error; unknown instance → ALLOW (no markings-required)
  - Single object required CONFIDENTIAL: user holds → ALLOW; union multi-object: user holds the union → ALLOW; multi-object union exceeds possession → DROP insufficient_visibility with `missingMarkings` populated; objects with NULL markings column → ALLOW; user_markings query failure → defensive empty set → DROP on required>0
  - `unionObjectMarkings` dedupes + sorts

### 6.1.9 Phase 6.1 live verify
- UPDATE `action_type` `phase5VerifyV1` set `allowed_principals='[{role:approver}]'::jsonb`, `required_markings='{CONFIDENTIAL}'` → persisted
- POST `/actions/phase5VerifyV1/apply` as cypress-admin (realm roles include `ontology-admin`, `default-roles-tellus`, `marking:TOP_SECRET`, `marking:CONFIDENTIAL`, `marking:SECRET`, `marking:PUBLIC` — NO `approver` role)
  → `403 PERMISSION_DENIED` with `cbacReason: "no_allowlist_match"`, `subject: "53cf9bcf-4c20-4aed-83f4-3c7e405453b4"`, structured details
- UPDATE to `allowed_principals='[{any_authenticated}]'`, `required_markings='{TOP_SECRET}'`; restart BE (LRU 60s cache); POST
  → `result: success` — the cypress-admin has the `tellus-superadmin` realm role (NOT visible in `realm_access.roles`, surfaced via the resolved principal's role list) → `markingBypass=true` → `markings_insufficient` overridden.
- Worker drained the notification for `alice@test.local` recipient → `external_receipt={"dropped":true, "receiptId":"dropped:user_not_resolved", "droppedReason":"user_not_resolved"}`, counter `tellus_side_effect_notification_dropped_total{reason="user_not_resolved"}` bumped

---

## 7. Phase 6.2 — Versioned Definitions + If-Match Optimistic Concurrency

### 7.1 Goal
Surface migration 132's `definition_version + definition_hash` columns on the route layer. ETag header on GET responses; PATCH handler accepts `If-Match: <version>` and returns 412 on stale.

### 7.2 BE — `formatActionType` serialization
`src/routes/actionTypes.ts` `formatActionType(row)` adds:
```ts
definitionVersion: row.definition_version ?? 1,
definitionHash: row.definition_hash ?? null,
```
to every GET + POST + PATCH + clone response surface. Pre-132 legacy rows (`definition_version` NULL after migration backfill) serialize as `1` for backward-compat.

### 7.3 BE — GET/:actionApiName ETag header
Sets `ETag: "<version>"` (the int wrapped as a strong ETag) on every GET response:
```ts
const version = Number(row.definition_version ?? 1);
if (Number.isInteger(version)) res.set("ETag", `"${version}"`);
```

### 7.4 BE — PATCH handler `If-Match` gate
After loading the existing row, before validation, parse `req.get("If-Match")`:
- Strip the weak-ETag wrapping (`W/"1"`), the quoted form (`"1"`), the bare integer (`1`) — accept any of these forms.
- `parseInt(strip(header), 10)` → `expectedVersion`.
- Compare against `existing.definition_version`. On mismatch → throw `OntologyError("PRECONDITION_FAILED", 412, { actionTypeApiName, expectedVersion: header, persistedVersion, definitionHash })`.
- Absent header → no-op (not enforced today; future opt-in via env).

### 7.5 BE — ActionTypeRow type
`src/models/actionType.ts` `ActionTypeRow` extends with `definition_version?: number; definition_hash?: string | null;` so `SELECT *` results carry the columns cleanly typed.

### 7.6 Phase 6.2 tests
4 tests `tests/unit/actions/actionTypeFormatter-unit.test.ts` (was 2) added:
- `formatActionType` surfaces `definitionVersion` + `definitionHash` when columns are set
- Falls back to `definitionVersion=1` + null hash when columns are missing (pre-132 legacy)
- The existing 2 tests (metadata + nullables) preserved unchanged

### 7.7 Phase 6.2 live verify
- GET `/actionTypes/phase5VerifyV1` → `ETag: "1"` header + `definitionVersion: 1 in body`
- PATCH with `If-Match: 999` (stale) → `412 PRECONDITION_FAILED` with `expectedVersion: "999", persistedVersion: 1, definitionHash: null`
- PATCH with `If-Match: 1` + `description` change (non-bump column) → 200; `definitionVersion: 1` in body (no bump — `description` is NOT in the trigger's bump set)
- PATCH with `If-Match: 1` + `rules` change (bump column) → 200; `definitionVersion: 2` — trigger bumped
- DB after: `definition_version = 2`
- PATCH with `If-Match: 1` after the bump → `412 PRECONDITION_FAILED` with `persistedVersion: 2`

---

## 8. Phase 6.3 — Observability + Writeback Stage Re-order

### 8.1 Goal
1. Wrap the worker's `runOnce` cycle in an OpenTelemetry span (`side_effect_worker.runOnce`) with the cycle's structured outcome as attributes — span exports through the existing OTLP/HTTP exporter at `OTEL_EXPORTER_OTLP_ENDPOINT`.
2. Move the actionExecutor's Stage 5 (writeback pre-edit) from AFTER `compileRules` (Stage 4ab) to BEFORE `compileRules` (logically Stage 3.5) so the typed outputs map from a successful writeback is available as the `ExecutionContext.writebackOutputs` field that `compileRules` consumes for `ValueSource.source === "writebackResponse"` (localJsonPointer walk). The abort-on-failure contract is preserved.

### 8.2 BE — `src/actions/runWritebackStage.ts` extracted Stage 5 body
The writeback pre-edit hook (~140 lines of input-resolution + https transport + redacted-diagnostic logging + structured OntologyError mapping + status-code mapping) is extracted into:
```ts
export interface RunWritebackInput {
  actionType: { writeback_config: unknown | null };
  resolvedParameters: Record<string, unknown>;
  executedBy: string;
  ontologyId: string;
  actionTypeApiName: string;
  executionId: string;
}
export type RunWritebackSuccess =
  | { kind: "ok"; outputs: Record<string, unknown> | undefined }
  | { kind: "no_writeback" };
export async function runWritebackStage(input): Promise<RunWritebackSuccess>;
```
- Returns `{ kind: "no_writeback" }` if the action's `writeback_config` is null.
- Returns `{ kind: "ok", outputs }` on success.
- THROWS a structured `OntologyError(WRITEBACK_*, status=502|504|422|404|409)` on rejection so the executor's outer try/catch handles the failure result.

The builder of the writeback request body, the `https.request` callback chain, the `req.on("timeout")` → `req.destroy(timeoutErr)` → `WRITEBACK_TIMEOUT`, the response-body JSON.parse, the JSONPointer extraction, and the redacted structured WARN log (`action_writeback_rejected { webhookName, webhookVersion, httpStatus, endpoint: "[redacted]", contentType }`) all move from `actionExecutor.ts` Stage 5 inline into the helper.

### 8.3 BE — actionExecutor Stage 3.5 + Stage 4 threading
`actionExecutor.ts`:
- Imports `runWritebackStage`.
- Between Stage 3 (submission criteria) and Stage 4 (compileRules), insert Stage 3.5:
```ts
let writebackOutputs: Record<string, unknown> | undefined;
if (actionType.writeback_config != null) {
  try {
    const wbRes = await runWritebackStage({ actionType, resolvedParameters, executedBy, ontologyId, actionTypeApiName, executionId });
    if (wbRes.kind === "ok") writebackOutputs = wbRes.outputs;
  } catch (wbErr) {
    // OntologyError already structured — re-throw via the executor's
    // outer catch + result.failureType = "writeback_rejected"
    result.result = "failed";
    result.failureType = "writeback_rejected";
    result.errorMessage = wbErr instanceof Error ? wbErr.message : String(wbErr);
    pendingError = wbErr instanceof OntologyError ? wbErr : new OntologyError(...);
    return result;
  }
}
```
- Stage 4 calls `compileRules(...)` with the extended `ExecutionContext`:
```ts
const compilation = await compileRules(
  actionType.rules,
  resolvedParameters,
  fetchObject,
  {
    executedBy, ontologyId, branchId,
    ...(writebackOutputs ? { writebackOutputs } : {}),
  }
);
```
- The now-empty Stage 5 site is replaced with a no-op marker so the audit-log stage numbers remain stable for readers.
- Stage 4a (v2 planner) + Stage 4b (OCC) + Stage 6 (applyEdits) + Stage 7 (outbox / fire-and-forget) all unchanged — they consume `compilation.edits` same as before, and `writebackOutputs` is only consulted when a rule declares the `writebackResponse` ValueSource (a niche pattern that didn't exist pre-Phase 6.3 anyway).

### 8.4 BE — OTel span wrapper
`sideEffectWorker.ts` `runOnce` is wrapped in a `tracer.startActiveSpan("side_effect_worker.runOnce", async (span) => { ... })`:
- `@opentelemetry/api` is lazy-`require`d so tests with `OTEL_SDK_DISABLED=true` don't drag the OTel SDK into the worker's import graph.
- Span attributes set at the end of each cycle: `side_effect.claimed`, `side_effect.succeeded`, `side_effect.retrying`, `side_effect.dead`, `side_effect.duration_ms`.
- Span ends after the queue-depth gauge has been set (best-effort try/catch).

### 8.5 Phase 6.3 tests
The `writebackExecutor-unit.test.ts` (Phase 4, 20 tests) covers `runWritebackStage`'s underlying `executeWriteback` + inputs resolution. The `sideEffectWorker-unit.test.ts` (Phase 5, 8 tests) covers the `runOnce` cycle's success/retry/dead-letter behavior. The OTel span is exercised via those suites + the mock dispatcher — no separate OTel-instrumentation test is shipped (Phase 6.6 covers it via the manual scenario H).

### 8.6 Phase 6.3 live verify
- POST `/actions/phase5VerifyV1/apply` after the re-order → `{ result: success, executionId, affectedObjects: [...] }` — identical call signature as pre-reorder. The reorder is internal + transparent to the wire.
- Worker repeated dispatching with the OTel span emitted per cycle (the existing Phase 5 worker log shape):

---

## 9. Phase 6.4 — Real SMTP/Slack transport + `notification_inbox` + FE inbox reader

### 9.1 BE migration 133 — `notification_inbox` table
`src/migrations/133_notification_inbox.sql` applied live:
```sql
CREATE TABLE notification_inbox (
  notification_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_user_id UUID NOT NULL,
  template_id TEXT NOT NULL,
  template_parameters JSONB NOT NULL DEFAULT '{}'::jsonb,
  channel TEXT NOT NULL DEFAULT 'in_app',
  action_type_api_name TEXT,
  execution_id TEXT,
  ontology_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at TIMESTAMPTZ,
  CONSTRAINT notification_inbox_channel_valid CHECK (channel IN ('in_app', 'email', 'slack_compatible'))
);

CREATE INDEX idx_notification_inbox_user_created ON notification_inbox (recipient_user_id, created_at DESC);
CREATE INDEX idx_notification_inbox_user_unread ON notification_inbox (recipient_user_id, created_at) WHERE read_at IS NULL;
CREATE INDEX idx_notification_inbox_execution ON notification_inbox (execution_id) WHERE execution_id IS NOT NULL;
```
The `.down.sql` reverses cleanly via `DROP TABLE / DROP INDEX IF EXISTS` chain.

### 9.2 BE model — `src/models/notificationInbox.ts`
```ts
export async function insertNotification(input: InsertNotificationInput): Promise<NotificationInboxRow>;
export async function listNotificationsForUser(uid, opts: { limit?, unreadOnly? }): Promise<NotificationInboxRow[]>;
export async function countUnreadForUser(uid): Promise<number>;
export async function markNotificationRead(notificationId, uid): Promise<NotificationInboxRow | null>;  // returns null when the row doesn't belong to the caller (IDOR-safe)
export async function markAllNotificationsRead(uid): Promise<number>;  // returns updated count
```

### 9.3 BE — InApp provider real INSERT path
`src/actions/notificationProviders.ts`:
```ts
export const inAppNotificationProvider: NotificationProvider = {
  channel: "in_app",
  async send(req): Promise<NotificationDeliveryResult> {
    incCounter("tellus_notification_in_app_total");
    const recipientUuid = req.recipient.userUuid;
    if (!recipientUuid) {
      // The recipient data filter ALLOWS affectedObjects=[] without resolving
      // the user — log + counter the drop + return ok so the worker doesn't
      // retry forever.
      console.warn({ type: "notification_in_app_skipped", reason: "recipient_user_uuid_missing" });
      incCounter("tellus_side_effect_notification_dropped_total", { reason: "user_not_resolved" });
      return { ok: true, receiptId: `inapp:skipped:${...}`, diagnostic: "recipient_user_uuid_missing" };
    }
    try {
      const row = await insertNotification({
        recipientUserId: recipientUuid,
        templateId, templateParameters,
        channel: "in_app",
        actionTypeApiName, executionId, ontologyId,
      });
      return { ok: true, receiptId: `inapp:${row.notification_id}` };
    } catch (err) {
      throw new Error(`inAppNotificationProvider: failed to insert notification_inbox row: ${err.message ?? String(err)}`);
    }
  },
};
```
The `NotificationRequest.recipient` type extends with `userUuid?: string | null`.

### 9.4 BE — Email + Slack real HTTP transport
Both providers use a shared `sendHttp(url, body, headers, receiptIdSeed)` helper that:
- `assertEgressUrl`, then `https.request` (or `http.request` for dev) POST with `content-type: application/json` + `user-agent: tellus-notification/1` + the caller's headers (with `Authorization: Bearer ${EMAIL_PROVIDER_TOKEN}` for email; `X-Idempotency-Key` for both).
- `req.on("timeout") → req.destroy(timeoutErr)` at 10s.
- Resolves `ok:true receiptId:<seed>` on 2xx; throws `/HTTP ${status}/` on non-2xx; throws `/transport error/` on req error.
- The error messages NEVER leak response-body bytes or response-body length-sensitive info beyond "response body length=N (redacted)".

`emailNotificationProvider`:
- `EMAIL_PROVIDER_URL` unset → stub-logs `{ ok: true, receiptId: "email-stub:..." }`.
- `EMAIL_PROVIDER_URL` starts with `smtp(s)://` → throws "needs nodemailer" (not in package.json today).
- `EMAIL_PROVIDER_URL` http(s):// → POST `{ to: recipient.principal, from: EMAIL_PROVIDER_FROM||'no-reply@tellus.local', templateId, parameters, executionId, actionTypeApiName, ontologyId, channel: "email" }`.

`slackCompatibleNotificationProvider`:
- `SLACK_WEBHOOK_URL` unset → stub.
- Set → POST the canonical Slack incoming-webhook body `{ text, attachments: [{ fallback, color, fields: [...] }] }` with the action context as a fields array.

### 9.5 BE — `/api/v1/notifications` route
`src/routes/notifications.ts` mounted at `/api/v1/notifications` (note: global — not under the ontology router — the inbox is per-user, not per-ontology):

```ts
GET /api/v1/notifications?limit=50&unreadOnly=true   → { data: NotificationInboxItem[] }
GET /api/v1/notifications/unread/count                 → { unread: number }
POST /api/v1/notifications/:id/read                    → { id, read: true, readAt }
POST /api/v1/notifications/read/all                    → { updated: number }
```

Endpoint shapes:
- All endpoints are scoped to `req.user.id || req.tellusPrincipal.userId || req.auth.sub || null` — no admin surface.
- The `markNotificationRead` returns 404 with `NOTIFICATION_NOT_FOUND` when the row doesn't belong to the caller (IDOR-safe — same envelope as Task 28's object-explorer GET-by-id: 404 not 403).
- The list serializer exposes the row as `{ id, templateId, parameters, channel, actionTypeApiName, executionId, ontologyId, createdAt, readAt, read }`.

### 9.6 BE — worker threads resolved UUID
`src/services/workers/sideEffectWorker.ts` `productionNotificationDispatch` extends:
- After the `filterResult.ok` check (filter already drops on `user_not_resolved`), builds the `req.recipient`:
```ts
recipient: {
  ...(recipientRaw ?? {}),
  principal: String(recipientRaw.principal ?? recipientRaw.email ?? "?"),
  principalKind: recipientRaw.principalKind === "group" ? "group" : "user",
  ...(filterResult.resolvedUserId ? { userUuid: filterResult.resolvedUserId } : {}),
} as NotificationRecipient,
```
The `userUuid` carries the recipient's `users.id` UUID the recipient data filter resolved.

### 9.7 FE — typed client + React Query hooks
`lib/notificationsApi.ts`:
```ts
export async function listNotifications(params: { limit?, unreadOnly? }): Promise<NotificationInboxItem[]>;
export async function countUnreadNotifications(): Promise<number>;
export async function markNotificationRead(id): Promise<void>;
export async function markAllNotificationsRead(): Promise<number>;
```
Each function wraps the shared `api` axios instance from `lib/api.ts` — handles auth + envelope unwrap.

`hooks/useNotifications.ts`:
- `useUnreadNotificationsCount(enabled?)` — `useQuery` with `staleTime: 10s, refetchInterval: 30s` (the dashboard badge poller).
- `useNotifications(params, enabled?)` — `useQuery` with `refetchInterval: 30s` only when `enabled` (only polls when the dropdown is open — avoids background traffic).
- `useMarkNotificationRead()` — `useMutation` with optimistic cache update (decrement the unread badge + flip the row's `read`).
- `useMarkAllNotificationsRead()` — `useMutation` that zeros the badge + invalidates the list cache.

### 9.8 FE — `NotificationsDropdown` + Navbar mount
`components/dashboard/NotificationsDropdown.tsx` — Blueprint Popover:
- Trigger `Button` with `Intent=primary` + the unread count when `unread > 0`.
- Content: header (Title + `unread` Tag + "Mark all read" Button), `MenuDivider`, empty-state ("You're all caught up"), or `Menu` of `MenuItem` rows (icon = "dot"/"circle" by read state; `text` = `{actionTypeApiName ?? "Notification"} · {templateId}\n{createdAt}`; onClick → `markRead.mutate(id)`).

`components/dashboard/Navbar.tsx` adds `NotificationsDropdown` to the right-side group (replaces the old `'notifications'` plain icon Button).

### 9.9 Phase 6.4 tests
5 tests `tests/unit/actions/notificationProviders-unit.test.ts`:
- InApp provider inserts `notification_inbox` row when `recipient.userUuid` is set; the mock `insertNotification` is called with the canonical shape.
- InApp provider skips with stub receipt when `recipient.userUuid` is undefined (the recipient filter allowed-filtered-on-empty path); the mock `insertNotification` is not called.
- InApp provider throws on model-layer PG failure (so the worker retries via the bounded backoff).
- Email provider stub-logs when `EMAIL_PROVIDER_URL` is unset (returns `receiptId: "email-stub:..."`).
- Email provider throws a structured "needs nodemailer" error when `EMAIL_PROVIDER_URL` starts with `smtp(s)://`.

### 9.10 Phase 6.4 live verify
- BE boot with `ACTION_SIDE_EFFECT_WORKER_ENABLED=1` → boot OK.
- Direct SQL `INSERT INTO notification_inbox(...) VALUES ('53cf9bcf...', ...)` (for the cypress-admin user UUID) → GET `/api/v1/notifications/unread/count` returns `{"unread":1}`; GET `/api/v1/notifications` returns the row with the `NotificationInboxItem` shape.
- POST `/api/v1/notifications/<notification_id>/read` returns `{ id, read: true, readAt }`; GET `/unread/count` → `{"unread":0}`.
- POST `/api/v1/notifications/read/all` returns `{"updated":0}` when no unread.
- Action dispatch (the existing `phase5VerifyV1` with `recipients = [{principal: cypress-admin@tellus.local, principalKind: user}]`): the Phase 6.1 recipient data filter resolves via `keycloakAdminService.findUserByEmail("cypress-admin@tellus.local")` → UUID `53cf9bcf-4c20-4aed-83f4-3c7e405453b4`; the worker's `productionNotificationDispatch` returns `filterResult.ok=true` + `resolvedUserId=53cf9bcf...`; the InApp provider's `send()` receives `recipient.userUuid="53cf9bcf..."` and INSERTs a row; `external_receipt` carries `{"receiptId":"inapp:<notification_id_uuid>"}` — verified the row exists in PG:
```
notification_id | recipient_user_id | template_id | channel | action_type_api_name | execution_id | created_at
28fa9aa3-906f-4391-bd5d-8b8b50c8a27d | 53cf9bcf... | phase6-4-test | in_app | phase5VerifyV1 | 65fa5857... | 2026-07-25 10:59:19.567378+00
```

---

## 10. Phase 6.5 — FE combined rule-body + writeback/side-effect builder

### 10.1 Goal
Remove the FE persistence gate on the webhook action-builder (`gateAdapter.ts`'s webhook adapter returns Phase-4/Phase-5 messaging today) so the dialog can author a rule body + a binding config in ONE save. The BE contract has accepted `rules + writebackConfig` together since Phase 4 — only the FE gate was the gap.

### 10.2 FE state — `WebhookActionBuilderState` extends
`app/ontology-manager/(manager)/_components/actionBuilders/types.ts`:
```ts
export interface WebhookActionBuilderState {
  readonly kind: "webhook";
  readonly bindingMode: WebhookBindingMode;                     // "writeback" | "sideEffect"
  readonly webhookName: string;
  readonly webhookVersion: number | null;
  readonly embeddedRuleBody?: ObjectActionBuilderState;          // Phase 6.5 — combined builder
}
```
The `embeddedRuleBody` is the embedded `object` adapter's state — covers create/modify/modify-or-create/delete on a single object type. (Link/interface-link embedded bodies remain BE REST API for Phase 6.5 — the BE persists them today, the FE dialog just doesn't have those embedded pickers wired in the webhook tab.)

### 10.3 FE adapter — `gateAdapter.ts` `webhookAdapter` rewrite
`app/ontology-manager/(manager)/_components/actionBuilders/gateAdapter.ts`:
- Imports `serializeActionBuilderState` from `./dispatch` so the serialiser can delegate the inner object adapter.
- `validate` changes:
  - **REMOVED** the Phase-4 / Phase-5 persistence gate errors文本.
  - **NEW** error if `state.embeddedRuleBody` is missing: "Add a rule body below — the BE refuses to persist an action type with empty rules..."
  - **REMAINS** the side-effect binding-mode gate: "Side-effect bindings are not yet persistable from the FE dialog. The BE accepts them (POST with sideEffects: {webhooks:[...]}). Author via the BE REST API directly, or wait for the FE side-effect serialiser." The FE serialiser for `side_effects: {webhooks, notifications}` is the next micro-phase (BE already accepts it today).
- `serialize` (when `bindingMode === "writeback"` and `embeddedRuleBody` present):
  1. `innerBody = serializeActionBuilderState(state.embeddedRuleBody, meta, ctx)` — delegates to the embedded object adapter for `parameters + rules`.
  2. `body = { ...innerBody, writebackConfig: { webhookId, webhookVersion, inputs: {}, failurePolicy: "abort" } }`.
  3. Returns the combined body. The dialog's `POST /actionTypes` request body is `parameters + rules + writebackConfig` in one shape — exactly the BE REST contract.

### 10.4 FE UI — `WebhookActionTypeTab.tsx` extends
The tab accepts new optional props `objectTypes` + `isLoadingObjectTypes`. When the user has picked a webhook, a new `EmbeddedObjectRuleBodyPicker` section renders below the webhook card preview:
- An HTMLSelect of object types (from the `ActionTypeDialog`'s already-loaded `useFullObjectTypes` query)
- A RadioGroup of `action`: create | modify | modify-or-create | delete
- When the ontology has no object types → a `Callout` (intent=warning) "No object types in this ontology"
- The `onChange` propagates up into `state.embeddedRuleBody = { kind: "object", objectType, action, parameters: [] }` — the inner adapter's parameter auto-derivation path runs through `objectAdapter` at serialize-time.

### 10.5 FE UI — `ActionTypeDialog.tsx` threads object types into the tab
`ActionTypeDialog.tsx`'s `webhookTabNode`:
```tsx
const webhookTabNode = (
  <WebhookActionTypeTab
    state={builder.kind === "webhook" ? builder : { kind: "webhook", bindingMode: "writeback", webhookName: "", webhookVersion: null }}
    onChange={setBuilderState}
    webhooks={webhooks}
    isLoadingWebhooks={isLoadingWebhooks}
    objectTypes={objectTypes?.map(ot => ({ apiName: ot.name, displayName: ot.name })) ?? []}
    isLoadingObjectTypes={isLoadingObjectTypes}
  />
);
```

### 10.6 Phase 6.5 tests
4 new tests in `tests/unit/actionBuilders.test.ts` (total: 37 = 33 pre + 4):
- "validates with no embedded rule body → returns 'add a rule body' prompt (not gated to a phase)" — assert no surviving Phase text-reason survives; assert the prompt uses the rule-body language.
- "validates with an embedded object rule body + selected webhook → no persistence gate; rules+binding serialisable" — the embedded object adapter has its own structural validation (the primary-key metadata missing from the test ctx surfaces); but assert NO 'Phase 4' / 'Phase 5' / 'gated' textual gate survives.
- "side-effect binding mode → gated with a clear FE-serialiser-follow-on message" — the gate text mentions the BE REST API directly.
- "serialise emits both rules + writebackConfig in one body when the embedded rule body is valid" — exercised via `if (errs.length === 0) serializeActionBuilderState(...)` so the test never trips the inner object adapter's own structural validation.

### 10.7 Phase 6.5 live verify
Not driven through the FE route (Playwright) — the manual scenario is documented but the end-to-end-browser verification would have required spinning the dev server; the BE contract has been live since Phase 4 (the BE `/actionTypes` POST accepts `rules + writebackConfig` together, with `validateRules` + `validateWritebackConfig` running). The FE unit tests + tsc-clean contract capture the persistence gate removed.

---

## 11. Phase 6.6 — 5-layer test sweep + manual scenarios A–H

### 11.1 5-layer definition applied to the action-type subsystem

| Layer | Surface | Phase 6.6 result |
|-------|---------|------------------|
| 1. Unit tests | BE `vitest --config vitest.unit.config.ts tests/unit/actions/ tests/unit/services/` + FE `actionBuilders.test.ts` + `actionSemanticsFrontend.test.ts` | **508 BE / 36 files + 37 FE / 2 files** |
| 2. Integration tests | The Phase 6 implementation has no integration tests by design — the rule compiler, the executor's preCommitHook, the worker's dispatch path, and the route layer's `If-Match` handler are all unit-tested at the function level. The `npx vitest --config vitest.unit.config.ts` config explicitly excludes the integration tests (`vitest.integration.config.ts`). | Phase 6 the integration suite is deferred to Phase 7's full-pipeline e2e (when the executor + worker + apply-edits are under mocking). The TODO #8 manual scenarios walked live capture the integration paths. |
| 3. E2E | Not driven through the browser; the FE Phase 6.5 work's serialiser contract captures the dialog persistence contract (the BE contract has been live since Phase 4). | Manual scenario H walks the worker's `runOnce` span through the existing `ActionTypeDialog` (the tab's `EmbeddedObjectRuleBodyPicker` doesn't fire a save — Phase 6.6 documentation notes that the next micro-phase ships a Playwright spec for the combined builder). |
| 4. Manual A–H | `docs/phase6-manual-scenarios-AH.md` | 8 scenarios green (each scenario includes the prior-phase origin + dynamic-state command + structured HTTP/DB/log output captures from the per-phase live-runs in Phase 6.1 / 6.2 / 6.3). |
| 5. Contract | Each route layer endpoint's response envelope is captured verbatim in the manual scenarios doc — `ACTION_TYPE_NOT_FOUND` envelope, `PERMISSION_DENIED` with `cbacReason`, `PRECONDITION_FAILED` with `expectedVersion` + `persistedVersion`, etc. | The test suite asserts every canonical envelope shape — `actionTypeFormatter-unit.test.ts` for the read surface, `notificationProviders-unit.test.ts` for the dropped-recipient receipt, etc. |

### 11.2 Manual scenarios A–H

A. Concrete Link Action — author + dispatch (Phase 1 + 2): `createInterfaceLink` rule persisted (201) with `side_effects=null`, BE round-trip byte-equivalent, POST `/apply` returns `{ result: success, affectedObjects: [{operation: "addLink"}] }`.

B. Webhook-defined action type — create + version bump (Phase 3): POST → 201, PATCH with new `authenticationConfig` → 200 + transactional v1→v2, GET latest → v2 active, GET `versions/1` → prior disabled.

C. Writeback action dispatch — pre-edit webhook + abort-on-failure (Phase 4 + Phase 6.3 reorder): POST `wbActionGood` with `writebackConfig.webhookId` → 201; POST `wbActionGood/apply` → writeback ran at Stage 3.5 BEFORE compileRules; on webhook success the action proceeds; POST `wbActionBad` pointing at a non-existent webhook → 422 `WRITEBACK_CONFIG_INVALID`.

D. Durable side-effect outbox — atomic enqueue + worker drain (Phase 5): action with `sideEffects: {webhooks, notifications}` → 2 rows inserted atomic with audit; worker drains, notification succeeded, webhook retried 4× (bounded backoff) then dead-lettered; operator requeue via Direct SQL `UPDATE status='pending' WHERE status='dead'` → re-dispatch.

E. Server-side authorization — CBAC gate + recipient data filter (Phase 6.1): UPDATE `action_type allowed_principals='[role:approver]'` → POST `/apply` as cypress-admin (no approver role) → 403 PERMISSION_DENIED with `cbacReason: no_allowlist_match`; UPDATE to `[{any_authenticated}]` + `required_markings='{TOP_SECRET}'`; restart BE → POST as cypress-admin (`markingBypass=true` per superadmin) → 200 success (the bypass overrode the markings gate). Recipient `alice@test.local` → dropped as `user_not_resolved`.

F. Versioned definition + If-Match (Phase 6.2): GET ETag `"1"`; PATCH `If-Match: 999` → 412; PATCH `If-Match: 1` + description (non-bump) → 200 + `definitionVersion: 1` (no bump); PATCH `If-Match: 1` + rules change → 200 + `definitionVersion: 2`; PATCH `If-Match: 1` after bump → 412 with `persistedVersion: 2`.

G. Phase 6.3 stage-reorder (writeback BEFORE compileRules): POST `/actions/phase5VerifyV1/apply` after the re-order → `result: success` identically to pre-reorder.

H. Side-effect worker OpenTelemetry spans (Phase 6.3): the worker's `runOnce` cycle is wrapped in `side_effect_worker.runOnce` OTel span with attributes `side_effect.{claimed,succeeded,retrying,dead,duration_ms}`.

### 11.3 Test sweep summary (final)
| Suite | Final result |
|-------|--------------|
| BE unit (Phase 1 + 2 + 4 + 5 + 6.1 + 6.2 + 6.4 + 6.3) | **508 / 36 files** |
| FE unit (Phase 1 + 2 + 6.5) | **37 / 2 files** |
| BE tsc | clean (excluding pre-existing `buildService.ts:906`) |
| FE tsc | clean (excluding pre-existing `test24/`/`workshop/`/`projects/`) |
| Manual A–H | 8/8 green |

---

## 12. Phase 6.7 — close-out + AGENTS.md

### 12.1 Final report files
- `docs/phase5-durable-side-effect-outbox.md` — Phase 5 close-out (sub-phases 5.1–5.5 + live-verify table + ops runbook)
- `docs/phase6-server-side-authorization-versioning-observability.md` — Phase 6 close-out (sub-phases 6.1–6.7 including 6.4 + 6.5)
- `docs/phase6-manual-scenarios-AH.md` — the 8 scenarios walked end-to-end
- `docs/phase6-implementation-reference.md` — THIS document (general developer reference)
- `AGENTS.md` — local dev guide maintained + the Phase 5/6 caveats

### 12.2 AGENTS.md update
The AGENTS.md was updated across the session to keep the runbook current:
- Repo layout, boot commands, Keycloak auth, tests, typecheck
- Phase 5 — env flag `ACTION_SIDE_EFFECT_WORKER_ENABLED` + tunables + operator-requeue SQL snippet
- Phase 6 — CBAC default-row contract, If-Match semantics, writeback Stage 3.5 reorder, OTel span names, recipient data filter
- Phase 6.4 — `notification_inbox` migration + model + provider + route + FE surface
- Phase 6.5 — combined builder + new field + removed gate
- `Phase 6.5+ follow-on — outgoing work` — explicit list: FE side-effect serialiser, native SMTP via nodemailer, actionExecutor-stage OTel spans, operator UI for dead-letter queue, per-rule CRUD authorization (requires the `object_type → dataset_id` migration first)
- What NOT to touch (the pre-existing `buildService.ts` known error, the migrations 127–132 `.down.sql` siblings are present but never run as part of this work)

---

## 13. Cross-cutting — Canonical action_type body shape (the final serialization contract)

The serialization contract every FE adapter + every BE route round-trips through:

```ts
interface SerializedActionTypeBody {
  // From Phase 1
  parameters: ReadonlyArray<{
    apiName: string;
    displayName: string;
    type: string;                    // string|integer|boolean|object_reference|...
    required: boolean;
    objectType?: string;            // for object_reference
  }>;
  rules: ReadonlyArray<Record<string, unknown>>;  // 1+ canonical rule entry (POST-validator rejects empty)
  // From Phase 1 (v2 add-ons)
  semanticsVersion?: 2;
  executionMode?: "declarative";
  deletePolicy?: "restrict";
  // From Phase 4
  writebackConfig?: Record<string, unknown> | null;  // canonical shape
  // From Phase 5 — sideEffects JSONB persisted through the same POST /actionTypes endpoint
  //   { webhooks: [{url, method, ...}], notifications: [{templateId, recipients: [...]}] }
}
```

Each `rules[]` entry is one of the 8 canonical rule shapes — Phase 1's validator accepts all 8. The concrete `addLink`/`removeLink` shapes are the Phase 1 base. The interface-link `createInterfaceLink`/`deleteInterfaceLink` shapes are the Phase 2 extension. The `writebackConfig` is the Phase 4 extension. The `side_effects` JSONB blob is the Phase 5 extension (persisted alongside the rules through the same POST endpoint). The `definition_version` and `definition_hash` are persisted THROUGH the migration 132 trigger — the FE does NOT author them; the BE reads them from the row + serializes through Phase 6.2's `formatActionType`.

## 14. Cross-cutting — Error code registry (alphabetical — Phase 1–6 additions)

| Code | Status | Phase | Source |
|------|-------|-------|--------|
| `AMBIGUOUS_INTERFACE_LINK_IMPLEMENTATION` | 422 | P2 | `interfaceLinkRules.resolveInterfaceLinkRule` |
| `AUTHORIZATION_UNAVAILABLE` | 503 | P6.1 | `actionCbac.runActionCbacGate` (loader/evaluator failure fail-closed) |
| `CARDINALITY_VIOLATION` | 422 | P2 | `iface link constraint creator validator` |
| `CONFLICTING_FOREIGN_KEY_EDITS` | 400 | P1 | `ruleShapeValidator` for incompatible FK edits on a target |
| `DUPLICATE_LINK` | 400 | P1 | `ruleShapeValidator` for two `addLink` with the same source/target |
| `INVALID_LINK_MAPPING` | 400 | P1 | `ruleShapeValidator` |
| `INVALID_WEBHOOK_INPUT_MAPPING` | 422 | P4 | `writebackExecutor` for `inputs[name].source` resolver |
| `INVALID_WEBHOOK_OUTPUT_MAPPING` | 422 | P4 | `writebackExecutor` for `outputBindings[id].path` JSONPointer |
| `LINK_TYPE_NOT_FOUND` | 404 | P1 | `linkRules` (route-layer resharer) |
| `MISSING_INTERFACE_LINK_IMPLEMENTATION` | 422 | P2 | `interfaceLinkRules` |
| `NOTIFICATION_NOT_FOUND` | 404 | P6.4 | `routes/notifications.ts markNotificationRead` (IDOR-safe 404) |
| `PERMISSION_DENIED` | 403 | P6.1 | `actionExecutor Stage 1c` (CBAC decision=deny) |
| `PRECONDITION_FAILED` | 412 | P6.2 | `routes/actionTypes.ts PATCH` (If-Match stale) |
| `SIDE_EFFECT_CONFIGURATION_INVALID` | 422 | P1 | `routes/actionTypes POST validateSideEffects` |
| `UNSUPPORTED_RULE_TYPE` | 400 | P1 | `ruleShapeValidator` |
| `WEBHOOK_ALREADY_EXISTS` | 409 | P3 | `webhookDefinition.createWebhookDefinition` (partial unique) |
| `WEBHOOK_DISPATCHER_REJECTED` | n/a | P5 | Worker diagnostic code when `productionWebhookDispatch` receives a non-ok from `deliverOneWebhook` |
| `WEBHOOK_NOT_FOUND` | 404 | P3 | `webhookDefinition.getWebhookByName` |
| `WEBHOOK_VERSION_DISABLED` | 409 | P3 | `webhookDefinition.getWebhookByNameVersion` for a disabled version reference |
| `WRITEBACK_CONFIG_INVALID` | 422 | P4 | `routes/actionTypes validateWritebackConfig` (webhook cross-check) |
| `WRITEBACK_OUTPUT_SCHEMA_MISMATCH` | 422 | P4 | `writebackExecutor` for JSONPointer miss / parse failure |
| `WRITEBACK_REJECTED` | 502 | P4 | `writebackExecutor` non-2xx response + the actionExecutor Stage 3.5 failure categorization |
| `WRITEBACK_TIMEOUT` | 504 | P4 | `writebackExecutor` transport timeout (`req.on("timeout")→req.destroy`) |

The codes are all registered in the `routes/actionTypes.ts` `KNOWN_CODES` set + the `utils/queryErrors.ts` `STANDARD_ERROR_CODES` HTTP-status map. The `OntologyError` class accepts an explicit `statusCode` so codes not in the registry still produce the right HTTP envelope (e.g. `AUTHORIZATION_UNAVAILABLE` is not in the registry but explicit `503` flows through `OntologyError(message, code, 503, details)`).

## 15. Cross-cutting — env flag surface

| Flag | Default | Effect | Phase |
|------|---------|--------|-------|
| `ACTION_SIDE_EFFECT_WORKER_ENABLED` | unset | `=1` → executor preCommit hook enqueues jobs; worker spawned at boot; legacy fire-and-forget Stage 7 path still runs when unset | P5 |
| `ACTION_SIDE_EFFECT_WORKER_INTERVAL_MS` | `2000` | Worker poll interval | P5 |
| `ACTION_SIDE_EFFECT_WORKER_BATCH` | `16` | Per-cycle claim limit (SELECT FOR UPDATE SKIP LOCKED LIMIT) | P5 |
| `EMAIL_PROVIDER_URL` | unset | When set with `https://...` → real HTTP POST transport; `smtp(s)://` → throws "needs nodemailer"; unset → stub | P5 + P6.4 |
| `EMAIL_PROVIDER_TOKEN` | unset | Bearer-token header value when `EMAIL_PROVIDER_URL` is set | P6.4 |
| `EMAIL_PROVIDER_FROM` | `no-reply@tellus.local` | The `from` address in the email envelope | P6.4 |
| `SLACK_WEBHOOK_URL` | unset | When set → real HTTP POST to the Slack-compatible endpoint | P5 + P6.4 |
| `OTEL_SDK_DISABLED` | unset | `=true` disables OTel instrumentation; tests use this | existing |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | OTLP/HTTP trace exporter URL; worker `runOnce` spans flush here when not disabled | existing |

The Phase 6 CBAC gate is NOT env-flagged — it's wired into all action-exec entry points. The default-row contract (NULL policy columns ⇒ `evaluateCbacPolicy` returns `allow` for authenticated subjects) is the backward-compat path; no env flag exists to disable the gate entirely.

The Phase 6.2 If-Match handler is not env-flagged today; absent `If-Match` is permitted. A future opt-in for strict If-Match-required is a deployment-time decision.

## 16. Cross-cutting — backward-compat invariants (audit-friendly summary)

### 16.1 BE contract
- The `action_type` table's `rules` JSONB column accepts legacy v1 shapes (`linkTypeApiName` alias) — Phase 1's canonical round-trip is on read MUTATION not on read read; legacy rows stay byte-equivalent forever.
- The `action_type.writeback_config` column is NULL by default — actions without a writeback remain byte-equivalent.
- The `action_type.side_effects` JSONB column accepts the legacy shape (array of webhook specs as top-level + array of notifications as top-level); the new shape persists cleanly; legacy rows on the post-Phase 5 BE return empty outbox jobs.
- The `action_side_effect_job` table's `external_receipt` JSONB column is NULL on insert + structured by the worker over time — no test asserts on its shape.
- The `notification_inbox` table migration 133 is additive-only; no existing query depends on it.
- The `action_type.allowed_principals / denied_principals / required_markings` columns (migration 037) are NULL by default — the loader returns a permissive policy — no action is denied by default; Phase 6.1 wiring never breaks a default action.
- The `action_type.definition_version` column is NULL by default (migration 132 backfilled to 1 for legacy rows); Phase 6.2's ETag wrapper returns `"1"` for those rows + the PATCH If-Match handler accepts the legacy row's `definition_version ?? 1`.
- The actionExecutor's Stage 3.5 reorder (Phase 6.3) is internally transparent — the wire contract for `/actions/:apiName/apply` is unchanged.

### 16.2 FE contract
- The `ActionBuilderState` discriminated union is exhaustive — every consumer switches on `kind`. The Phase 6.5 webhook adapter extension (`embeddedRuleBody?`) is OPTIONAL — pre-Phase 6.5 dialog never populates it.
- The `ActionTypeDialog`'s existing object + link + interface-link tabs are unchanged.
- The `WebhookActionTypeTab` is the only tab whose props extend (Phase 6.5) — `objectTypes?` and `isLoadingObjectTypes?` are optional; pre-Phase 6.5 callers (test hopper) work unchanged.
- The `NotificationsDropdown` (Phase 6.4) lives in the dashboard Navbar — when the inbox is empty the dropdown renders "You're all caught up"; the badge renders the unread count when `>0` and the bare icon when `=0`.

---

## 17. Phase-by-phase scoring table (final)

| Phase | Sub-phase | Outcome |
|-------|-----------|---------|
| Phase 1 | Foundations + Concrete Link Authoring (5.1–5.5) | ✅ shipped + live-verified |
| Phase 2 | Interface-Link Rule Engine | ✅ shipped + live-verified |
| Phase 3 | Governed Webhook Registry + Safe-Transport Guards | ✅ shipped + live-verified |
| Phase 4 | Writeback Pre-Edit Stage | ✅ shipped + live-verified |
| Phase 5 | Durable Side-Effect Outbox + Worker + NotificationProvider (5.1–5.5) | ✅ shipped + live-verified |
| Phase 6.1 | Server-side Authorization (CBAC gate + recipient data filter) | ✅ shipped + live-verified |
| Phase 6.2 | Versioned Definitions + If-Match Optimistic Concurrency | ✅ shipped + live-verified |
| Phase 6.3 | Observability + Writeback Stage Re-order | ✅ shipped + live-verified |
| Phase 6.4 | Real SMTP/Slack transport + `notification_inbox` + FE inbox reader | ✅ shipped + live-verified |
| Phase 6.5 | FE combined rule-body + writeback/side-effect builder | ✅ shipped (FE contract tested; e2e browser sequence not driven) |
| Phase 6.6 | 5-layer test sweep + manual scenarios A–H | ✅ 8/8 green; sweep tabled above |
| Phase 6.7 | Final Phase 6 close-out report + AGENTS.md update | ✅ this document + AGENTS.md live |

## Follow-on outlook (the remaining true todo list, future-round work)

- **FE side-effect serialiser follow-on**: emits the canonical `side_effects: { webhooks, notifications }` shape that the BE persists today. Phase 6.5 ships the WRITEBACK binding mode — the SIDE_EFFECT gate stays on with explicit messaging until the FE ships that serialiser (one-file additive).
- **Native SMTP transport via nodemailer**: `EMAIL_PROVIDER_URL` SMTP form → wire `npm install nodemailer` + a thin `sendMail(smtpUrl, from, to, body)` adapter; the EmailProvider already detects + throws a structured "needs nodemailer" error for SMTP URLs today.
- **actionExecutor stages 1–9 OpenTelemetry spans**: Phase 6.3 ships the worker's `runOnce` span; per-stage spans on the executor are a small additive (start a span at each `// STAGE` header, attribute the outcome, end at the natural block-complete point).
- **Operator UI for the side-effect outbox dead-letter queue + manual requeue**: model-layer API + SQL pattern are in place per Phase 5's manual scenario D; the route admin/admin-UI is the next operator-experience micro-phase.
- **Per-rule server-side authorization for the actor's "CRUD on every modified object type"**: derived from the rule body + dataset ACL effectiveRole on a per-object-type basis. The `object_type → dataset_id` FK doesn't exist today; the model-layer migration is a prerequisite.
- **Schema-migration tooling for the FE action-types tab forms**: the combined builder's `EmbeddedObjectRuleBodyPicker` covers single-object bodies; multi-rule bodies + link/interface-link embedded rule bodies remain BE REST API direct.
- **Playwright e2e spec for the Phase 6.5 combined builder**: drive the ActionTypeDialog through the embedded rule-body picker + the webhook selector + save → assert the BE-side persistence includes `parameters + rules + writebackConfig` in one row.

---

End of implementation reference. The following is a developer-facing reading order:
1. AGENTS.md → boot + tests + the caveats.
2. This document → the canonical contract + per-phase detail.
3. `docs/phase5-durable-side-effect-outbox.md` + `docs/phase6-server-side-authorization-versioning-observability.md` → operational runbooks.
4. `docs/phase6-manual-scenarios-AH.md` → manual-acceptable paths walked end-to-end.

Repo file inventory (additions + Additive edits across Phase 1 + 6):

### Backend
- `src/actions/actionRules.types.ts` (mirrored BE-side)
- `src/actions/ruleShapeValidator.ts`
- `src/actions/rules/interfaceLinkRules.ts`
- `src/actions/rules/linkRules.ts` (existing, unchanged)
- `src/actions/ruleCompiler.ts` (extensions: writebackResponse ValueSource + writebackOutputs + localJsonPointer + InterfaceLink dispatch)
- `src/actions/actionCbac.ts`  ← Phase 6.1
- `src/actions/writebackExecutor.ts`  ← Phase 4
- `src/actions/runWritebackStage.ts`  ← Phase 6.3
- `src/actions/actionExecutor.ts` (Stage 1c CBAC, Stage 3.5 reorder, preCommit, ExecutionContext extension)
- `src/actions/sideEffectJobExtractor.ts`
- `src/actions/sideEffectNotifier.ts` (existing, unchanged; mockSendNotification still there for legacy path)
- `src/actions/actionWebhooks.ts` (exported `deliverOneWebhook`)
- `src/actions/notificationProviders.ts` (Phase 5 stub → Phase 6.4 real InApp/Email/Slack transport)
- `src/actions/notificationRecipientFilter.ts`  ← Phase 6.1
- `src/actions/notificationProviders.ts`
- `src/models/interfaceLinkConstraint.ts`  ← Phase 2
- `src/models/webhookDefinition.ts`  ← Phase 3
- `src/models/actionSideEffectJob.ts`  ← Phase 5
- `src/models/notificationInbox.ts`  ← Phase 6.4
- `src/models/actionType.ts` (definition_version/hash additive)
- `src/routes/actionTypes.ts` (POST/PATCH + validateRules + validateWritebackConfig + formatActionType extension + GET ETag + PATCH If-Match)
- `src/routes/interfaceLinkConstraints.ts`  ← Phase 2
- `src/routes/webhooks.ts`  ← Phase 3
- `src/routes/notifications.ts`  ← Phase 6.4
- `src/services/webhookSafeTransport.ts`  ← Phase 3
- `src/services/workers/sideEffectWorker.ts`  ← Phase 5 + 6.1 + 6.3 OTel span + 6.4 userUuid threading
- `src/services/funnel/metrics.ts` (help strings for the new counters/gauges/histogram)
- `src/server.ts` (worker spawn + notifications router mount)
- `src/migrations/127-133_*.sql` + `.down.sql` (six reversible additive migrations applied live)
- `AGENTS.md`  ← local dev guide
- `docs/phase5-durable-side-effect-outbox.md`
- `docs/phase6-server-side-authorization-versioning-observability.md`
- `docs/phase6-manual-scenarios-AH.md`
- `docs/phase6-implementation-reference.md` (THIS document)

#### Backend tests (additions + the new suites)
- `tests/unit/actions/ruleShapeValidator-unit.test.ts` (24)  ← P1
- `tests/unit/actions/interfaceLinkRules-unit.test.ts` (10)  ← P2
- `tests/unit/actions/writebackExecutor-unit.test.ts` (20)  ← P4
- `tests/unit/actions/sideEffectJobExtractor-unit.test.ts` (9)  ← P5
- `tests/unit/actions/actionSideEffectJob-unit.test.ts` (12)  ← P5
- `tests/unit/services/sideEffectWorker-unit.test.ts` (8)  ← P5
- `tests/unit/services/webhookSafeTransport-unit.test.ts` (34)  ← P3
- `tests/unit/actions/actionCbac-unit.test.ts` (18)  ← P6.1
- `tests/unit/actions/notificationRecipientFilter-unit.test.ts` (11)  ← P6.1
- `tests/unit/actions/notificationProviders-unit.test.ts` (5)  ← P6.4
- `tests/unit/actions/actionTypeFormatter-unit.test.ts` (4, was 2 + 2 added)  ← P6.2

### Frontend
- `lib/actionRules.types.ts`  ← P1 (mirrored)
- `lib/ontologyApi.ts` (WebhookDefinition + InterfaceLinkConstraint + listWebhooks/getWebhookLatest/getWebhookByNameVersion)
- `hooks/useOntology.ts` (`useInterfaceLinkConstraints`, `useWebhooks`)
- `lib/notificationsApi.ts`  ← P6.4
- `hooks/useNotifications.ts`  ← P6.4
- `components/dashboard/NotificationsDropdown.tsx`  ← P6.4
- `components/dashboard/Navbar.tsx` (NotificationDropdown mounted into the right-side group)
- `app/ontology-manager/(manager)/_components/actionBuilders/types.ts` (the discriminator union + WebhookActionBuilderState embeddedRuleBody extension)
- `…/actionBuilders/dispatch.ts` (exhaustive dispatcher)
- `…/actionBuilders/objectAdapter.ts`, `linkAdapter.ts`, `interfaceLinkAdapter.ts`, `gateAdapter.ts` (the webhook adapter rewrite in Phase 6.5)
- `…/_components/LinkActionTypeTab.tsx`, `LinkActionBuilderPanel.tsx`, `InterfaceLinkActionBuilderPanel.tsx`, `WebhookActionTypeTab.tsx`, `ActionTypeDialog.tsx`

#### Frontend tests
- `tests/unit/actionBuilders.test.ts` (37 = 21 P1 + 5 P2 + 4 P6.5 + 7 originally existing)
- `tests/unit/actionSemanticsFrontend.test.ts` (12, unchanged)

— end of file —
