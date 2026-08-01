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
          'addLink',
          'removeLink',
          'createInterfaceLink',
          'deleteInterfaceLink'
        )
      )
      FROM jsonb_array_elements(rules) AS t(elem)
    )
$$;
