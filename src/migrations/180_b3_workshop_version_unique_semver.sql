-- Workshop B03 — enforce one version row per (rid, semver).
--
-- Prior to this migration, publishVersion created a new row for every
-- (rid, semver) publish — the "rollback timeline" PK on (rid, published_at).
-- This allowed duplicate (rid, semver) rows where only the newest row
-- answered `getVersion()` lookups, leaking a shadowing bug: rolling back
-- to 1.0.0 after editing produced a duplicate 1.0.0 row containing the
-- *new* definition, permanently obscuring the original 1.0.0 snapshot.
--
-- Fix: remove all-but-one duplicate rows (keep the earliest snapshot — the
-- true original), repoint `workshop_module.published_at` if it targeted a
-- purged row, then add a unique index on (rid, semver) so the shadowing
-- class can never recur.
--
-- Immutable Snapshots: workshop_module_version rows are never updated.
-- After this migration every (rid, semver) has exactly one row, and
-- publishVersion enforces idempotency-by-content for re-publish attempts.

-- ── Step 1: keep only the earliest row per (rid, semver) ────────────────
DELETE FROM workshop_module_version v
USING (
  SELECT rid, semver, min(published_at) AS keep_at
  FROM workshop_module_version
  GROUP BY rid, semver
) k
WHERE v.rid = k.rid
  AND v.semver = k.semver
  AND v.published_at > k.keep_at;

-- ── Step 2: repoint module published_at to the kept row if the current
--            published_at was deleted in Step 1. ─────────────────────────
UPDATE workshop_module m
SET published_at = v.published_at
FROM workshop_module_version v
WHERE v.rid = m.rid
  AND v.semver = m.published_semver
  AND m.published_at IS NOT NULL
  AND (m.published_at IS DISTINCT FROM v.published_at);

-- ── Step 3: uniqueness constraint — one row per (rid, semver) ───────────
CREATE UNIQUE INDEX IF NOT EXISTS uq_workshop_module_version_rid_semver
  ON workshop_module_version(rid, semver);