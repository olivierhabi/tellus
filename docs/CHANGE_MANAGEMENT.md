# Change Management

## Deploy checklist (production)

- [ ] Green CI (all gates: unit, integration, coverage ≥80%, CVE scan, typecheck).
- [ ] Green staging soak at 1× SLO for ≥1 hour.
- [ ] Not Friday 16:00+ local; not during regulatory audit window.
- [ ] PR description contains rollback plan.
- [ ] Post-deploy verification checklist in PR.
- [ ] On-call primary acknowledged.

## Migration deploys

- [ ] Dry-run on restored-from-backup copy of production.
- [ ] Execution time estimate documented.
- [ ] Explicit `.down.sql` validated on same data.
- [ ] DBA (or equivalent) sign-off.
- [ ] Locking vs `CONCURRENTLY` verified.
- [ ] `ENFORCE_AUDIT_HASH_CHAIN` / analogous feature flags considered for pre/post-deploy toggles.

## Emergency change

Requires EM sign-off. Documented post-facto within 24h.
