DROP INDEX IF EXISTS idx_automation_condition_evaluation_claim;
CREATE INDEX idx_automation_condition_evaluation_claim
  ON automation_condition_evaluation (scheduled_for, created_at)
  WHERE status = 'pending';

ALTER TABLE automation_condition_evaluation
  DROP CONSTRAINT IF EXISTS automation_condition_evaluation_attempt_count_check,
  DROP CONSTRAINT IF EXISTS automation_condition_evaluation_max_attempts_check,
  DROP COLUMN IF EXISTS next_attempt_at,
  DROP COLUMN IF EXISTS max_attempts,
  DROP COLUMN IF EXISTS attempt_count;
