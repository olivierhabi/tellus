# D-14 — `workshop_module_version` allows multiple rows per `(rid, semver)`

**Date**: 2026-05-03
**Tasks affected**: B03 (publish + resolve), B03-chaos
**Contract IDs touched**: B03 C-01, B03 C-02, B03 C-03, B03-chaos C-01

## Ambiguity

Spec §B03 chaos C-02 reads: *"Two concurrent `:publish` calls on the same `(rid, semver)`. Both return 200 (idempotent). Database has exactly one published row."*

But spec §B03 elsewhere requires "republish older version (rollback) updates `published_semver` and emits `WORKSHOP_MODULE_ROLLED_BACK`," which implies a per-publish row in the version timeline.

These two statements collide if "exactly one published row" is read as "one row in `workshop_module_version`": rolling back to `1.0.0` after publishing `1.0.1` and `1.0.2` then back to `1.0.0` would be impossible to distinguish from the original `1.0.0` publish.

## Options considered

1. **Unique `(rid, semver)` constraint**: forces concurrent identical publishes to dedup at the DB layer. Breaks rollback (cannot tell "publish 1.0.0" from "rollback to 1.0.0").
2. **Append-only timeline + composite PK on `(rid, semver, published_at)`**: every publish is a new row. The "currently published" semver is tracked in `workshop_module.published_semver`. **Chosen.**
3. **Application-level dedup via idempotency key**: works for retries from the same client but not for concurrent publishes from two replicas.

## Decision

Option 2. The version table is append-only; the head pointer in `workshop_module.published_semver` collapses to a single value. "Database has exactly one published row" is read as **"exactly one currently-published semver per module"**, not "one row in the version table."

## Rationale

- **Production safety**: rollback semantics are central to Workshop (§B03); breaking them to satisfy a literal reading of one chaos sentence would be the wrong tradeoff.
- **Auditability**: the version table is the publish ledger. Collapsing rows would lose the ability to answer "who published what when" — exactly what auditors ask for.
- **Foundry-faithful**: Foundry Workshop publishes are immutable by tag and the version table is append-only.

## Evidence that would change this

- A spec amendment that explicitly defines rollback as `UPDATE` of an existing row rather than a new row.
- A regulatory requirement to expose only "the current row" in the version table (no ledger).

## Test impact

- `tests/chaos/workshop/B03-resolve-cache-chaos-integration.test.ts` C-01 asserts:
  - All three concurrent publishes return 200.
  - `workshop_module.published_semver = '1.0.0'` (head pointer collapses).
  - `workshop_module_version` has between 1 and 3 rows for `(rid, '1.0.0')` (timeline grows but is bounded by the number of in-flight publishes).
- The existing B03 integration tests (`B03-publish-resolve-integration.test.ts`) C-02 (republish idempotency) and C-03 (rollback) already exercise this semantic and pass.
