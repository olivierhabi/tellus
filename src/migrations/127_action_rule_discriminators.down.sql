-- Reverse of 127_action_rule_discriminators.sql

ALTER TABLE IF EXISTS action_type
  DROP CONSTRAINT IF EXISTS action_type_rules_discriminators_valid;

DROP FUNCTION IF EXISTS action_rule_discriminator_valid(jsonb);
