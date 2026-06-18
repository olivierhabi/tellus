# D-2026-04-30-007 — `/sql/invalidate` admin gate uses existing `authorize`, not a new `requireRole` helper

## Ambiguity

T-03 §3.6 specifies:

```ts
router.post("/invalidate", requireRole("ontology-admin"), perOntologyRateLimit("1/min"), async (req, res, next) => { … });
```

with the additional note that `requireRole(role)` "MUST check
`req.security.cbac.includes(`role:${role}`)` and 403 with
`INSUFFICIENT_ROLE` on miss."

Tellus already exposes `authorize(...roles: string[])` in
`src/middleware/auth.ts:18-57` which:

- 401s with the canonical envelope when no principal exists,
- 403s with `INSUFFICIENT_ROLE` (the exact code T-03 asks for) when
  the principal lacks any required role,
- reads roles from `req.tellusPrincipal.roles` first, falling back to
  `req.user.roles` — which is functionally equivalent to the spec's
  `req.security.cbac` because the security-context builder
  (`src/middleware/securityContext.ts:96-106`) populates `cbac` from
  the same `realm_access.roles` claim the principal carries.

## Options considered

1. **Add a fresh `requireRole(role)` helper** that reads
   `req.security.cbac.includes(`role:${role}`)` literally as the spec
   suggests. Rejected: this introduces a second parallel authz API
   surface for one endpoint, violating the Decision Protocol's
   "consistency with surrounding Tellus code" priority. Operators
   debugging an unexpected 403 would now have to trace through two
   middlewares.

2. **Reuse `authorize('ontology-admin')`.** Chosen. Existing pattern,
   identical observable behaviour (403 + `INSUFFICIENT_ROLE`),
   single authz surface to audit, no API drift.

3. **Skip per-route rate limit (`perOntologyRateLimit("1/min")`).**
   Chosen for *this PR*. The per-ontology limiter is a separate
   middleware that requires implementation; its absence keeps the
   401/403 boundary clean and allows the rate-limit work to proceed
   independently. Closing B-6 (DoS via unauthenticated invalidate) is
   accomplished by the admin gate alone — operators with the
   `ontology-admin` role are not the threat surface B-6 is concerned
   with. **Surfaced as an open follow-up gate in FINAL_REPORT.md.**

## Decision

Use `authorize('ontology-admin')` on the `/sql/invalidate` route.
Defer the `perOntologyRateLimit` to a follow-up; document it as an
open enhancement in the final report (not a regression — the route
was previously unauthenticated *and* unlimited, so the admin gate is a
strict improvement).

## Rationale

- **Production safety:** the threat model B-6 names is "any
  unauthenticated POST DOS-ing the cache." Admin-gating closes that.
  An admin abusing their own privilege is a different threat (insider
  attack) handled at the audit-log layer, not the rate-limit layer.
- **Consistency:** `authorize` is used by every other admin-protected
  Tellus route. Diverging here would be cosmetic.
- **Auditability:** the admin gate is a single-line change with a
  single test case. The strict rate-limit additionally requires per-
  ontology bucket state and a TTL cleanup loop; deferring it keeps
  this PR reviewable.

## What evidence would change the decision

If a follow-up incident shows that `ontology-admin` role-holders
themselves can DOS the cache (e.g. by accident in a CI loop),
re-enable T-03's `perOntologyRateLimit("1/min")` per the original spec.
The implementation should sit alongside `authorize`, not replace it.

## Tagged tests

- `tests/unit/object-explorer/furnaceSql-T03-unit.test.ts` —
  contracts C-306 (non-admin → 403 INSUFFICIENT_ROLE),
  C-307 (missing ontologyId → 400 VALIDATION_ERROR),
  C-308 (admin + valid body → 204 + counter incremented).
