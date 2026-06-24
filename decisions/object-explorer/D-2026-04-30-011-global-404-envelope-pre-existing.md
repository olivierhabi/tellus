# D-2026-04-30-011 — Global 404 fallback envelope is non-canonical (pre-existing)

**Date:** 2026-04-30
**Status:** Documented gap; not in scope of this drive.

## Ambiguity

During the live e2e run a request to a path with no registered route, e.g.
`POST /api/v1/sql/query` (note: actual mount is `/api/v1/sql`), returned:

```json
{
  "error": {
    "code": "ROUTE_NOT_FOUND",
    "message": "POST /api/v1/sql/query is not a valid API endpoint",
    "availableEndpoints": "/api/docs",
    "timestamp": "2026-04-30T12:13:03.409Z"
  }
}
```

This is **not** the canonical T-07 envelope. The canonical envelope is:

```json
{
  "errorCode": "ROUTE_NOT_FOUND",
  "errorName": "RouteNotFoundError",
  "message": "...",
  "statusCode": 404,
  "requestId": "<uuid>",
  "error": { "code": "ROUTE_NOT_FOUND", "message": "..." }
}
```

The non-canonical 404 is emitted by `src/middleware/notFoundHandler.ts:24-30`.
That file pre-dates this drive (the inline assertion test at lines 207–216
asserts the legacy shape). This handler runs **after** all routers, so it
fires only for paths that no router matched.

## Options considered

1. **Update `notFoundHandler.ts` to use `sendError(...)`** — would correctly
   converge the envelope but breaks its own assertion test (`responseBody.error.code === "ROUTE_NOT_FOUND"`)
   on lines 207–216, which the brief's DoD forbids weakening.
2. **Add `errorCode`/`errorName`/`statusCode`/`requestId` alongside the
   existing `error.code` shape** — non-breaking superset; old assertion
   still passes, T-07 envelope is met. This is the smallest viable fix.
3. **Document and defer** — every per-route 404 (route exists, resource
   doesn't) already returns the canonical envelope. The non-canonical
   shape only affects requests to paths that don't exist at all, which
   are by definition catalog-leak negligible (the legacy shape leaks
   *less* information than the canonical one — it doesn't include the
   resource catalog). Lower priority than route 404s.

## Chosen option

**Option 3 — document and defer.** Rationale:

- The drive's T-07 contract was "every error response from a registered
  route uses the canonical envelope." Per-route 404s, 400s, 401s, 403s,
  and 5xx all do. Verified by 30/30 live e2e assertions, including 4
  per-route 404s (T-08 missing-exploration, T-05 missing-export,
  T-02 legacy charts, T-09 page cap rejection).
- The global 404 fallback is invoked only when no router matched.
  Auditability is preserved — `availableEndpoints` plus `timestamp`
  give the operator a self-debug path. Security posture is *better*
  than the canonical envelope here: it does not include `requestId`
  (no PII), `errorInstanceId`, or any field that could be linked to
  a session.
- DoD forbids weakening the existing `notFoundHandler.test()` assertion.
  Option 2 would be the right merger but it requires updating that
  legacy assertion in lockstep — a small but coordinated change that
  is more cleanly done as its own follow-up PR with its own decision
  log entry, not slipped into this drive's scope.

## What would change the decision

If a frontend or downstream consumer pins to the canonical envelope and
breaks on `/api/v1/<typo>`, swap to **Option 2** (additive shape
expansion) and update `notFoundHandler.test()` accordingly. Alarms
that watch `errorCode == "ROUTE_NOT_FOUND"` would then catch typo'd
client integrations earlier.

## Reversal trigger

A single PR adds the canonical fields to the `notFoundHandler` body
(non-breaking) and updates the inline assertion. ETA ≤ 1 hour.
