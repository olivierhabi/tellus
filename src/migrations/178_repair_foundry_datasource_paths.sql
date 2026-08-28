-- Repair ontology datasource bindings created with the dataset UUID as the
-- readable path. The canonical prefix comes exclusively from
-- foundry_datasets; the binding tags remain because they make each
-- (dataset, object type) path unique and let the funnel recover lineage.

CREATE TABLE IF NOT EXISTS datasource_binding_repair_178_audit (
  audit_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  migration_run_id UUID NOT NULL,
  mapping_id UUID NOT NULL,
  object_type_id UUID NOT NULL,
  foundry_dataset_id UUID,
  before_snapshot JSONB NOT NULL,
  after_snapshot JSONB,
  outcome TEXT NOT NULL CHECK (outcome IN ('repaired', 'skipped')),
  reason TEXT,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
DECLARE
  run_id UUID := gen_random_uuid();
  scanned_count INTEGER := 0;
  repaired_count INTEGER := 0;
  skipped_count INTEGER := 0;
  skipped RECORD;
BEGIN
  CREATE TEMP TABLE repair_178_candidates ON COMMIT DROP AS
  SELECT
    bd.mapping_id,
    bd.object_type_id,
    bd.foundry_dataset_id,
    bd.file_path AS before_file_path,
    bd.file_format AS before_file_format,
    fd.file_path AS canonical_file_path,
    lower(fd.format) AS canonical_file_format,
    CASE
      WHEN fd.id IS NULL THEN 'linked foundry_datasets record is missing'
      WHEN fd.file_path IS NULL OR btrim(fd.file_path) = '' THEN 'canonical file_path is empty'
      WHEN btrim(fd.file_path) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN 'canonical file_path is a bare UUID'
      WHEN fd.format IS NULL OR btrim(fd.format) = '' THEN 'canonical format is empty'
      WHEN fd.file_path LIKE 'iceberg://%' AND
           fd.file_path !~ '^iceberg://[A-Za-z0-9._-]+/[A-Za-z0-9._/-]+$'
        THEN 'canonical Iceberg URI is invalid'
      WHEN fd.file_path NOT LIKE 'iceberg://%' AND (
        fd.file_path LIKE '/%' OR
        position('/' in fd.file_path) = 0 OR
        position('#' in fd.file_path) > 0 OR
        fd.file_path ~ '(^|/)\.\.(/|$)'
      ) THEN 'canonical object-store key is invalid'
      ELSE NULL
    END AS skip_reason
  FROM backing_datasource bd
  LEFT JOIN foundry_datasets fd ON fd.id = bd.foundry_dataset_id
  WHERE bd.foundry_dataset_id IS NOT NULL
    AND (
      bd.file_path = bd.foundry_dataset_id::text OR
      split_part(bd.file_path, '#foundry-dataset:', 1) = bd.foundry_dataset_id::text OR
      split_part(bd.file_path, '#foundry-dataset:', 1) ~*
        '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    );

  SELECT count(*) INTO scanned_count FROM repair_178_candidates;

  INSERT INTO datasource_binding_repair_178_audit (
    migration_run_id, mapping_id, object_type_id, foundry_dataset_id,
    before_snapshot, outcome, reason
  )
  SELECT
    run_id,
    mapping_id,
    object_type_id,
    foundry_dataset_id,
    jsonb_build_object('filePath', before_file_path, 'fileFormat', before_file_format),
    CASE WHEN skip_reason IS NULL THEN 'repaired' ELSE 'skipped' END,
    skip_reason
  FROM repair_178_candidates;

  UPDATE backing_datasource bd
     SET file_path = c.canonical_file_path ||
          '#foundry-dataset:' || c.foundry_dataset_id::text ||
          '#object-type:' || c.object_type_id::text,
         file_format = c.canonical_file_format
    FROM repair_178_candidates c
   WHERE bd.mapping_id = c.mapping_id
     AND c.skip_reason IS NULL;

  GET DIAGNOSTICS repaired_count = ROW_COUNT;

  UPDATE datasource_binding_repair_178_audit a
     SET after_snapshot = jsonb_build_object(
       'filePath', bd.file_path,
       'fileFormat', bd.file_format
     )
    FROM backing_datasource bd
   WHERE a.migration_run_id = run_id
     AND a.mapping_id = bd.mapping_id;

  skipped_count := scanned_count - repaired_count;
  RAISE NOTICE '178 datasource repair summary: run_id=%, rows_scanned=%, rows_repaired=%, rows_skipped=%',
    run_id, scanned_count, repaired_count, skipped_count;
  FOR skipped IN
    SELECT mapping_id, skip_reason FROM repair_178_candidates WHERE skip_reason IS NOT NULL
  LOOP
    RAISE NOTICE '178 datasource repair skipped mapping_id=% reason=%',
      skipped.mapping_id, skipped.skip_reason;
  END LOOP;
END $$;
