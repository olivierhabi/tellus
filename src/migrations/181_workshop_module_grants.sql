-- Workshop grants — per-module Viewer/Editor sharing (P1).
--
-- When a module has no grants (NULL), authorization falls back to the
-- existing global JWT roles (`workshop-editor`, `workshop-viewer`, and
-- the SUPER_EDITOR_ROLES set). Once at least one grant row exists, the
-- effective role for a principal is the maximum of:
--  (a) direct user grant (principal_type = 'user', principal_id = Keycloak
--      directory user id / JWT subject)
--  (b) group membership grant (principal_type = 'group',
--      principal_id IN caller.groups)
--  (c) implicit default groups: "Workshop Builders" → editor,
--      "Workshop Users" → viewer
--  (d) global JWT roles (backward compatibility)
--
-- Editor implies Viewer. A `null` effective role means no access at all
-- (module is hidden from that principal).

CREATE TABLE IF NOT EXISTS workshop_module_grants (
  module_rid     TEXT        NOT NULL REFERENCES workshop_module(rid) ON DELETE CASCADE,
  principal_type TEXT        NOT NULL CHECK (principal_type IN ('user', 'group')),
  principal_id   TEXT        NOT NULL,
  role           TEXT        NOT NULL CHECK (role IN ('viewer', 'editor')),
  granted_by     TEXT        NOT NULL,
  granted_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (module_rid, principal_type, principal_id)
);

CREATE INDEX IF NOT EXISTS idx_workshop_module_grants_module
  ON workshop_module_grants(module_rid);
CREATE INDEX IF NOT EXISTS idx_workshop_module_grants_user
  ON workshop_module_grants(principal_type, principal_id)
  WHERE principal_type = 'user';
