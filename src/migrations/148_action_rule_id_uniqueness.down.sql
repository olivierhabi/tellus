-- Rule RIDs are durable authoring identities. Reintroducing duplicate IDs on
-- rollback would corrupt that identity, so this data-repair migration has no
-- destructive reverse operation.
SELECT 1;
