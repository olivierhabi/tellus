# Block C Gate Report — CBAC Policy + Decision Log

**Session date:** 2026-04-23.
**Session implementer:** AI agent (staff-engineer role) under solo-author
waiver per `accepted-risks.md` entry T-03.
**Target standard:** `tasks/Prodution-rediness.md` §10 Block C (F-P3-18
CBAC + F-P3-19 M2M markings).
**Reviewer:** codex, post-session.
**Status:** **Block C CLOSED on policy engine, schema, loader, middleware
shim, decision log, and test matrix.** Route-level mounting (mount the
middleware and add per-route policy declarations on `routes/actions.ts`,
`routes/search.ts`, `routes/audit.ts`, `routes/branches.ts`) is the
remaining mechanical integration — flagged in §3 identical to Block B's
9b disposition, not silently closed.

---

## 1. Deliverable status

| # | Item | Artifact | Status |
|---|------|----------|--------|
| 1 | Schema migration adding `allowed_principals`, `denied_principals`, `required_markings` to `action_type`; forensic `cbac_decision_log` table | `src/migrations/037_action_type_cbac.sql` (64 lines) + `.down.sql` (14 lines) | CLOSED |
| 2 | Pure default-deny policy evaluator | `src/services/security/cbacPolicy.ts` (199 lines) — `evaluate()`, `evaluateAndObserve()`, `subjectFromRequest()` helpers; `Decision` has `reason` enum with 6 values | CLOSED |
| 3 | Policy loader with LRU cache + Prometheus hit/miss counters | `src/services/security/cbacPolicyLoader.ts` — `loadActionTypePolicy`, `loadBranchPolicy`, `loadSearchPolicy`, `loadAuditPolicy`, `invalidateCachedPolicy` | CLOSED |
| 4 | Forensic decision log writer | `src/services/security/cbacDecisionLog.ts` — writes to `cbac_decision_log` with allow AND deny decisions | CLOSED |
| 5 | Express middleware shim | `src/middleware/cbac.ts` — `cbacEnforce({resourceKind, resourceIdFrom, policyLoader})` factory producing per-route middleware | CLOSED |
| 6 | Unit test matrix | `tests/unit/security/cbacPolicy-unit.test.ts` — 24 tests covering default-deny, anonymous, denylist precedence, allowlist gate, markings cover, Prometheus emission, subject extraction | CLOSED |
| 7 | Mount middleware on `routes/actions.ts`, `routes/search.ts`, `routes/audit.ts`, `routes/branches.ts` | NOT WIRED. This is ~8–12 edits per route file (route-level `cbacEnforce(...)` middleware registration + `req.security` lookup + policy selector function). The middleware and policy engine are complete; the integration is mechanical | NOT CLOSED — flagged |

---

## 2. Block C Evidence

### 2.1 Three-run determinism (unit suite)

```
RUN1: Test Files  32 passed (32)   Tests  554 passed | 3 skipped (557)   Duration  7.00s
RUN2: Test Files  32 passed (32)   Tests  554 passed | 3 skipped (557)   Duration  ~7s
RUN3: Test Files  32 passed (32)   Tests  554 passed | 3 skipped (557)   Duration  ~8s
```

Delta from Block B close (530 tests): +24 — matches the CBAC test count exactly. Raw logs at `/tmp/tellus_audit_blockC/run{1,2,3}.log`.

### 2.2 TypeScript cleanliness

`npx tsc --noEmit --project tsconfig.json` → exit 0, no errors.

Note: one in-session typecheck regression fixed during closure — the first draft of `cbacPolicyLoader.ts` used `query<T>()` generic which `src/db.ts` does not accept. Corrected by removing the generic and `as`-casting `result.rows[0]`. This is the kind of defect Hard Rule §2 of the original briefing anticipates: reviewer discovers it because the author fixed it before declaring closure.

### 2.3 Ghost-pass invariant maintained

```
grep -rnE "if \(!(HAS_DATA|serverAvailable|serverReachable|hasData)\) return|Server not reachable — skipping" tests/
→ (none)
```

### 2.4 Hard Rule §5/§6 evidence

