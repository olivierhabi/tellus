import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE dataset_versions (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      dataset_id      UUID NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
      version_number  INTEGER NOT NULL,
      file_path       TEXT NOT NULL,
      file_size_bytes BIGINT,
      row_count       INTEGER,
      column_count    INTEGER,
      content_hash    VARCHAR(64),
      schema_snapshot JSONB,
      change_summary  TEXT,
      created_by      UUID,
      created_at      TIMESTAMPTZ DEFAULT NOW(),

      CONSTRAINT uq_dataset_version UNIQUE (dataset_id, version_number)
    )
  `);

  await knex.raw(
    `CREATE INDEX idx_dataset_versions_dataset ON dataset_versions(dataset_id)`
  );

  await knex.raw(
    `CREATE INDEX idx_dataset_versions_created ON dataset_versions(created_at)`
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS dataset_versions CASCADE`);
}
