-- Durable condition-evaluation retries. Evaluation attempts use the same
-- lease recovery model as effect jobs and never rely on process-local timers.

ALTER TABLE automation_condition_evaluation
  ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_attempts INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'automation_condition_evaluation_attempt_count_check'
  ) THEN
    ALTER TABLE automation_condition_evaluation
      ADD CONSTRAINT automation_condition_evaluation_attempt_count_check
      CHECK (attempt_count >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'automation_condition_evaluation_max_attempts_check'
  ) THEN
    ALTER TABLE automation_condition_evaluation
      ADD CONSTRAINT automation_condition_evaluation_max_attempts_check
      CHECK (max_attempts BETWEEN 1 AND 10);
  END IF;
END
$$;

DROP INDEX IF EXISTS idx_automation_condition_evaluation_claim;
CREATE INDEX idx_automation_condition_evaluation_claim
  ON automation_condition_evaluation (next_attempt_at, scheduled_for, created_at)
  WHERE status = 'pending';
