-- ===========================================================================
-- 100_single_enterprise_ontology.down.sql
-- ===========================================================================
-- Reverses the *structural* guard only. The data consolidation (folding many
-- ontologies into one) is intentionally NOT reversible — the original
-- per-ontology partitioning is destroyed by design. Restore from backup if you
-- need the pre-consolidation state.
-- ===========================================================================

DROP INDEX IF EXISTS uq_ontology_singleton;
