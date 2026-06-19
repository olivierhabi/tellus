-- ===========================================================================
-- 099_consolidate_procedure.sql
-- "One Enterprise, One Ontology" — reusable, batched consolidation procedure
-- ===========================================================================
-- Installs consolidate_single_ontology(p_batch_size int), the single source of
-- truth for folding every ontology-scoped row onto the canonical enterprise
-- ontology. It is invoked two ways:
--
--   * p_batch_size = 0  → INLINE. Runs entirely in the caller's transaction
--     with NO internal COMMIT. Used by migration 100 to auto-consolidate
--     fresh / small databases inside the migrate runner's per-file transaction.
--
--   * p_batch_size > 0  → BATCHED. Re-points the large data-key tables
--     (object_instances, ontology_edit, link_edit, funnel_*) in chunks of
--     p_batch_size rows, COMMITting after each chunk so locks stay short and
--     the migration scales to millions of rows. Called by
--     scripts/single-ontology/consolidate.sh (after a backup) via
--     `CALL consolidate_single_ontology(5000)` in autocommit mode.
--
-- Idempotent and resumable: re-running converges to the single-ontology state.
-- Installed in its own migration so it persists even when migration 100's gate
-- raises (rolls back) on a large database.
-- ===========================================================================

CREATE OR REPLACE PROCEDURE consolidate_single_ontology(p_batch_size int DEFAULT 0)
LANGUAGE plpgsql
AS $proc$
DECLARE
  canon        CONSTANT uuid := '00000000-0000-0000-0000-000000000001';
  canon_name   CONSTANT text := 'Enterprise Ontology';
  canon_branch uuid;
  old_mains    uuid[];
  r            record;
  new_name     text;
  n            bigint;
  cnt          bigint;
