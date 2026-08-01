-- Add the interface-object rule families now supported by authoring,
-- validation, compilation, and execution. The CHECK constraint calls this
-- immutable helper, so replacing the helper updates existing installations
-- without rewriting action_type rows.
CREATE OR REPLACE FUNCTION action_rule_discriminator_valid(rules jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT
    jsonb_typeof(rules) = 'array'
    AND (
      SELECT bool_and(
        t.elem ? 'type'
        AND jsonb_typeof(t.elem->'type') = 'string'
        AND t.elem->>'type' IN (
          'createObject',
          'modifyObject',
          'modifyOrCreateObject',
          'deleteObject',
          'createInterfaceObject',
          'modifyInterfaceObject',
          'deleteInterfaceObject',
          'addLink',
          'removeLink',
          'createInterfaceLink',
          'deleteInterfaceLink'
        )
      )
      FROM jsonb_array_elements(rules) AS t(elem)
    )
$$;

COMMENT ON FUNCTION action_rule_discriminator_valid(jsonb) IS
  'Validates the canonical object, interface-object, concrete-link, and interface-link Action Rule discriminators.';

