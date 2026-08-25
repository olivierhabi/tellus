-- Repair definitions created while rule authoring IDs were not yet unique.
-- Preserve the first occurrence and replace only subsequent duplicates.
UPDATE action_type
SET rules = COALESCE(
  (
    SELECT jsonb_agg(
      CASE
        WHEN rule.rid_ordinal = 1 THEN rule.value
        ELSE rule.value || jsonb_build_object(
          'ruleId',
          'ri.actions.main.rule.' || gen_random_uuid()::text,
          'schemaVersion',
          1
        )
      END
      ORDER BY rule.ordinality
    )
    FROM (
      SELECT
        expanded.value,
        expanded.ordinality,
        row_number() OVER (
          PARTITION BY expanded.value->>'ruleId'
          ORDER BY expanded.ordinality
        ) AS rid_ordinal
      FROM jsonb_array_elements(rules)
        WITH ORDINALITY AS expanded(value, ordinality)
    ) AS rule
  ),
  '[]'::jsonb
)
WHERE jsonb_typeof(rules) = 'array'
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(rules) AS candidate(value)
    WHERE candidate.value->>'ruleId' IS NOT NULL
    GROUP BY candidate.value->>'ruleId'
    HAVING count(*) > 1
  );