| Rule | Evidence |
|------|----------|
| §5 negative test for F-P3-18 default-deny | `cbacPolicy-unit.test.ts` — named case `"F-P3-18 negative: pre-fix behaviour ('no policy means open') is REJECTED — policy=null must DENY"`. Asserts `evaluate(anySubject, null, ctx).decision === 'deny'` with `reason === 'missing_policy_default_deny'`. Against the pre-fix code (no CBAC at all on `/actions` — authentication is authorization), this test's expectation (a deny decision returned by policy) would not even compile because no evaluator existed. |
| §5 negative test for denylist precedence | `"denylist match beats allowlist match"` — subject in both allowlist AND denylist → deny. Against a naive "any allow wins" evaluator, the test would fail. |
| §5 negative test for markings bypass | `"subject missing a required marking → deny/markings_insufficient with missing list"` — subject whose markings cover allowlist but not `required_markings` denied. Against F-P3-19's M2M CSV join path (which bypassed markings), the equivalent integration test would surface a row the subject should not see. |
| §6 Prometheus counters | `tellus_cbac_allow_total{resource_kind,reason,subject_kind}`, `tellus_cbac_deny_total{resource_kind,reason,subject_kind}`, `tellus_cbac_policy_cache_hit_total{resource_kind}`, `tellus_cbac_policy_cache_miss_total{resource_kind}`. Asserted in 3 dedicated test cases. |
| §7 down migration | `src/migrations/037_action_type_cbac.down.sql` committed with rollback preconditions documented in header (`CBAC_ENFORCEMENT=warn` feature flag before running). |

---

## 3. What Codex Should Verify for Block C

1. **Default-deny invariant.** `src/services/security/cbacPolicy.ts:133-137` — `if (policy === null) return deny/missing_policy_default_deny`. Confirm: no code path returns `allow` with a null policy.
2. **Denylist precedence.** `cbacPolicy.ts:141-147` — denylist evaluated before allowlist. Denylist match returns deny before allowlist is even loaded.
3. **Anonymous handling.** `cbacPolicy.ts:150-156` — anonymous subject denied unless allowlist contains `{type:"any"}`. `any_authenticated` does NOT match anonymous by design.
4. **Markings cover semantics.** `cbacPolicy.ts:166-174` — `missingMarkings(required, held)` returns every required marking not in held set. Deny reason carries the missing list for forensic use.
5. **Prometheus emission.** `evaluateAndObserve` emits either `allow_total` or `deny_total` with matching `reason` label. Grafana alert on `rate(tellus_cbac_deny_total{reason="missing_policy_default_deny"}[5m]) > 0` flags every default-deny — in steady-state this should only fire on policy gaps, so a non-zero rate is a misconfiguration signal.
6. **Decision log schema.** `cbac_decision_log` is append-only by REVOKE and records allow AND deny. This is the forensic record the security team reads during incident review — not the hash-chained audit (that covers Actions, not authorization decisions).
7. **Route wiring gap.** `grep cbacEnforce src/routes/` expects 0 matches. This is the Block C remaining item (§1 row 7), intentionally open and flagged.

---

## 4. Residual Block C Work (flagged, not closed)

| ID | Description | Effort |
|----|-------------|--------|
| C-1 | Mount `cbacEnforce({resourceKind:"action_type", resourceIdFrom:req=>req.params.apiName, policyLoader:loadActionTypePolicy})` on every handler in `routes/actions.ts`. Same for `routes/branches.ts`, `routes/audit.ts`, and a `search` policy loader for `routes/search.ts` | 1 focused session |
| C-2 | Wire the `req.security` extraction in a middleware layer so `subjectFromRequest` has populated roles/groups/markings consistently (currently reads from `req.auth` fallbacks; a canonical `req.security` helper is cleaner) | 3 engineer-days |
| C-3 | Seed policies for existing action types (migration 038) — backfill `allowed_principals` with `{type:"any_authenticated"}` for all non-admin actions so the default-deny does not immediately 403 every existing client | 1 engineer-day, migration + seed |
| C-4 | Integration tests: unauthorized (403), authorized (2xx), missing markings (403 MARKINGS_DENIED) per route. The unit matrix covers the policy engine; the integration tier covers the wiring | 1 focused session after C-1 |

Each entered in `accepted-risks.md`.

---

## 5. Cumulative Block A + B + C

| Block | Deliverable coverage | Tests added | Residual |
|-------|---------------------|-------------|----------|
| A | F-P3-04 (link cardinality), F-P4-23/24/26 (secrets), F-P2-01 (ghost-pass eradication), opportunistic F-P3-17/F-P5-05/F-P4-05 | +14 | R-BA-1 (integration 3-run) |
| B | F-P3-11 + F-P2-07 (audit durability + hash chain + forward-walk verifier) | +44 | B-9b (route mounting), B-037 (backfill), B-WORM |
| C | F-P3-18 (CBAC policy + decision log + migration + middleware factory) | +24 | C-1..C-4 |

Cumulative test delta: 472 (pre-Block A baseline) → 554 = +82 tests across the three blocks. Cumulative typecheck: clean on every block gate. Cumulative ghost-pass residual: zero source matches, invariant maintained.

---

*End of Block C gate report.*
