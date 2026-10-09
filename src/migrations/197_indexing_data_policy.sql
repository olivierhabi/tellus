-- 197_indexing_data_policy.sql
--
-- Palantir OSv2 parity for batch indexing (docs/adr/2026-10-09-funnel-data-
-- restrictions-and-incremental-indexing.md):
--
-- 1. object_type.indexing_data_policy — per object type, how the funnel
--    treats data that breaks the OSv2 data restrictions (duplicate primary
--    keys within one transaction, null/empty primary keys, NaN/±Infinity,
--    empty strings, nested arrays, null array elements, strings > 12 MB,
--    arrays > 100,000 elements, forbidden primary-key types).
--      'lenient' — record the violations in the changelog snapshot's
--                  summary_json.source_quality and keep going (pre-197
--                  behaviour; duplicate PKs collapse last-wins).
--      'strict'  — fail the changelog before anything is committed, with
--                  counts and samples (what Palantir does for batch
--                  datasources).
--    Existing object types default to 'lenient' so nothing that indexes
--    today starts failing on deploy; owners flip to 'strict' once the
--    source_quality report is clean.
--
-- 2. funnel_index_watermark — the last merged snapshot whose rows reached
--    the serving index, and how (full | incremental). Incremental indexing
--    publishes only the merge delta, which is only correct when the index
--    already reflects the delta's base snapshot; the watermark proves it.
--
-- Idempotent: IF NOT EXISTS everywhere; the CHECK is added only if missing.
ALTER TABLE object_type
  ADD COLUMN IF NOT EXISTS indexing_data_policy text NOT NULL DEFAULT 'lenient';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'object_type_indexing_data_policy_check'
  ) THEN
    ALTER TABLE object_type
      ADD CONSTRAINT object_type_indexing_data_policy_check
      CHECK (indexing_data_policy IN ('lenient', 'strict'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS funnel_index_watermark (
  ontology_id                     uuid        NOT NULL,
  object_type_api_name            text        NOT NULL,
  last_indexed_merged_snapshot_id uuid        NOT NULL,
  last_mode                       text        NOT NULL
                                  CHECK (last_mode IN ('full', 'incremental')),
  last_rows_published             bigint      NOT NULL DEFAULT 0,
  indexed_at                      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ontology_id, object_type_api_name)
);
