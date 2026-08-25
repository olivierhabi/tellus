-- Reverse of 128_interface_link_constraint.sql

DROP INDEX IF EXISTS idx_interface_link_constraint_target_interface;
DROP INDEX IF EXISTS idx_interface_link_constraint_ontology;
DROP INDEX IF EXISTS idx_interface_link_constraint_interface_id;

DROP TABLE IF EXISTS interface_link_constraint;
