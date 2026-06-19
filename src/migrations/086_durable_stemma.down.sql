-- Down migration for 086_durable_stemma.
DROP TABLE IF EXISTS coderepo_stemma_blob;
DROP TABLE IF EXISTS coderepo_stemma_branch;
DROP TABLE IF EXISTS coderepo_stemma_repo;
