-- Connection governance settings — persists the wizard's Step 5 (Export
-- configuration) and Step 6 (Code import configuration) choices on each
-- connection. Stored as a single jsonb document so the shape can evolve
-- without further DDL. The default mirrors DEFAULT_CONNECTION_SETTINGS in
-- src/services/connectivity/contracts.ts (allowVirtualTables is forced-on).

ALTER TABLE connectivity_connections
  ADD COLUMN IF NOT EXISTS settings JSONB NOT NULL DEFAULT
    '{"export":{"exportsEnabled":false,"skipMarkingsValidation":false},"codeImport":{"allowCodeRepositories":false,"allowComputeModules":false,"allowPipelineUdfs":false,"allowVirtualTables":true}}'::JSONB;
