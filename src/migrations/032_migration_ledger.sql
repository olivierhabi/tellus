-- ---------------------------------------------------------------------------
-- Migration 032 — schema_migrations_applied ledger.
--
-- Until now, `src/migrate.ts` re-ran every inline DDL and sql-file on
-- every invocation, relying on `IF NOT EXISTS` idempotence. That's fine
-- until two pods race a migration, or until ops needs to answer "was
-- migration 031 applied in prod yet?". The ledger makes that
-- cheap+auditable.
--
-- Shape mirrors the convention used by migrate-based frameworks
-- (knex/flyway) minus the version-lock semantics we don't need: the
-- column is just (migration_name, applied_at, checksum).
--
-- We back-fill the ledger with every migration filename shipped up to
-- 031 so a fresh `npm run migrate` on an existing environment doesn't
-- show a ghost "unapplied" list.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS schema_migrations_applied (
    migration_name  TEXT        PRIMARY KEY,
    applied_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- sha256 of the SQL source so a hot-edit of a migration file after
    -- apply is detectable (the ledger checksum diverges from the
    -- on-disk sha256). Not a hard constraint — ops can reconcile by
    -- hand if a migration is deliberately hot-patched.
    checksum        TEXT
);

-- Back-fill everything that shipped before this ledger existed. The
-- files are idempotent so we can state they were "applied by prior
-- bootstrap logic" without inspecting the database state — a fresh
-- environment still sees them applied by migrate.ts before this row
-- inserts.
INSERT INTO schema_migrations_applied (migration_name, applied_at)
VALUES
    ('001_initial_schema.sql',                 '1970-01-01T00:00:00Z'),
    ('007_create_interfaces.sql',              '1970-01-01T00:00:00Z'),
    ('008_create_object_type_interface.sql',   '1970-01-01T00:00:00Z'),
    ('009_pgvector_and_timeseries.sql',        '1970-01-01T00:00:00Z'),
    ('010_add_version_columns.sql',            '1970-01-01T00:00:00Z'),
    ('012_funnel_object_edits.sql',            '1970-01-01T00:00:00Z'),
    ('013_replacement_pipeline.sql',           '1970-01-01T00:00:00Z'),
    ('014_funnel_runs.sql',                    '1970-01-01T00:00:00Z'),
    ('015_funnel_signal_idempotency.sql',      '1970-01-01T00:00:00Z'),
    ('016_iceberg_metadata_retry.sql',         '1970-01-01T00:00:00Z'),
    ('017_pipeline_supervised_deploys.sql',    '1970-01-01T00:00:00Z'),
    ('017_link_type_extensions.sql',           '1970-01-01T00:00:00Z'),
    ('018_funnel_hardening.sql',               '1970-01-01T00:00:00Z'),
    ('018_pipeline_compute_type.sql',          '1970-01-01T00:00:00Z'),
    ('019_pipeline_output_format.sql',         '1970-01-01T00:00:00Z'),
    ('020_pipeline_iceberg.sql',               '1970-01-01T00:00:00Z'),
    ('021_pipeline_streaming.sql',             '1970-01-01T00:00:00Z'),
    ('022_pipeline_preview_pinning.sql',       '1970-01-01T00:00:00Z'),
    ('023_pipeline_rbac.sql',                  '1970-01-01T00:00:00Z'),
    ('024_dataset_lineage.sql',                '1970-01-01T00:00:00Z'),
    ('025_pipeline_cbac.sql',                  '1970-01-01T00:00:00Z'),
    ('026_fnl_h3_pipeline_deploy_signal.sql',  '1970-01-01T00:00:00Z'),
    ('027_bd_foundry_dataset_id.sql',          '1970-01-01T00:00:00Z'),
    ('028_schema_evolution.sql',               '1970-01-01T00:00:00Z'),
    ('029_funnel_input_lineage_trigger.sql',   '1970-01-01T00:00:00Z'),
    ('030_keycloak_group_map.sql',             '1970-01-01T00:00:00Z'),
    ('031_pipeline_snapshot_invariants.sql',   '1970-01-01T00:00:00Z'),
    ('032_migration_ledger.sql',               now())
ON CONFLICT (migration_name) DO NOTHING;
