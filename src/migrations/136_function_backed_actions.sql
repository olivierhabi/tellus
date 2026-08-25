-- Function-backed Action Types.
--
-- The binding pins an immutable Function Registry version. Runtime execution
-- never follows a moving branch head; auto-upgrade is authoring metadata and
-- requires an explicit action-definition update.
ALTER TABLE action_type
  ADD COLUMN IF NOT EXISTS function_config JSONB;

ALTER TABLE action_type
  DROP CONSTRAINT IF EXISTS action_type_function_config_shape_chk;
ALTER TABLE action_type
  ADD CONSTRAINT action_type_function_config_shape_chk CHECK (
    function_config IS NULL OR (
      jsonb_typeof(function_config) = 'object'
      AND function_config ?& ARRAY[
        'functionRid', 'repositoryRid', 'apiName', 'branch', 'semver'
      ]
      AND jsonb_typeof(function_config->'functionRid') = 'string'
      AND jsonb_typeof(function_config->'repositoryRid') = 'string'
      AND jsonb_typeof(function_config->'apiName') = 'string'
      AND jsonb_typeof(function_config->'branch') = 'string'
      AND jsonb_typeof(function_config->'semver') = 'string'
    )
  );

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
    OR (NEW.function_config     IS DISTINCT FROM OLD.function_config)
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

COMMENT ON COLUMN action_type.function_config IS
  'Immutable published Function binding for execution_mode=function: functionRid, repositoryRid, apiName, branch, semver.';
