-- Down migration for 088_b1_connectivity_egress_policies.
-- Drop the connection reference first (FK), then the policies table.

DROP INDEX IF EXISTS connectivity_connections_by_egress_policy;

ALTER TABLE connectivity_connections
  DROP COLUMN IF EXISTS egress_policy_rid;

DROP INDEX IF EXISTS connectivity_egress_policies_by_tenant;
DROP INDEX IF EXISTS connectivity_egress_policies_unique_name_in_tenant;
DROP TABLE IF EXISTS connectivity_egress_policies;
