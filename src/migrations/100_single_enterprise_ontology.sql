-- ===========================================================================
-- 100_single_enterprise_ontology.sql
-- "One Enterprise, One Ontology" — gated auto-consolidation
-- ===========================================================================
-- Folds the engine onto a single enterprise ontology. The actual work lives in
-- consolidate_single_ontology() (migration 099). This migration is the GATE:
--
--   * Fresh / small databases  → consolidate INLINE inside the migrate runner's
--     transaction (CALL with batch_size 0). Cheap and safe to auto-apply.
--
--   * Large multi-ontology databases → REFUSE to run a long single-transaction
--     merge on boot. Raise with instructions to run the batched, backup-first
--     script (scripts/single-ontology/consolidate.sh). This blocks an
--     unattended deploy from locking a production table for minutes.
--
-- The inline threshold (rows pending re-point) is overridable per-environment
-- via the `tellus.consolidation_inline_threshold` GUC.
--
-- Canonical identity: UUID 00000000-0000-0000-0000-000000000001,
-- RID ri.ontology.main.ontology.00000000-0000-0000-0000-000000000001.
-- ===========================================================================

DO $gate$
DECLARE
  canon       CONSTANT uuid := '00000000-0000-0000-0000-000000000001';
  n_other     bigint;
  pending     bigint;
  threshold   bigint;
BEGIN
  threshold := COALESCE(
    NULLIF(current_setting('tellus.consolidation_inline_threshold', true), '')::bigint,
    200000
  );

  SELECT count(*) INTO n_other FROM ontology WHERE ontology_id <> canon;

  IF n_other = 0 THEN
    -- Already single (or fresh). Idempotently ensure canon + main branch +
    -- singleton guard; no data is moved.
    CALL consolidate_single_ontology(0);
    RETURN;
  END IF;

  -- Estimate the volume the merge must re-point (the large data-key tables).
  SELECT
      (SELECT count(*) FROM object_instances           WHERE ontology_id <> canon)
    + (SELECT count(*) FROM ontology_edit              WHERE ontology_id <> canon)
    + (SELECT count(*) FROM link_edit                  WHERE ontology_id <> canon)
    + (SELECT count(*) FROM funnel_run                 WHERE ontology_id <> canon)
    + (SELECT count(*) FROM funnel_signal              WHERE ontology_id <> canon)
    + (SELECT count(*) FROM funnel_changelog_watermark WHERE ontology_id <> canon)
    INTO pending;

  IF pending <= threshold THEN
    -- Small enough to fold safely inside this migration's transaction.
    CALL consolidate_single_ontology(0);
  ELSE
    RAISE EXCEPTION USING
      ERRCODE = 'raise_exception',
      MESSAGE = format(
        'Refusing to auto-consolidate %s ontologies (%s rows pending) in a single transaction.',
        n_other, pending),
      HINT =
        'Run the batched, backup-first consolidation instead: '
        'bash scripts/single-ontology/consolidate.sh '
        '(it pg_dumps, CALLs consolidate_single_ontology in chunks, records this '
        'migration, then verifies). Or raise tellus.consolidation_inline_threshold '
        'if you accept a long single-transaction merge.';
  END IF;
END
$gate$;
