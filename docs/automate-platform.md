# Tellus Automate platform

Last verified: 2026-07-30

Tellus Automate is a durable, permission-aware orchestration domain built on
the canonical Tellus ontology, Action Type, Function, notification, identity,
and audit services. The frontend editor is in the sibling `tellus-fe`
repository at `/automate/new`.

## Architecture

```text
server draft + revision
  -> backend schema and activation validation
  -> immutable automation_version
  -> schedule or durable source event
  -> condition evaluation
  -> stable trigger event
  -> ordered effect plan
  -> leased effect worker
  -> canonical Action / Function / notification adapter
  -> attempts, outputs, audit, and history
```

Definitions and operational state are deliberately separate. An execution
always points to the immutable version that planned it, so editing or pausing
an automation cannot rewrite an in-flight execution.

The runtime provides at-least-once delivery. Database uniqueness, stable
trigger keys, stable effect IDs, activation/retry idempotency records, Action
idempotency propagation, atomic claims, and expiring worker leases limit
duplicate planning and permit recovery after process termination. External
Functions and notification providers must still follow the idempotency
guidance appropriate to their side effects.

## Reused Tellus systems

- Ontology metadata and Object Set Service v2 for object selection, secure
  queries, pagination, and point-in-time scheduled evaluation.
- Durable `object_set_event` records for live object-change processing.
- Action Type discovery and `executeAction()` for validation, authorization,
  ontology writes, Action audit, and idempotency.
- Function Registry versions, signatures, artifact hashes, and the canonical
  sandboxed query-Function runtime.
- Keycloak users plus Tellus JWT, role, group, marking, CBAC, organization, and
  tenant context.
- Side-effect outbox and configured notification providers.
- PostgreSQL migration, transaction, structured logging, and metrics patterns.

Automate adds only the orchestration definition, validation, scheduling,
condition state, execution planning, retry, history, and audit layers that did
not previously exist.

## Runtime semantics

Lifecycle transitions are validated server-side. Drafts do not run; active
automations evaluate; paused automations stop producing new events; muted
automations advance schedules without planning effects; archived and disabled
automations cannot be claimed.

Scheduled work and retries use indexed PostgreSQL due-work queries. Schedulers
and workers claim bounded batches with `FOR UPDATE SKIP LOCKED`. Claims have an
owner and expiry; an abandoned claimed/running effect becomes eligible again
after its lease. Active effect workers renew their lease while a canonical call
is in flight and completion uses a compare-and-set owner check, so a stale
worker cannot commit after another worker recovers the claim. No retry or
schedule depends on browser state or an in-memory timer.

Parallel effects are independently claimable and cannot bind sibling outputs.
Sequential effects are claimable only after every earlier primary effect
succeeds. A terminal earlier failure records later effects as skipped.
Successful effects are reused by event retry; only failed portions are
replanned. Fallbacks are nested, depth-one effect definitions and run only after
the primary exhausts its retry policy.

Effect retries and event retries are independent. Each effect attempt is stored
in `automation_effect_attempt`; durable retry time is stored on the effect
execution. Retry delay supports constant or exponential backoff and bounded
factor/duration jitter. Condition evaluation failures have their own bounded,
durable exponential retry schedule.

## Conditions

| Condition | Modes | Implementation |
| --- | --- | --- |
| Time | scheduled | Cron or interval, IANA timezone, deterministic next run, missed-run policy |
| Objects added | live, scheduled | Durable object events or persisted membership diff |
| Objects removed | live, scheduled | Durable object events or persisted membership diff |
| Objects modified | live, scheduled | Selected-property filtering and canonical-value comparison |
| Run on all | scheduled | Point-in-time, cursor-paginated bounded batches |
| Threshold crossed | scheduled | Typed expression tree plus previous-state transition detection |
| Automation dependency | automation-dependent | Persisted parent-completion event, delay, status filter, cycle prevention |
| Time series | unavailable | No permission-aware canonical Tellus time-series alert source |
| Stream | unavailable | No user-facing canonical Tellus stream registry |
| Metric changed | unavailable | Sunset surface; the supported metric behavior is Threshold crossed |

The backend-owned compatibility matrix is returned by
`GET /api/v1/automations/compatibility` and is used by validation and the UI.

## Effects

- **Action** pins ID, API name, definition version/hash, validates typed
  bindings, rechecks schema/enablement at execution, and invokes the canonical
  Action executor.
- **Function** pins Function/repository RIDs, semantic version, branch and
  artifact hash, validates published parameter bindings, and invokes the
  canonical query-Function sandbox. Edit Functions remain behind Action Types.
  The current canonical sandbox limit is five seconds.
- **Notification** supports real users, in-platform delivery, configured email,
  Keycloak group expansion, plain or canonical query-Function generated
  content, pinned Function releases, strict output validation, grouping,
  locale, safe URLs, shared preview/delivery rendering, HTML escaping,
  delivery status, and failure reporting.
