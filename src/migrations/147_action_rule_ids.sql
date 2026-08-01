-- Give every declarative Action rule a stable authoring RID and an explicit
-- envelope version without changing array order or rule-specific fields.
UPDATE action_type
SET rules = COALESCE(
  (
    SELECT jsonb_agg(
      (
        CASE
          WHEN rule.value ? 'ruleId'
            AND rule.value->>'ruleId' LIKE 'ri.actions.main.rule.%'
            AND rule.rid_ordinal = 1
            THEN rule.value
          ELSE rule.value || jsonb_build_object(
            'ruleId',
            'ri.actions.main.rule.' || gen_random_uuid()::text
          )
        END
      ) || jsonb_build_object('schemaVersion', 1)
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
    FROM jsonb_array_elements(rules) AS rule(value)
    WHERE NOT (rule.value ? 'ruleId')
       OR rule.value->>'ruleId' NOT LIKE 'ri.actions.main.rule.%'
       OR rule.value->>'schemaVersion' IS DISTINCT FROM '1'
       OR (
         SELECT count(*)
         FROM jsonb_array_elements(rules) AS duplicate(candidate)
         WHERE duplicate.candidate->>'ruleId' = rule.value->>'ruleId'
       ) > 1
  );
