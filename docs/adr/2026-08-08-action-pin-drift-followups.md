# Follow-ups — Action-effect pin drift (2026-08-08)

Tracked debt and known-error items left over from the pin-identity /
compatibility tiering / repin / blast-radius work (commits `ae7df7b` …
`0444b9e` on `fixing-code-repository`, plus the read-path hash fallback
shipping with this note).

## 1. Audit-event naming: `AUTOMATION_EFFECT_PIN_*` vs the dotted convention

The pin lifecycle events (`AUTOMATION_EFFECT_PIN_REFRESHED`,
`AUTOMATION_EFFECT_PIN_UPGRADED`) do NOT follow the house
`automation.<verb>` dotted convention used by the rest of the Automate
audit ledger.

- **Why it matters:** audit consumers (the /audit endpoint UI, any future
  reporting) key off prefixes. Mixed conventions make filtered queries
  awkward.
- **Plan:** introduce dotted aliases (`automation.pin_refreshed`,
  `automation.pin_upgraded`) and dual-emit for one release; mark the
  underscore forms deprecated in `docs/auditing-data-structures.md`; drop
  the legacy forms when the UI no longer references them. Track the
  consumer list before flipping defaults — `automation_audit_event.event`
  is a free-text column, no FK, so nothing breaks mechanically, only
  queryability.
- **Not done inline** because the current UI has no filtering UI on these
  events yet, so the dual-emit adds ledger noise with no consumer benefit
  today.

## 2. Widened hash scope (rationale + conservatism tradeoff)

`hashActionDefinition` covers the full semantic superset — parameters,
rules, submissionCriteria, sideEffects, writebackConfig, functionConfig
and the semantics triple — not just the trigger-watched
`(parameters, rules)` subset the plan originally sketched.

- **Rationale:** every widened field is editable through the same PUT
  surface; an edit that bumps `definition_version` while leaving the hash
  unchanged would let a definition-benchmark pin pass as "identical" while
  runtime semantics moved.
- **Tradeoff:** the classifier maps changes to these fields as **breaking
  conservatively**; some runtime-benign edits (e.g. a sideEffects toggle
  that doesn't affect an automation's pin at all) will demand manual
  review instead of a silent refresh. This is deliberate: a false
  "compatible" silently re-binds an automation and is dangerous; a false
  "breaking" only costs a human review. If noise becomes a problem, add
  per-field nuance rows to the evolution table in
  `actionDefinitionCompat.ts` (single source of truth) rather than
  narrowing the hash.
- The read-path fallback in `formatActionType` computes the hash when the
  column is NULL (341 of 357 pre-rollout rows), so list endpoints always
  carry a non-null `definitionHash`; `syncDefinitionPinArtifacts()`
  persists the same value permanently on the next save. The fallback and
  the persisted path share one implementation, so they cannot diverge.

## 3. Known-flaky integration tests

Two integration tests fail both with and without this work (root cause is
environmental, not logic):

- `tests/integration/automate/object-condition.integration.test.ts`
  — depends on the shared local PG (`tellus-postgres-1`) having the
  Keycloak test users provisioned (`TEST_USER_SEEDS`); on a dev box that
  has also run Cypress/object-explorer suites the seed state drifts and
  assertions on principal shape flake. Observation window: 3 runs, 2
  failures, 1 pass, identical with the feature stashed.
- `tests/integration/automate/run-on-all-load.integration.test.ts`
  — subsumes the background runtime automations still LIVE on the shared
  DB (`Run-on-all load *` rows owned by earlier runs); concurrent trigger
  events from those legacy runs race this test's assertions.
  Observation: PASS / FAIL / PASS across consecutive runs, feature code
  unchanged.

**Plan:** give both suites a hermetic fixture: a per-suite ephemeral
database (we already do this in
`action-pin-drift-integration.test.ts` via `taut_pin_drift_<rand>`)
plus archiving the stray `Run-on-all load *` automations from dev
databases. Until then, failures of exactly these two should be treated as
infrastructure noise — both were verified green on clean fixtures in CI.

## 4. Operational notes worth remembering

- Dev-backend nodemon has detached from its watching child twice during
  this period (PID 1 parent, hot reload silently dead). Symptom: source
  edits never reflected in behavior. Watch for `uptime_seconds` climbing
  past a `touch` on a watched file, then restart `npm run dev`.
- One-time migration for pre-rollout automation drafts: re-select the
  action type in the effect editor and the draft autosaves with a stamped
  `definitionVersion` + `definitionHash` (verified end-to-end against the
  "422 repro" draft, 2026-08-08). No CLI is needed since the list endpoint
  now always returns a non-null hash.
