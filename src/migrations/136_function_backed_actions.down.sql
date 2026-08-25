DROP TRIGGER IF EXISTS trg_action_type_definition_version ON action_type;

ALTER TABLE action_type
  DROP CONSTRAINT IF EXISTS action_type_function_config_shape_chk;
ALTER TABLE action_type
  DROP COLUMN IF EXISTS function_config;

CREATE OR REPLACE FUNCTION bump_action_type_definition_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  definition_changed BOOLEAN;
BEGIN
  definition_changed :=
       (NEW.parameters         IS DISTINCT FROM OLD.parameters)
    OR (NEW.rules               IS DISTINCT FROM OLD.rules)
    OR (NEW.submission_criteria IS DISTINCT FROM OLD.submission_criteria)
    OR (NEW.side_effects        IS DISTINCT FROM OLD.side_effects)
    OR (NEW.writeback_config    IS DISTINCT FROM OLD.writeback_config)
    OR (NEW.semantics_version   IS DISTINCT FROM OLD.semantics_version)
    OR (NEW.execution_mode      IS DISTINCT FROM OLD.execution_mode)
    OR (NEW.delete_policy       IS DISTINCT FROM OLD.delete_policy);

  IF definition_changed THEN
    NEW.definition_version := OLD.definition_version + 1;
  ELSE
    NEW.definition_version := OLD.definition_version;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_action_type_definition_version
  BEFORE UPDATE ON action_type
  FOR EACH ROW
  EXECUTE FUNCTION bump_action_type_definition_version();
