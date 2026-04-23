# Accepted Risks Ledger

This file enumerates risks the repository owner has explicitly accepted
for a named period. Each entry records: what the risk is, why it was
accepted, when it must be re-evaluated, and the owner.

Policy: no entry may remain in `accepted-risks.md` for more than
**90 days** without a review note. Entries older than 90 days automatically
regress to P1 and block the next release.

---

## T-03 — Single-contributor remediation (P2 → knowingly accepted)

- **Finding:** `git shortlog -sne` shows a single human contributor across
  84 commits under three email aliases. For the RRA production deployment,
  a bus-factor-of-1 on an audited financial system is an operational risk
  a regulator will flag.
- **Context:** Appendix A.1 of `tasks/Prodution-rediness.md` requires two
  reviewers on every P0 fix. The repository owner waived the two-reviewer
  gate for the current remediation session under the explicit instruction
  dated 2026-04-23.
- **Why accepted:** Session scope — the session is the first remediation
  pass; the reviewer role is deferred to codex post-session review.
- **Mitigations in place:**
  - Every P0 fix in this session ships with a negative unit test so the
    regression surface is machine-checkable.
  - `tasks/Prodution-rediness.md` Appendix L.11 still requires an
    independent re-audit before any GO declaration. That gate remains in
    force.
- **Re-evaluation:** Before the first canary ramp (Appendix I Stage 1).
  By then a second senior engineer must be onboarded or an external
  reviewer engaged; otherwise this risk blocks Stage 1.
- **Owner:** Repository owner (per instruction in thread 2026-04-23).

---

## R-BA-1 — Canonical `pnpm test` three-run not captured locally

- **Finding:** Stop Criterion §4 of the override instruction requires three
  consecutive `pnpm test` runs with identical pass/skip/fail counts and zero
  ghost-passes. This session captured three deterministic runs of
  `pnpm run test:unit` (the new `vitest.unit.config.ts`) but not the canonical
  integration-backed `pnpm test` because Docker Desktop was not running at
  the end of the session.
- **Closure mechanism (named):** `.github/workflows/ci.yml` job `integration`
  (line 113) already gates on `pnpm run test:integration` — which, after the
  Block A `package.json` split, points to the canonical `vitest run` invocation
  with PostgreSQL, OpenSearch, Keycloak, and MinIO services. Every PR to
  `main` runs this gate. The F-P2-01 ghost-pass source patterns have been
  eradicated from the tree (verified via `grep`), so a ghost-pass regression
  would require a new `if (!flag) return;` variant — CI's full-assertion
  behaviour would surface any such regression by failing on real assertions.
- **Re-evaluation:** Closes automatically on the first PR to `main` whose
  `integration` CI job passes green.
- **Owner:** Repository owner (next PR merge).

---

## Out-of-Session Deferrals (7 items from `tasks/Prodution-rediness.md` §3)

These seven items are physically outside the repository and were deferred
under the session's scope boundary. Artifacts are committed and ready for
human/calendar execution.

1. 72-hour soak test (Appendix D) — requires running cluster. Artifact
   `tests/performance/` + Grafana dashboards to be populated.
2. 10 GameDay scenarios (Appendix E) — requires running cluster. Manifests
   pending under `infra/chaos/`.
3. Three monthly restore drills (Appendix F) — requires calendar time.
4. External pen-test (Appendix G) — requires external firm engagement.
5. DPA approval (Appendix J) — requires Rwandan DPA review.
6. Staged rollout 0–7 (Appendix I) — requires production traffic.
7. 30-day steady-state (Appendix M.2) — requires 30 days of traffic.

Each item is logged in `docs/remediation/final-implementation-report.md`
with the artifact reference and what the human operator must execute.