- **Fallback** supports a validated depth-one Action fallback after exhaustion.
- **Logic** is unavailable because Tellus has no canonical Logic registry and
  runtime. It is visibly disabled; Automate does not disguise Logic as Action.

Unsupported attachment/document rendering and type-aware dynamic recipient
selection remain visibly disabled because their named canonical dependencies
do not exist.

Action, Function, Notification, scheduled-condition, threshold, and live-object
execution re-read the owner account before work. Current realm roles determine
superadmin marking bypass; the activation snapshot cannot preserve bypass after
role revocation. A disabled or deleted owner fails closed, and condition
evaluation durably disables the automation with an audit reason.

## API

All routes require authentication and tenant isolation. Mutation routes that
change definitions or lifecycle additionally require ontology write access.
Owner and configured administrators may read history and operate an
automation; user administrators and current members of configured Keycloak
administrator groups are supported. Inaccessible records are not disclosed.

| Method and route | Request | Response / purpose |
| --- | --- | --- |
| `GET /api/v1/automations/compatibility` | none | Backend condition-mode matrix |
| `GET /api/v1/automations/discovery/users` | `q`, `limit` | Enabled, accessible Keycloak users |
| `GET /api/v1/automations/discovery/groups` | `q`, `limit` | Accessible Keycloak groups |
| `POST /api/v1/automations/preview/notification` | `{ effect }` | Sanitized render; never sends |
| `POST /api/v1/automations/preview/threshold` | ontology ID and threshold condition | Permission-aware dry evaluation of metrics and pinned Boolean Functions |
| `POST /api/v1/automations/drafts` | ontology ID, optional definition | Server draft, revision and ETag |
| `POST /api/v1/automations/repin` | `{ actionTypeId, strategy: "latest-compatible", dryRun }` | Fleet re-pin of action pins to the current definition via the compatibility classifier; dry-run returns identical classification with zero writes; applied migrations audit `AUTOMATION_EFFECT_PIN_UPGRADED` |
| `GET /api/v1/automations` | ontology, cursor, limit | Permission-filtered paginated list |
| `GET /api/v1/automations/:id` | none | Definition, state, revision and ETag |
| `PATCH /api/v1/automations/:id/draft` | revision, definition | Updated draft or version conflict |
| `POST /api/v1/automations/:id/validate` | optional definition | Structured step/path issues |
| `POST /api/v1/automations/:id/activate` | revision; `Idempotency-Key` header | Immutable active version and next run |
| `GET /api/v1/automations/:id/history` | cursor, limit | Trigger execution history |
| `GET /api/v1/automations/:id/evaluations` | limit | Condition evaluation history |
| `GET /api/v1/automations/:id/audit` | limit | Definition/lifecycle/operation audit |
| `GET /api/v1/automations/:id/executions/:eventId` | none | Effects, attempts, fallbacks and outputs |
| `POST /api/v1/automations/:id/executions/:eventId/retry` | `Idempotency-Key` header | Durable event retry |
| `POST /api/v1/automations/:id/executions/:eventId/cancel` | none | Cancels eligible pending work |
| `POST /api/v1/automations/:id/pause` | optional reason | Lifecycle transition |
| `POST /api/v1/automations/:id/resume` | optional reason | Lifecycle transition |
| `POST /api/v1/automations/:id/mute` | optional reason | Lifecycle transition |
| `POST /api/v1/automations/:id/unmute` | optional reason | Lifecycle transition |
| `POST /api/v1/automations/:id/archive` | optional reason | Terminal lifecycle transition |

Canonical discovery remains at its owning APIs: ontology/object-set endpoints,
Action Type endpoints, and Function Registry endpoints. Automate does not copy
those registries.

Errors use stable codes such as `AUTOMATION_DEFINITION_INVALID`,
`CONDITION_MODE_UNSUPPORTED`, `DEPENDENCY_CYCLE`,
`AUTOMATION_VERSION_CONFLICT`, `ACTION_SCHEMA_CHANGED`,
`BINDING_TYPE_MISMATCH`, and `OWNER_PERMISSION_DENIED`. Responses do not expose
internal stack traces.

Action-effect pins are tracked in four tiers on activation validation:
`ACTION_DEFINITION_CHANGED_COMPATIBLE` (warning — pin auto-refreshed on
activation, `AUTOMATION_EFFECT_PIN_UPGRADED` audit), content-only refreshes
(`AUTOMATION_EFFECT_PIN_REFRESHED`), `ACTION_DEFINITION_CHANGED_BREAKING`
(hard error carrying a structural `changes[]` summary plus remediation:
re-select the action type in the effect editor), and the legacy alias
`ACTION_DEFINITION_CHANGED` for pins whose pre-history snapshot is
unknowable. See `src/services/automate/actionDefinitionCompat.ts` for the
evolution rule table (the single source of truth); edit-time call sites:
`POST /api/v1/ontology/:ontologyId/actionTypes/:apiName/blastRadius`
(pre-save blast radius) and the `blastRadius` field on the action-type PATCH
response.

