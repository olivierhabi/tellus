import { Knex } from 'knex';

/**
 * 177_widen_content_hash
 *
 * Root cause: csvParsingService emits `sha256:<64hex>` = 71 chars, but
 * foundry_datasets.content_hash was VARCHAR(64) → Postgres 22001 on every
 * dataset parse. The parse transaction rolled back and the row stayed
 * `status='error'` with a 22001 ingestionValidation, while
 * registerBackingDatasource fell back to a UUID-only file_path that can
 * never HEAD-resolve. Widening to VARCHAR(128) fixes the hot path and
 * keeps the `sha256:` prefix (future-proof for other algorithms).
 *
 * Also widens legacy datasets, dataset_versions and dataset_versions-equivalents
 * so fresh + existing DBs converge. Idempotent: only alters when current
 * max length is 64.
 */
export async function up(knex: Knex): Promise<void> {
  // foundry_datasets — primary victim (tellus/upload pipeline)
  await knex.raw(`
    DO $$
    DECLARE max_len int;
    BEGIN
      SELECT character_maximum_length INTO max_len
      FROM information_schema.columns
      WHERE table_name='foundry_datasets' AND column_name='content_hash';
      IF max_len IS NOT NULL AND max_len < 128 THEN
        ALTER TABLE foundry_datasets ALTER COLUMN content_hash TYPE VARCHAR(128);
      END IF;
    END $$;
  `);

  // dataset_versions (foundry)
  await knex.raw(`
    DO $$
    DECLARE max_len int;
    BEGIN
      SELECT character_maximum_length INTO max_len
      FROM information_schema.columns
      WHERE table_name='dataset_versions' AND column_name='content_hash';
      IF max_len IS NOT NULL AND max_len < 128 THEN
        ALTER TABLE dataset_versions ALTER COLUMN content_hash TYPE VARCHAR(128);
      END IF;
    END $$;
  `);

  // legacy ontology datasets table (migrations/001)
  await knex.raw(`
    DO $$
    DECLARE max_len int;
    BEGIN
      SELECT character_maximum_length INTO max_len
      FROM information_schema.columns
      WHERE table_name='datasets' AND column_name='content_hash';
      IF max_len IS NOT NULL AND max_len < 128 THEN
        ALTER TABLE datasets ALTER COLUMN content_hash TYPE VARCHAR(128);
      END IF;
    END $$;
  `);

  // dataset (ontology-engine legacy, not foundry) — if present
  await knex.raw(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='dataset' AND column_name='content_hash') THEN
        -- dataset table in this schema has no length limit (text) — no-op, kept for completeness
        NULL;
      END IF;
    END $$;
  `);
}

export async function down(knex: Knex): Promise<void> {
  // Downgrade only if no 71-char hashes exist; otherwise would truncate.
  await knex.raw(`
    DO $$
    DECLARE has_long boolean;
    BEGIN
      SELECT EXISTS (SELECT 1 FROM foundry_datasets WHERE length(content_hash) > 64) INTO has_long;
      IF has_long THEN
        RAISE EXCEPTION 'Cannot downgrade content_hash to VARCHAR(64): rows with length >64 exist';
      END IF;
      ALTER TABLE foundry_datasets ALTER COLUMN content_hash TYPE VARCHAR(64);
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='dataset_versions' AND column_name='content_hash') THEN
        ALTER TABLE dataset_versions ALTER COLUMN content_hash TYPE VARCHAR(64);
      END IF;
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='datasets' AND column_name='content_hash') THEN
        ALTER TABLE datasets ALTER COLUMN content_hash TYPE VARCHAR(64);
      END IF;
    END $$;
  `);
}
