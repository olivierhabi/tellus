-- ---------------------------------------------------------------------------
-- Task PB-B7 follow-group-mapper — Keycloak claim → UUID mapping.
--
-- Keycloak surfaces realm / client roles and group names as strings
-- (e.g. `offline_access`, `platform-admins`). pipeline_acl.principal_id
-- is UUID so these names don't plug in directly. This table lets an
-- operator register `(name → uuid)` so named groups / roles become
-- grant-capable principals.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS keycloak_group_map (
    group_name TEXT        PRIMARY KEY,
    group_uuid UUID        NOT NULL UNIQUE,
    source     TEXT        NOT NULL DEFAULT 'realm_role'
                          CHECK (source IN ('realm_role','client_role','group')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
