-- ---------------------------------------------------------------------------
-- Task PB-B8 — auto-insert funnel_input lineage edge on backing_datasource
-- registration. Spec literal: "On Object Type backing-datasource
-- configuration, an edge (object_type_merged → backing_datasource) is
-- inserted."
--
-- Implementation: the Object Type's "merged dataset" is a logical
-- identity; we materialise it as a foundry_datasets row with a
-- deterministic id derived from object_type.object_type_id so re-runs
-- are idempotent. The trigger below
--   * ensures the OT-shadow foundry_datasets row exists
--   * inserts (ot_shadow → bd.foundry_dataset_id, 'funnel_input')
-- Both happen in one transaction with the BD INSERT so the downstream
-- walk from `GET /v2/datasets/:bd_id/lineage?direction=downstream`
-- surfaces the OT on the first scan.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION pb_b8_autolink_backing_datasource()
RETURNS TRIGGER AS $$
DECLARE
  ot_shadow_id UUID;
  ot_row RECORD;
BEGIN
  -- Resolve the OT for this BD.
  SELECT object_type_id, api_name INTO ot_row
    FROM object_type WHERE object_type_id = NEW.object_type_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  -- Deterministic shadow dataset id: a v5-style namespaced UUID derived
  -- from the object_type_id. Implemented as md5 → UUID cast since the
  -- server may not have `uuid_generate_v5` installed.
  ot_shadow_id := (
    substring(md5('ot_shadow:' || NEW.object_type_id::text) from 1 for 8)  || '-' ||
    substring(md5('ot_shadow:' || NEW.object_type_id::text) from 9 for 4)  || '-' ||
    '5' || substring(md5('ot_shadow:' || NEW.object_type_id::text) from 14 for 3) || '-' ||
    '8' || substring(md5('ot_shadow:' || NEW.object_type_id::text) from 18 for 3) || '-' ||
    substring(md5('ot_shadow:' || NEW.object_type_id::text) from 21 for 12)
  )::UUID;

  -- Idempotent create of the shadow dataset.
  INSERT INTO foundry_datasets
    (id, name, project_id, file_path, format)
  SELECT
    ot_shadow_id,
    'ot_shadow_' || ot_row.api_name,
    (SELECT id FROM projects ORDER BY created_at ASC LIMIT 1),  -- pinned to an arbitrary project for the shadow (nullable after PB-B3 would have been cleaner; we keep the NOT NULL guard)
    'virtual://ot/' || ot_row.api_name,
    'iceberg'
  WHERE NOT EXISTS (SELECT 1 FROM foundry_datasets WHERE id = ot_shadow_id)
    AND EXISTS (SELECT 1 FROM projects LIMIT 1);

  -- Insert the funnel_input edge when the BD has a foundry_dataset_id
  -- (PB-B8 follow-bd-migrate). If the BD still uses the legacy
  -- dataset_id, there's nothing to point the upstream at — skip.
  IF NEW.foundry_dataset_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM foundry_datasets WHERE id = ot_shadow_id) THEN
    INSERT INTO dataset_lineage
      (downstream_dataset_id, upstream_dataset_id, edge_type, edge_metadata)
    VALUES
      (ot_shadow_id, NEW.foundry_dataset_id, 'funnel_input',
       jsonb_build_object(
         'object_type_id', NEW.object_type_id,
         'object_type_api_name', ot_row.api_name,
         'backing_datasource_mapping_id', NEW.mapping_id
       ))
    ON CONFLICT (downstream_dataset_id, upstream_dataset_id, edge_type) DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_pb_b8_autolink_bd ON backing_datasource;
CREATE TRIGGER trg_pb_b8_autolink_bd
  AFTER INSERT OR UPDATE OF foundry_dataset_id ON backing_datasource
  FOR EACH ROW
  EXECUTE FUNCTION pb_b8_autolink_backing_datasource();
