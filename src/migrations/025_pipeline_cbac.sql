-- ---------------------------------------------------------------------------
-- Task PB-B7 follow-cbac — condition-based access control on pipelines.
--
-- Each rule is a JSON predicate evaluated at deploy admission against a
-- (user, pipeline, project) context. Rules with `enabled=false` are
-- ignored — lets operators stage new rules before enforcement.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pipeline_cbac_rule (
    rule_id      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    pipeline_id  UUID        NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
    description  TEXT,
    predicate    JSONB       NOT NULL,
    enabled      BOOLEAN     NOT NULL DEFAULT TRUE,
    created_by   UUID        REFERENCES users(id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pipeline_cbac_rule_pipeline
    ON pipeline_cbac_rule (pipeline_id)
    WHERE enabled = TRUE;
