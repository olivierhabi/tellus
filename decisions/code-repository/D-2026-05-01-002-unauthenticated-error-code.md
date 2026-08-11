# D-2026-05-01-002 — Add UNAUTHENTICATED to the §1.3 errorCode enum

## Ambiguity

Spec §1.3 enumerates exactly 10 errorCode values:

```
INVALID_ARGUMENT, PERMISSION_DENIED, NOT_FOUND, CONFLICT,
FAILED_PRECONDITION, RESOURCE_EXHAUSTED, INTERNAL, UNAVAILABLE,
DEADLINE_EXCEEDED, QOS_THROTTLE
```

But §1.2 G-C-08 separately mandates that missing or invalid auth must
return **401 with `Stemma:Unauthenticated` envelope**. None of the 10
codes maps to HTTP 401:

| code | spec status |
|---|---|
| INVALID_ARGUMENT | 400 |
| PERMISSION_DENIED | 403 |
| NOT_FOUND | 404 |
| CONFLICT | 409 |
| FAILED_PRECONDITION | 412 |
| RESOURCE_EXHAUSTED | 429 |
| INTERNAL | 500 |
| UNAVAILABLE | 503 |
| DEADLINE_EXCEEDED | 504 |
| QOS_THROTTLE | 429 |

The spec is internally inconsistent: G-C-08 demands a 401, the enum
forbids one.

## Options considered

1. **Reuse PERMISSION_DENIED for 401.** Map authn failure to errorCode
   `PERMISSION_DENIED`, status 401. Rejected: PERMISSION_DENIED is the
   canonical authz code (its spec status is 403). Overloading it for
   authn loses the audit-time distinction between "you didn't prove who
   you are" and "we know who you are and you cannot do this." Auditors
   downstream cannot tell the two apart, breaking forensic queries.

2. **Reuse INVALID_ARGUMENT for 401.** Map authn failure to
   `INVALID_ARGUMENT`. Rejected: a missing token is not a malformed
   request body — clients distinguishing 400 from 401 in retry policies
   (which is correct: 400 is non-retriable, 401 is "refresh and retry")
   would conflate them. Worse: the existing tellusAuth middleware
   already returns 401 with errorCode `TOKEN_INVALID` (a Tellus-internal
   code), so we'd be regressing the production semantics.

3. **Add UNAUTHENTICATED as the 11th code.** Map UNAUTHENTICATED → 401.
   Mirrors the gRPC canonical status set
   (`google.rpc.Code.UNAUTHENTICATED = 16`). Standard, unambiguous, and
   the smallest legal extension of the spec.

## Chosen option

**Option 3.** Add `UNAUTHENTICATED` to `ERROR_CODES`, map to HTTP 401.

## Rationale

Per the Decision Protocol's priority order:

- **Production safety** (priority 1): unauthenticated and unauthorized
  must be distinguishable in audit logs. Forensic queries depend on it.
- **Consistency with existing Tellus conventions** (priority 2): Tellus's
  existing `tellusAuth` middleware already returns 401 with a code
  (`TOKEN_INVALID`); we are aligning the Code Repos surface with that
  precedent rather than diverging.
- **Foundry-faithful** (priority 5): Foundry / Conjure error envelopes
  use `UNAUTHENTICATED` for the 401 case (`Conjure:NotAuthorized`
  family). The gRPC standard does the same. This is the established
  precedent in the ecosystem this spec is modelled on.

## What evidence would change this

- A clarification in spec §1.3 that 401 is intentionally unrepresentable
  in the errorCode enum and that the routing layer should emit a
  WWW-Authenticate header without an envelope at all.
- A clarification that 401 should reuse PERMISSION_DENIED with a
  documented overload.

Either would invalidate this decision and the implementation would
need to back out `UNAUTHENTICATED` from `ERROR_CODES`.

## Contract IDs that depend on this decision

- G-C-08 (401 envelope), G-C-13 (closed enum), G-C-15 (HTTP mapping),
  B1-C-30 (Stemma:Unauthenticated derivation).

## Tests pinned to this decision

- `tests/unit/code-repos/contracts/error-envelope-unit.test.ts`:
  - "contains the 10 codes from spec §1.3 plus UNAUTHENTICATED (D-2026-05-01-002)"
  - "D-2026-05-01-002: UNAUTHENTICATED maps to HTTP 401"
- `tests/integration/code-repos/middleware/auth-integration.test.ts`:
  - covers the live 401 path emitting the envelope.

If this decision is reversed the unit test will fail loudly, surfacing
the dependency before any integration test runs.
