# Steady-State Observation Protocol (Appendix M.2)

Production is declared steady-state when:

1. Stage 7 (100% traffic, all tenants) has been live for **30 consecutive days**.
2. All 10 M.1 invariants (see Appendix M.1) were green every day for the window.
3. No Sev-1 or Sev-2 incident attributable to remediation work in those 30 days.

## Observation procedure

- Daily at 09:00 local, on-call checks Grafana `tellus-m1` dashboard.
- Any red invariant — rollback Stage 7 → Stage 6, page EM.
- Any Sev-1/Sev-2 — steady-state clock resets to day 0 after remediation.
- Day-30 close — EM + security lead countersign `FINAL_AUDIT_SIGNOFF.md`.

## Post steady-state

M.1 invariants continue as production engineering discipline indefinitely. Quarterly re-certification (1 eng-week). Annual pen-test refresh.
