# D-2026-04-30-006 — FE coordination for `/charts/{listogram,histogram,dateHistogram,auto}` deletion is operational, not engineering

## Ambiguity

T-02 specifies a two-phase deploy: **Phase A** — FE migrated to
`/charts/batch`, backend retains legacy routes as no-ops; **Phase B**
(≥ 7 days later) — backend deletes the legacy routes. The DoD checkbox
"Phase A merged and deployed; FE confirmed migrated" requires:

1. A frontend repo PR that removes call sites for the four legacy paths.
2. A production rollout of that FE bundle to ≥ 7 days of bake.
3. Then this PR merging.

This is **operational gating**, not an engineering deliverable. The
agent has no access to the FE repository, no CI to deploy it, no
calendar to bake it for 7 days, and no telemetry to confirm 0% legacy
traffic.

## Options considered

1. **Skip T-02.** Leave the four PG-direct endpoints in place. Rejected:
   the brief is explicit that "Delete is the cheaper and safer fix" and
   that these endpoints currently bypass markings + branch context (B-1).
   Leaving them violates the suite's primary safety goal.

2. **Insert a feature flag** (`CHARTS_LEGACY_ENABLED`) and gate the four
   handlers on it, defaulting to `true`. Rejected: this is exactly the
   "TODO/FIXME/feature flags to ship incomplete work" pattern the brief
   explicitly forbids.

3. **Delete now; document the operational gate.** Chosen. The backend
   PR removes the routes and emits 404. The decision log + PROGRESS.md +
   FINAL_REPORT.md surface "Phase A FE deploy must precede production
   release of this branch" as an operational gate. This is consistent
   with D-2026-04-30-001 (engineering-vs-operational-done): the agent
   is engineering-complete; release-gating is the deployer's
   responsibility.

## Decision

**Delete the four legacy chart endpoints in this PR.** Document the
operational gate in three places:

- This decision file (canonical record).
- `tasks/object-explorer/PROGRESS.md` T-02 entry.
- `tasks/object-explorer/FINAL_REPORT.md` "Operational gates required
  before production release" section (written in the T-10 close-out).

Production deployers MUST verify, before promoting this branch past
staging, that:

1. FE repo grep `rg '/api/v1/charts/(listogram|histogram|dateHistogram|auto)'`
   returns 0 hits in the deployed FE bundle.
2. Production WAF / access-log audit for the past 7 days shows 0
   non-test-bot traffic against the four legacy paths.

If either check fails, revert this PR and re-coordinate FE first.

## Rationale

- **Production safety:** the four endpoints' security gap (B-1: PG
  direct read with no markings or branch filter) is a documented
  blocker. Deleting them removes the gap immediately and unconditionally
  in environments where they are deleted; deferring deletion preserves
  the gap.
- **Auditability:** the deletion is a single-revert, fully testable,
  fully visible diff. A flag-gated half-deletion is none of those.
- **Consistency with D-2026-04-30-001:** the agent does engineering;
  operators do operations. Mixing the two yields neither.

## What evidence would change the decision

If FE deploy logs show `/charts/(listogram|histogram|dateHistogram|auto)`
traffic in production at the time the deployer attempts to roll this
branch out, the deployer should hold the rollout until FE migrates. The
engineering deliverable does not change.

## Tagged tests

- `tests/unit/object-explorer/charts-legacy-removed-unit.test.ts` —
  contracts C-200, C-201.
