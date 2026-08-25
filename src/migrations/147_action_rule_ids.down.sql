UPDATE action_type
SET rules = COALESCE(
  (
    SELECT jsonb_agg(
      rule.value - 'ruleId' - 'schemaVersion'
      ORDER BY rule.ordinality
    )
    FROM jsonb_array_elements(rules)
      WITH ORDINALITY AS rule(value, ordinality)
  ),
  '[]'::jsonb
)
WHERE jsonb_typeof(rules) = 'array';