BEGIN
  -- 0. Free the canonical display name if a different row holds it.
  UPDATE ontology
     SET display_name = display_name || ' (legacy ' || left(ontology_id::text, 8) || ')'
   WHERE display_name = canon_name AND ontology_id <> canon;

  -- 1. Ensure the canonical ontology row.
  INSERT INTO ontology (ontology_id, display_name, description, created_by)
  VALUES (canon, canon_name,
          'The single enterprise ontology (One Enterprise, One Ontology).',
          'system')
  ON CONFLICT (ontology_id) DO UPDATE SET display_name = EXCLUDED.display_name;

  -- 2. Ensure the canonical `main` branch (deterministic UUIDv5, matches
  --    migration 040 and src/services/branchContext.ts).
  canon_branch := uuid_generate_v5(uuid_ns_dns(), canon::text || ':main');
  INSERT INTO ontology_branch (branch_id, ontology_id, name, status, created_by)
  VALUES (canon_branch, canon, 'main', 'OPEN', 'system')
  ON CONFLICT (ontology_id, name) DO NOTHING;
  SELECT branch_id INTO canon_branch
    FROM ontology_branch WHERE ontology_id = canon AND name = 'main';

  -- Snapshot the non-canonical `main` branches we will fold into canon_branch.
  old_mains := ARRAY(
    SELECT branch_id FROM ontology_branch
     WHERE ontology_id <> canon AND name = 'main'
  );

  -- 3. Resolve object_type api_name collisions BEFORE the merge. Keep one per
  --    api_name (canon wins; else most instances; else oldest) and rename the
  --    non-canonical losers, cascading the new name to rows keyed on it.
  FOR r IN
    WITH ranked AS (
      SELECT ot.object_type_id, ot.ontology_id, ot.api_name,
             row_number() OVER (
               PARTITION BY ot.api_name
               ORDER BY (ot.ontology_id = canon) DESC,
                        (SELECT count(*) FROM object_instances oi
                          WHERE oi.ontology_id = ot.ontology_id
                            AND oi.object_type_api_name = ot.api_name) DESC,
                        ot.created_at ASC, ot.object_type_id ASC
             ) AS rn
        FROM object_type ot
    )
    SELECT object_type_id, ontology_id, api_name FROM ranked
     WHERE rn > 1 AND ontology_id <> canon
  LOOP
    new_name := r.api_name || '__' || left(r.object_type_id::text, 8);
    UPDATE object_type SET api_name = new_name WHERE object_type_id = r.object_type_id;
    UPDATE object_instances SET object_type_api_name = new_name
      WHERE ontology_id = r.ontology_id AND object_type_api_name = r.api_name;
    UPDATE ontology_edit SET object_type_api_name = new_name
      WHERE ontology_id = r.ontology_id AND object_type_api_name = r.api_name;
    UPDATE funnel_run SET object_type_api_name = new_name
      WHERE ontology_id = r.ontology_id AND object_type_api_name = r.api_name;
    UPDATE funnel_signal SET object_type_api_name = new_name
      WHERE ontology_id = r.ontology_id AND object_type_api_name = r.api_name;
    UPDATE funnel_changelog_watermark SET object_type_api_name = new_name
      WHERE ontology_id = r.ontology_id AND object_type_api_name = r.api_name;
    RAISE NOTICE '[consolidate] renamed colliding object_type % (%) -> %',
                 r.api_name, r.object_type_id, new_name;
  END LOOP;

  -- 4. Migrate non-`main` branches to canon (rename on name collision).
  FOR r IN
    SELECT branch_id, name FROM ontology_branch
     WHERE ontology_id <> canon AND name <> 'main'
  LOOP
    IF EXISTS (SELECT 1 FROM ontology_branch WHERE ontology_id = canon AND name = r.name) THEN
      new_name := r.name || '__' || left(r.branch_id::text, 8);
    ELSE
      new_name := r.name;
    END IF;
    UPDATE ontology_branch SET ontology_id = canon, name = new_name WHERE branch_id = r.branch_id;
  END LOOP;
  IF p_batch_size > 0 THEN COMMIT; END IF;

  -- 5. Re-point the SMALL FK-bearing definition tables (bounded by schema size).
  UPDATE object_type        SET ontology_id = canon WHERE ontology_id <> canon;
  UPDATE link_type          SET ontology_id = canon WHERE ontology_id <> canon;
  UPDATE action_type        SET ontology_id = canon WHERE ontology_id <> canon;
  UPDATE interface          SET ontology_id = canon WHERE ontology_id <> canon;
  UPDATE object_type_group  SET ontology_id = canon WHERE ontology_id <> canon;
  UPDATE ontology_function  SET ontology_id = canon WHERE ontology_id <> canon;
  UPDATE saved_exploration  SET ontology_id = canon WHERE ontology_id <> canon;
  UPDATE export_job         SET ontology_id = canon WHERE ontology_id <> canon;
  IF p_batch_size > 0 THEN COMMIT; END IF;

  -- 6. Re-point the LARGE data-key / log tables, batched when p_batch_size > 0.
  --    object_instances: fold branch_id into canon_branch AND move ontology_id
  --    in a single pass.
  LOOP
    UPDATE object_instances
       SET ontology_id = canon,
           branch_id = CASE WHEN branch_id = ANY(old_mains) THEN canon_branch ELSE branch_id END
     WHERE ctid IN (
       SELECT ctid FROM object_instances WHERE ontology_id <> canon
        LIMIT (CASE WHEN p_batch_size > 0 THEN p_batch_size ELSE 2147483647 END)
     );
    GET DIAGNOSTICS n = ROW_COUNT;
    IF p_batch_size > 0 THEN COMMIT; END IF;
    EXIT WHEN n = 0;
  END LOOP;

  LOOP
    UPDATE ontology_edit
       SET ontology_id = canon,
           ontology_id_fk = CASE WHEN ontology_id_fk IS NOT NULL THEN canon ELSE ontology_id_fk END,
           branch_id = CASE WHEN branch_id = ANY(old_mains) THEN canon_branch ELSE branch_id END
     WHERE ctid IN (
       SELECT ctid FROM ontology_edit WHERE ontology_id <> canon
        LIMIT (CASE WHEN p_batch_size > 0 THEN p_batch_size ELSE 2147483647 END)
     );
    GET DIAGNOSTICS n = ROW_COUNT;
    IF p_batch_size > 0 THEN COMMIT; END IF;
    EXIT WHEN n = 0;
  END LOOP;

  LOOP
    UPDATE link_edit
       SET ontology_id = canon,
           branch_id = CASE WHEN branch_id = ANY(old_mains) THEN canon_branch ELSE branch_id END
     WHERE ctid IN (
       SELECT ctid FROM link_edit WHERE ontology_id <> canon
        LIMIT (CASE WHEN p_batch_size > 0 THEN p_batch_size ELSE 2147483647 END)
     );
    GET DIAGNOSTICS n = ROW_COUNT;
    IF p_batch_size > 0 THEN COMMIT; END IF;
    EXIT WHEN n = 0;
  END LOOP;

  FOR r IN SELECT unnest(ARRAY['funnel_run','funnel_signal','funnel_changelog_watermark']) AS t
  LOOP
    LOOP
      EXECUTE format(
        'UPDATE %I SET ontology_id = $1 WHERE ctid IN (SELECT ctid FROM %I WHERE ontology_id <> $1 LIMIT %s)',
        r.t, r.t,
        (CASE WHEN p_batch_size > 0 THEN p_batch_size ELSE 2147483647 END)
      ) USING canon;
      GET DIAGNOSTICS n = ROW_COUNT;
      IF p_batch_size > 0 THEN COMMIT; END IF;
      EXIT WHEN n = 0;
    END LOOP;
  END LOOP;

  -- 7. Drop the now-unreferenced non-canonical branches + ontologies.
  DELETE FROM ontology_branch WHERE ontology_id <> canon;
  DELETE FROM ontology        WHERE ontology_id <> canon;

  -- 8. Singleton guard — caps the ontology table at one row, forever.
  CREATE UNIQUE INDEX IF NOT EXISTS uq_ontology_singleton ON ontology ((true));

  -- 9. Invariant assertions — abort (roll back the active transaction) on failure.
  SELECT count(*) INTO cnt FROM ontology;
  IF cnt <> 1 THEN
    RAISE EXCEPTION '[consolidate] invariant failed: % ontology rows remain (expected 1)', cnt;
  END IF;
  SELECT count(*) INTO cnt FROM object_type WHERE ontology_id <> canon;
  IF cnt <> 0 THEN
    RAISE EXCEPTION '[consolidate] invariant failed: % object_type rows off-canon', cnt;
  END IF;
  SELECT count(*) INTO cnt FROM object_instances WHERE ontology_id <> canon;
  IF cnt <> 0 THEN
    RAISE EXCEPTION '[consolidate] invariant failed: % object_instances rows off-canon', cnt;
  END IF;

  IF p_batch_size > 0 THEN COMMIT; END IF;
  RAISE NOTICE '[consolidate] single enterprise ontology % (batch_size=%)', canon, p_batch_size;
END
$proc$;

COMMENT ON PROCEDURE consolidate_single_ontology(int) IS
  'One Enterprise, One Ontology: folds all ontology-scoped data onto the canonical ontology. p_batch_size=0 runs inline (no COMMIT); >0 batches with COMMIT per chunk.';
