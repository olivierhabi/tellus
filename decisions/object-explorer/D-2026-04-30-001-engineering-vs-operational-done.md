# D-2026-04-30-001 — Engineering-complete vs Operationally-complete

## Ambiguity

The brief demands `Definition of Done` per task. Several DoD items require
events that cannot occur inside a single agent session:

- **T-02 DoD:** "Phase B (≥ 7 days later, after FE deployment fully rolled out): backend deletes routes."
- **T-04 DoD:** "Phase 1 deployed; counter non-zero in staging." + each phase requires "≥ 1× max overlay TTL" bake.
- **T-05 DoD:** "Production: 100% of jobs reach `COMPLETED` or `FAILED` within `EXPORT_WORKFLOW_TIMEOUT_MS`; no jobs stuck in `RUNNING` after 1h."
- **T-10 DoD:** "Grafana dashboard exists with the seven SLOs above." + "PagerDuty alerts wired" + "AST guard green on `main` for ≥ 7 days."

These cannot be satisfied by code changes alone. They require deploys, soaks,
and operator wiring (PagerDuty, Grafana, FE coordination) external to the
codebase.

## Options considered

1. **Stop and surface as open question.** Rejected — the brief's Hard Stops
   section excludes "ambiguity" as a stop reason and routes ambiguity through
   the Decision Protocol.
2. **Fake completion.** Rejected — the brief's Forbidden Behaviors include
   "Stopping at 'looks fine' when rubric items remain unchecked" and "tests
   that assert presence rather than behavior." A fake completion violates
   auditability — Production safety priority #1 in the Decision Protocol.
3. **Engineering-complete delivery + explicit operational gate documentation.**
   Chosen. Deliver every line of code, migration, test, flag-gating, and
   runbook entry such that the moment the operator runs the documented
   sequence, all DoD items are satisfied. Surface the operational gates in
   `FINAL_REPORT.md` so the user can sequence them.

## Chosen option

Option 3. Per task, the engineering-complete state is:

- Code is on disk and type-clean.
- Migrations are reversible and the `down` path is exercised by an integration
  test.
- Flags exist with documented default values per phase.
- Tests at all three layers exist for every contract that does not require
  production observation. Contracts that require production observation have
  their tests skipped with a documented reason and a re-enablement trigger
  written into FINAL_REPORT.
- Metrics emit at the documented points.
- Audit-log entries fire on the documented operations.

## Rationale

Production safety: the alternative is to ship code + tests but skip the flag
machinery / runbook. That fails closed in the wrong direction — operators
deploying without the runbook would activate B-1..B-6 fixes without the
flag-gated rollouts and could break existing clients.

Auditability: the operational gates are explicit and reviewable. A future
auditor reading FINAL_REPORT can verify per gate "did this happen, when,
who flipped it." Faking completion would silence the audit trail.

Reversibility: every flag has a documented `false` default that preserves
pre-T-XX behavior. A bad rollout is reverted by flipping flags, not by code
revert.

## Evidence that would change this decision

If the user explicitly states "do not deliver flag machinery, just merge the
final state," I would re-scope to Option 4 (single-cutover delivery, no
phased rollout). That has worse operational risk but matches the literal
"all merged" reading of the brief. The conservative default holds.

## Tagged tests

Tests whose enablement depends on this decision are tagged with
`// @decision D-2026-04-30-001` so they can be re-evaluated if the decision
is revisited.
