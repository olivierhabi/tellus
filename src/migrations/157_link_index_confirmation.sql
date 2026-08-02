-- ---------------------------------------------------------------------------
-- 157 — Link edge-index confirmation watermarks (OSv2 serving-index parity).
--
-- ADD
--   1. `link_cdc_outbox.outbox_seq BIGSERIAL UNIQUE` — a globally monotonic
--      edge-event offset. Assignment order = staging order inside the Action
--      transaction; it is unique and gap-tolerant (serial values may split
--      under aborted transactions, which is fine: confirmation is per-event,
--      and the per-scope watermark is only ever compared >= a caller's own
--      seq, never treated as a contiguous-range guarantee).
--   2. `link_edge_watermarks` — per (tenant, ontology, branch, link_type)
--      confirmed visibility stats written by the edge-index acknowledgement
--      probe (src/services/serving/edgeIndexWatermark.ts): the largest
--      outbox_seq observed in ClickHouse for the scope and the time of last
--      confirmation. This is OBSERVABILITY, never a completion fabricator:
--      Action completion requires per-event visibility probing;
--      `published_at` remains broker acceptance only.
-- ---------------------------------------------------------------------------

ALTER TABLE link_cdc_outbox
  ADD COLUMN IF NOT EXISTS outbox_seq BIGSERIAL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_link_cdc_outbox_seq
  ON link_cdc_outbox (outbox_seq);

CREATE TABLE IF NOT EXISTS link_edge_watermarks (
  tenant_id          text        NOT NULL,
  ontology_id        text        NOT NULL,
  branch_id          text        NOT NULL,
  link_type_api_name text        NOT NULL,
  confirmed_seq      bigint      NOT NULL DEFAULT 0,
  confirmed_event_version bigint NOT NULL DEFAULT 0,
  last_confirmed_at  timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, ontology_id, branch_id, link_type_api_name)
);

COMMENT ON TABLE link_edge_watermarks IS
  'Per-scope edge-index visibility watermarks (observability). Action completion uses per-event probing in src/services/serving/edgeIndexWatermark.ts — never this table alone.';
