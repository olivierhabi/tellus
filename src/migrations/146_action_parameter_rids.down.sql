UPDATE action_type
SET parameters = COALESCE(
  (
    SELECT jsonb_agg(
      parameter.value - 'rid'
      ORDER BY parameter.ordinality
    )
    FROM jsonb_array_elements(parameters)
      WITH ORDINALITY AS parameter(value, ordinality)
  ),
  '[]'::jsonb
)
WHERE jsonb_typeof(parameters) = 'array';
