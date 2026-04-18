-- ---------------------------------------------------------------------------
-- Task B1/B6/B7 — Postgres as system of record for object instances + edits
--
-- B1 called for these tables but they're only required once the Funnel tasks
-- (B6 Indexing, B7 Writeback Overlay, B8 Hydration) run against them. They
-- are idempotent so running against an older database is safe.
--
-- `object_edits` is append-only — there is no UPDATE path in application code
-- except the two timestamp stamps (`applied_to_merged_at`, `applied_to_index_at`)
-- which are set by the Merge and Index activities respectively.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS object_instances (
    ontology_id            UUID         NOT NULL,
    object_type_api_name   TEXT         NOT NULL,
    primary_key            TEXT         NOT NULL,
    properties             JSONB        NOT NULL DEFAULT '{}'::jsonb,
    markings               TEXT[]       NOT NULL DEFAULT ARRAY[]::text[],
    source_datasource_id   UUID,
    source_transaction_id  UUID,
    last_modified_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
    version                BIGINT       NOT NULL DEFAULT 1,
    PRIMARY KEY (ontology_id, object_type_api_name, primary_key)
);

CREATE INDEX IF NOT EXISTS idx_object_instances_ot
    ON object_instances (object_type_api_name);

CREATE INDEX IF NOT EXISTS idx_object_instances_modified
    ON object_instances (object_type_api_name, last_modified_at DESC);

-- Allowed edit strategies — `user_edit_wins` (default) pins edited props
-- against source updates; `latest_wins` uses timestamps to resolve.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'edit_strategy') THEN
    CREATE TYPE edit_strategy AS ENUM ('user_edit_wins', 'latest_wins');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS object_edits (
    edit_id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    ontology_id            UUID         NOT NULL,
    object_type_api_name   TEXT         NOT NULL,
    primary_key            TEXT         NOT NULL,
    property_api_name      TEXT         NOT NULL,
    new_value              JSONB,
    edit_strategy          edit_strategy NOT NULL DEFAULT 'user_edit_wins',
    actor_user_id          UUID,
    created_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),
    applied_to_merged_at   TIMESTAMPTZ,
    applied_to_index_at    TIMESTAMPTZ
);

-- Partial indexes let the Merge and Index activities cheaply scan pending
-- edits without tripping over the fully-applied majority of the table.
CREATE INDEX IF NOT EXISTS idx_object_edits_pending_merge
    ON object_edits (object_type_api_name, created_at)
    WHERE applied_to_merged_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_object_edits_pending_index
    ON object_edits (object_type_api_name, created_at)
    WHERE applied_to_index_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_object_edits_pk_lookup
    ON object_edits (object_type_api_name, primary_key, created_at DESC);