## Persistence

Migration 143 creates:

- `automation`
- `automation_version`
- `automation_dependency`
- `automation_condition_state`
- `automation_trigger_event`
- `automation_effect_execution`
- `automation_effect_attempt`
- `automation_idempotency`
- `automation_audit_event`

Migration 144 adds durable `automation_condition_evaluation` jobs and
`automation_object_membership` snapshots. Migration 145 adds bounded durable
condition-evaluation attempts and `next_attempt_at`.

Indexes cover due schedules, due evaluations/effects, expired leases,
permission/list queries, parent dependencies, membership, and paginated
history. Foreign keys, status checks, attempt bounds, unique trigger keys, and
unique effect identities enforce operational invariants in the database.
Forward and rollback migrations follow the repository convention.

## Operations

The API process starts the Automate scheduler, condition evaluator, and effect
worker after migration/schema gates and stops them during graceful shutdown.
Relevant structured metrics include due schedules, condition/effect latency,
trigger creation, success/failure, retry/exhaustion, duplicate suppression,
stale leases, notification failure, and auto-mute.

Use configurable bounded worker batches and polling intervals for horizontal
scale. Object enumeration is paginated and effects are individually
transactional; no database transaction remains open across an Action,
Function, or notification provider call.

Run the focused verification suite:

```bash
pnpm exec tsc --noEmit
pnpm exec vitest run --config vitest.automate.config.ts
pnpm exec vitest run --config vitest.automate.integration.config.ts
```

The integration suite requires a migrated isolated PostgreSQL database and
verifies revision conflicts, immutable/idempotent activation, concurrent
scheduler claims, duplicate worker claim prevention, expired-lease recovery,
an eight-automation scheduler/worker burst, parallel effect independence,
sequential failure gating, successful fallback resolution, event retry limits,
successful-effect reuse, and persisted lifecycle transitions through terminal
archive. It also verifies automatic scheduling of retryable terminal event
failures with durable parent/retry lineage and parent-completion creation of a
claimable child trigger. Trigger queueing is verified separately from internal
effect ordering: the second event cannot claim until the first completes.
Auto-mute is verified from terminal event samples through the persisted mute
reason, administrator notification, and audit decision.

The run-on-all large-set load suite
(`tests/integration/automate/automate-run-on-all-load-integration.test.ts`)
creates a dedicated 2,500-instance object type, indexes it through the
production OpenSearch sync pipeline (stamping the `__ontology`/`_security`
fields the OSS v2 read path requires), and drives the real scheduled
condition evaluator: point-in-time cursor pagination examines every object
exactly once in bounded batches, one deduplicated trigger and exactly one
notification effect lands per object, and a repeated evaluation key
deduplicates cleanly. Both integration files tolerate a co-running dev
server's automate runtime by asserting terminal state and invariants
(exactly-once, head-of-line serialization) rather than which worker claimed
each effect; effects must be executed with the same workerId that claimed
them, since `executeClaimedEffect`'s lease checks no-op silently on a
lease_owner mismatch.

For a local canonical Time-to-Action execution:

```bash
AUTOMATE_VERIFY_OWNER_ID=<keycloak-user-id> \
  pnpm exec tsx scripts/verify-automate-time-action.ts
```

The script creates and activates a definition, forces a due schedule, runs the
workers, checks the canonical Action execution and resulting ontology object,
and prints the automation, trigger, effect, and Action execution identifiers.

For manual restart/recovery verification (durable retry across a backend
restart, lease recovery after worker termination):

```bash
bash scripts/verify-automate-restart-recovery.sh
```

The script kills and restarts the real API server process between phases
(16 checks, last run 2026-07-30 passed 16/16). Scenario 1 fails every
attempt of an email-channel effect retryably (the SSRF egress guard
blocks the unroutable `EMAIL_PROVIDER_URL` with a retryable 503),
kills the server during the retry delay, and verifies attempts 2-3 run
after the kill, the effect reaches terminal `exhausted`, no effect
notification is delivered, and the owner receives one
`automate.effect-failure` in-app notification. Scenario 2 leaves an
effect in the exact durable state a terminated worker leaves
(`claimed`, dead lease owner, live lease) and verifies the restarted
worker respects the lease, recovers after expiry, and executes exactly
once with no duplicate delivery. The companion
`scripts/verify-automate-restart-recovery.ts` drives the repository
APIs; the shell script records every check to
`/tmp/restart-recovery-report.txt`.

Environment caveat: OpenSearch indices created before the current
mapping generator (e.g. a legacy `ontology-taxpayer`) map `__ontology`
as `text`; the OSS v2 read path terms the field and matches nothing,
so the condition evaluator sees zero objects for that type. Repair by
reindexing into an index built from `generateIndexMapping` and
swapping the object-type alias (done for `ontology-taxpayer` on
2026-07-30, all 2,691 documents preserved).
