# On-Call Rotation

## Staffing

Minimum **4 engineers** to sustain 24×7 coverage. Under-staffed = freeze new deploys (per Appendix H).

## Escalation

- **Primary** — 5 min acknowledge.
- **Secondary** — escalated after 10 min.
- **Engineering Manager** — escalated after 15 min.

## Sev definitions

- **Sev-1** — customer data loss, regulatory incident, total availability loss. Page primary + secondary + EM immediately.
- **Sev-2** — partial availability loss, SLO breach > 1 hour, single-component failure without user impact visible but degrading.
- **Sev-3** — hygiene, tooling, non-customer-facing.

## Runbooks

Every Prometheus alert links to a runbook in `docs/RUNBOOK.md` (or `docs/chaos/*.md` for chaos scenarios).

## Tooling

PagerDuty or Opsgenie configured with the escalation above. Runbook URL in every alert annotation.
