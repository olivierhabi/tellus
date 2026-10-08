-- 190_dataset_name_uniqueness.sql
--
-- Incident 3ec397d5 (2026-10-05): two executors ran the same deployment
-- concurrently. Both passed the application-level name check
-- (assertFolderNameAvailable: SELECT-then-INSERT across pooled connections)
-- before either committed, and both INSERTed same-named foundry_datasets
-- rows 1-3 ms apart. The application guard cannot fix this class of race.
-- This migration adds the database backstop: uniqueness of live dataset
-- names within (project, folder).
--
-- DELIBERATE DEVIATIONS from the naive spec, with reasons:
--   1. No `WHERE deleted_at IS NULL` partial predicate: foundry_datasets
--      has NO soft-delete column (verified 2026-10-05: 22 columns, none
--      named deleted_at; deletes are hard, trash restore re-INSERTs by id).
--      A full unique index is the correct shape.
--   2. No CONCURRENTLY: both migrators (src/migrate.ts, src/foundryMigrate.ts)
--      wrap each .sql file in its own transaction, and
--      CREATE INDEX CONCURRENTLY cannot run inside a transaction block.
--      The table holds hundreds of rows; a plain CREATE UNIQUE INDEX takes
--      a brief SHARE lock (blocks writes, not reads) and finishes in ms.
--   3. NULLS NOT DISTINCT (PG15+; server is PG16.14): folder_id is nullable
--      (project root = NULL). Without it, root-level duplicates would still
--      get through, and the June incident group (folder NULL x4) proves that
--      hole is real.
--
-- SCOPE NOTE: the application guard also spans sibling folders and pipelines
-- (Foundry parity). This index covers datasets only — the incident class.
-- Cross-table name conflicts remain application-checked; those writers are
-- not concurrent deploy executors.
--
-- PRECONDITION: zero duplicate (project_id, folder_id, name) groups. The DO
-- block below enforces this loudly (names the groups) instead of failing
-- with a bare index error. Known groups on dev as of 2026-10-05 (see
-- incident record; resolve via item-4 cleanup BEFORE applying here):
--   incident pairs in MobileMoneyDemo + 5 older groups (tariff.csv x2,
--   organization.csv x3, New Object Type Backing Dataset.csv x5,
--   active_index_version_raw x2 NULL folder, CDC: users, orders x4,
--   vip_customers.csv x2).

DO $$
DECLARE
  dup_count integer;
  dup_list text;
BEGIN
  SELECT count(*), string_agg(
    format('%s in project %s folder %s x%s', name, project_id,
           COALESCE(folder_id::text, 'NULL'), n),
    '; ' ORDER BY name)
  INTO dup_count, dup_list
  FROM (
    SELECT project_id, folder_id, name, count(*) AS n
      FROM foundry_datasets
     GROUP BY project_id, folder_id, name
    HAVING count(*) > 1
  ) d;

  IF dup_count > 0 THEN
    RAISE EXCEPTION
      '190_dataset_name_uniqueness blocked: % duplicate (project_id, folder_id, name) group(s) still present: %. Resolve via cleanup (incident item 4) before applying.',
      dup_count, dup_list;
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_foundry_datasets_project_folder_name
  ON foundry_datasets (project_id, folder_id, name)
  NULLS NOT DISTINCT;
