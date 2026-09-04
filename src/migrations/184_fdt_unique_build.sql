-- Foundry parity hardening — a build must commit exactly ONE transaction
-- per dataset. Deployments interrupted mid-flight (pod restart between
-- side effects) are re-executed by the dispatcher's orphan path; without
-- this constraint a retried build of the same deployment commits a SECOND
-- transaction and the appended view double-counts rows.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.foundry_dataset_transactions'::regclass
      AND conname = 'uq_fdt_dataset_deployment'
  ) THEN
    ALTER TABLE foundry_dataset_transactions
      ADD CONSTRAINT uq_fdt_dataset_deployment UNIQUE (dataset_id, deployment_id);
  END IF;
END $$;
