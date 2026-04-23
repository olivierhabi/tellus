# Incident Response

## Classification

- **Sev-1** — customer data loss, regulatory incident, total availability loss, Markings leak, audit chain break.
- **Sev-2** — partial availability, SLO breach > 1h, dependency outage with user-visible degradation.
- **Sev-3** — hygiene, tooling.

## Workflow

1. **Detect** — via Prometheus alert, customer report, synthetic probe.
2. **Triage** — primary on-call assigns severity.
3. **Stabilize** — stop the bleeding (rollback, feature flag, circuit-breaker force-open).
4. **Recover** — restore full function.
5. **Post-mortem** — blameless, within 72h for Sev-1/2. Template:
   - Timeline
   - Root cause (5-whys)
   - Blast radius
   - Mitigation
   - Action items (owner + date)
6. **Regulatory** — if taxpayer data affected, notify DPA within 72h per Law 058/2021 Art. 31.

## Drills

Monthly tabletop exercise reviewing a past incident or hypothetical (Appendix H.1).
