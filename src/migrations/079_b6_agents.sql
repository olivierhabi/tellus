-- B6 — Agent registration + heartbeat tracking.

CREATE TABLE IF NOT EXISTS magritte_agents (
  rid                text PRIMARY KEY
                       CHECK (rid LIKE 'ri.magritte.main.agent.%'),
  group_rid          text NOT NULL
                       CHECK (group_rid LIKE 'ri.magritte.main.agent-group.%'),
  display_name       text NOT NULL,
  version            text NOT NULL,
  tags               jsonb NOT NULL DEFAULT '{}'::jsonb,
  joined_at          timestamptz NOT NULL DEFAULT now(),
  last_heartbeat_at  timestamptz,
  open_tunnels       int NOT NULL DEFAULT 0,
  status             text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','connected','disconnected','draining'))
);

CREATE INDEX IF NOT EXISTS magritte_agents_group_idx
  ON magritte_agents(group_rid, status);

CREATE TABLE IF NOT EXISTS magritte_agent_groups (
  rid                text PRIMARY KEY
                       CHECK (rid LIKE 'ri.magritte.main.agent-group.%'),
  tenant             text NOT NULL,
  display_name       text NOT NULL,
  policy             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now()
);
