-- B4 — orchestration_builds (spec §B4 line 202).
--
-- Tracks every build (job execution attempt) submitted to the worker
-- runtime. Status is a finite-state field; events are append-only structured
-- JSON rows the SSE endpoint streams to clients.

CREATE TABLE IF NOT EXISTS orchestration_builds (
  rid                text PRIMARY KEY
                       CHECK (rid LIKE 'ri.orchestration.main.build.%'),
  import_rid         text NOT NULL
                       CHECK (import_rid LIKE 'ri.magritte.main.%'),
  connection_rid     text NOT NULL
                       CHECK (connection_rid LIKE 'ri.magritte.main.source.%'),
  tenant             text NOT NULL,
  actor              text NOT NULL,
  kind               text NOT NULL
                       CHECK (kind IN ('foundryWorker','agentProxy')),
  status             text NOT NULL DEFAULT 'queued'
                       CHECK (status IN ('queued','running','succeeded','failed','cancelled','timeout')),
  payload            jsonb NOT NULL,
  egress             jsonb NOT NULL,
  enqueued_at        timestamptz NOT NULL DEFAULT now(),
  started_at         timestamptz,
  ended_at           timestamptz,
  exit_code          int,
  reason             text,
  snapshot_rid       text,
  bytes_read         bigint,
  rows_written       bigint
);

CREATE INDEX IF NOT EXISTS orchestration_builds_import_rid_idx
  ON orchestration_builds(import_rid);
CREATE INDEX IF NOT EXISTS orchestration_builds_status_idx
  ON orchestration_builds(status)
  WHERE status IN ('queued','running');

CREATE TABLE IF NOT EXISTS orchestration_build_events (
  id                 bigserial PRIMARY KEY,
  build_rid          text NOT NULL REFERENCES orchestration_builds(rid) ON DELETE CASCADE,
  ts                 timestamptz NOT NULL DEFAULT now(),
  kind               text NOT NULL
                       CHECK (kind IN ('started','progress','log','succeeded','failed','cancelled')),
  data               jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS orchestration_build_events_build_ts_idx
  ON orchestration_build_events(build_rid, ts);
