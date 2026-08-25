-- Give every action parameter the stable authoring RID shown by Ontology
-- Manager. The public action API continues to address parameters by apiName;
-- this RID identifies the parameter definition itself.
UPDATE action_type
SET parameters = COALESCE(
  (
    SELECT jsonb_agg(
      CASE
        WHEN parameter.value ? 'rid'
          AND parameter.value->>'rid' LIKE 'ri.actions.main.parameter.%'
          THEN parameter.value
        ELSE parameter.value || jsonb_build_object(
          'rid',
          'ri.actions.main.parameter.' || gen_random_uuid()::text
        )
      END
      ORDER BY parameter.ordinality
    )
    FROM jsonb_array_elements(parameters)
      WITH ORDINALITY AS parameter(value, ordinality)
  ),
  '[]'::jsonb
)
WHERE jsonb_typeof(parameters) = 'array'
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(parameters) AS parameter(value)
    WHERE NOT (parameter.value ? 'rid')
       OR parameter.value->>'rid' NOT LIKE 'ri.actions.main.parameter.%'
  );
