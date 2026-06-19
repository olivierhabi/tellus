# ADR — Quiver B10: Dashboards, Visual Functions, Templates

**Status:** ACCEPTED — 2026-05-05
**Phase:** 5
**Owner:** Quiver Drive

## Context

B10 ships three publish surfaces:

1. **Dashboards** — view-only published canvas with parameter binding +
   embed-into Object View / Workshop integrations.
2. **Visual Functions** — published sub-DAGs with declared input/output
   signatures; consumers inline the sub-DAG byte-identically.
3. **Templates** — legacy create-only path retained for one release per
   spec; every response stamped `Deprecation: true` + `Sunset: 2026-11-04`.

## Decision

- All three surfaces live in `src/services/quiver/publishing/` with a single
  `publishingRouter` mounted at phase ≥ 5.
- Dashboards: immutable `quiver_dashboard_version` row per publish; consumers
  pin via `?version=<n>` or follow latest. Compass registration on publish
  rolls back on failure (B10 C-03).
- Visual Functions: input schema derived from declared `PARAMETER_*` cards;
  output type derived from root card's registry entry (B10 C-09).
- Embeds: not first-class RIDs; identifier shape `embed_<uuid>`.
- ETag-CAS via SHA-256/canonical-JSON (matches B1/B4 pattern).
- Idempotency-Key required on every POST publish.
- Templates: legacy headers stamped at the Express middleware layer.

## Decisions

- **D-63** Embed records use `embed_<uuid>` (not RIDs) — no Compass row,
  no need for cross-service resolution.
- **D-64** Dashboard PATCH only renames; structural changes require a
  republish (avoids Conjure Patch ambiguity vs Compass cache invalidation).
- **D-65** Visual Function inline returns the sub-DAG payload, not a
  resolved compute graph; the consumer's coordinator is responsible for
  inlining + resolving against its own analysis.
- **D-66** Templates retained one release per spec; explicit Sunset date
  stamped; new code paths must NOT call them.

## Tests

- Unit: schema shape, RID formats, derive-input-schema rules.
- Integration: 17 cases covering all 17 contracts (C-14 deferred to GATE-02).
- Compass-rollback: stubbed port that throws on register; assert no
  `quiver_dashboard` row remains.
- Templates: assert response headers carry Deprecation/Sunset.
